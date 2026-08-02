//! Proves the actual delegate-binding mechanism: the policy PDA is the SPL
//! Token delegate authority, and only `authorize_and_invoke` can produce a
//! valid signature for it (via `invoke_signed`). Uses classic SPL Token
//! (bundled by litesvm out of the box) rather than Token-2022 confidential
//! transfer, which needs the ZK ElGamal Proof program's proof-context
//! accounts as well - the CPI-signing mechanism proven here is identical
//! either way; only the target instruction's account list changes. See
//! docs/PRIVACY_ARCHITECTURE.md section 14 for what this does and does not
//! prove (structural bypass: closed here; confidential-amount-claim
//! binding: still open, and orthogonal to this mechanism).
//!
//! SPL Token's classic instruction/account byte layout is hand-encoded here
//! rather than pulled in via the `spl-token` crate: every version of that
//! crate available at the time this was written depends on either an older
//! or newer generation of `Pubkey`/`Instruction` types than anchor-lang
//! 1.1.2 uses, and no version straddled both. The layout itself has been
//! stable and unchanged for the program's entire history, so hand-encoding
//! it is no less reliable than a dependency that doesn't compile - and it's
//! the same approach `program/src/lib.rs` already takes for its own account
//! layout.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_instruction,
        },
        InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const MAX_PER_TRANSFER: u64 = 20_000_000;
const MAX_PER_PERIOD: u64 = 50_000_000;
const PERIOD_SECONDS: i64 = 86_400;
// Deliberately larger than the policy limits: proves the policy is the
// binding constraint, not just whatever the raw SPL delegate approval allows.
const SPL_DELEGATE_APPROVAL: u64 = 100_000_000;

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

fn spl_token_id() -> Pubkey {
    // The SPL Token program's address has been unchanged since launch.
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse().unwrap()
}

fn rent_sysvar_id() -> Pubkey {
    "SysvarRent111111111111111111111111111111111".parse().unwrap()
}

fn spl_initialize_mint_ix(mint: Pubkey, mint_authority: Pubkey, decimals: u8) -> Instruction {
    let mut data = Vec::with_capacity(35);
    data.push(0); // InitializeMint
    data.push(decimals);
    data.extend_from_slice(mint_authority.as_ref());
    data.push(0); // freeze_authority: COption::None
    Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(mint, false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data,
    }
}

fn spl_initialize_account_ix(account: Pubkey, mint: Pubkey, owner: Pubkey) -> Instruction {
    Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(account, false),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new_readonly(owner, false),
            AccountMeta::new_readonly(rent_sysvar_id(), false),
        ],
        data: vec![1], // InitializeAccount
    }
}

fn spl_mint_to_ix(mint: Pubkey, account: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    let mut data = vec![7]; // MintTo
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(mint, false),
            AccountMeta::new(account, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data,
    }
}

fn spl_approve_ix(source: Pubkey, delegate: Pubkey, owner: Pubkey, amount: u64) -> Instruction {
    let mut data = vec![4]; // Approve
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(delegate, false),
            AccountMeta::new_readonly(owner, true),
        ],
        data,
    }
}

/// The account list a `Transfer` instruction expects — used both to send a
/// direct transfer (not needed here) and as the template `remaining_accounts`
/// forwarded through `authorize_and_invoke`.
fn spl_transfer_accounts(source: Pubkey, destination: Pubkey, authority: Pubkey) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new(source, false),
        AccountMeta::new(destination, false),
        AccountMeta::new_readonly(authority, false),
    ]
}

fn spl_transfer_data(amount: u64) -> Vec<u8> {
    let mut data = vec![3]; // Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

/// Reads just the fields this test needs from a packed SPL Token `Account`:
/// mint(32) + owner(32) + amount(8) at a fixed offset — the same layout
/// every SPL Token account has had since launch.
fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn token_is_initialized(data: &[u8]) -> bool {
    // state byte is at offset 108 (mint 32 + owner 32 + amount 8 + delegate 36).
    data.len() >= TOKEN_ACCOUNT_LEN && data[108] != 0
}

struct Fixture {
    svm: LiteSVM,
    #[allow(dead_code)]
    owner: Keypair,
    agent: Keypair,
    policy: Pubkey,
    #[allow(dead_code)]
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
}

fn setup() -> Fixture {
    let program_id = agacy_policy_v2::id();
    let owner = Keypair::new();
    let agent = Keypair::new();
    let policy = Pubkey::find_program_address(
        &[
            agacy_policy_v2::constants::POLICY_SEED,
            owner.pubkey().as_ref(),
            agent.pubkey().as_ref(),
        ],
        &program_id,
    )
    .0;

    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/agacy_policy_v2.so"
    ));
    svm.add_program(program_id, bytes).unwrap();
    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 10_000_000_000).unwrap();

    let init_ix = Instruction::new_with_bytes(
        program_id,
        &agacy_policy_v2::instruction::Initialize {
            agent: agent.pubkey(),
            max_per_transfer: MAX_PER_TRANSFER,
            max_per_period: MAX_PER_PERIOD,
            period_seconds: PERIOD_SECONDS,
        }
        .data(),
        agacy_policy_v2::accounts::Initialize {
            policy,
            owner: owner.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &[init_ix], &owner, &[&owner]);

    let mint = Keypair::new();
    let mint_rent = svm.minimum_balance_for_rent_exemption(MINT_LEN);
    let create_mint = system_instruction::create_account(
        &owner.pubkey(),
        &mint.pubkey(),
        mint_rent,
        MINT_LEN as u64,
        &spl_token_id(),
    );
    let init_mint = spl_initialize_mint_ix(mint.pubkey(), owner.pubkey(), 6);
    send(&mut svm, &[create_mint, init_mint], &owner, &[&owner, &mint]);

    let source = Keypair::new();
    let account_rent = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN);
    let create_source = system_instruction::create_account(
        &owner.pubkey(),
        &source.pubkey(),
        account_rent,
        TOKEN_ACCOUNT_LEN as u64,
        &spl_token_id(),
    );
    let init_source = spl_initialize_account_ix(source.pubkey(), mint.pubkey(), owner.pubkey());
    send(&mut svm, &[create_source, init_source], &owner, &[&owner, &source]);

    let destination = Keypair::new();
    let create_destination = system_instruction::create_account(
        &owner.pubkey(),
        &destination.pubkey(),
        account_rent,
        TOKEN_ACCOUNT_LEN as u64,
        &spl_token_id(),
    );
    let init_destination =
        spl_initialize_account_ix(destination.pubkey(), mint.pubkey(), owner.pubkey());
    send(
        &mut svm,
        &[create_destination, init_destination],
        &owner,
        &[&owner, &destination],
    );

    // Sanity check on the hand-rolled layout before relying on it for the
    // actual test assertions below.
    let source_account = svm.get_account(&source.pubkey()).unwrap();
    assert!(
        token_is_initialized(&source_account.data),
        "hand-rolled InitializeAccount did not produce a valid SPL Token account"
    );

    let mint_to = spl_mint_to_ix(mint.pubkey(), source.pubkey(), owner.pubkey(), 200_000_000);
    send(&mut svm, &[mint_to], &owner, &[&owner]);

    // The owner approves the policy PDA - not the agent - as the SPL
    // delegate. The agent never holds spending authority over this account
    // at all; it can only ever move funds by getting this program's policy
    // check to pass.
    let approve = spl_approve_ix(source.pubkey(), policy, owner.pubkey(), SPL_DELEGATE_APPROVAL);
    send(&mut svm, &[approve], &owner, &[&owner]);

    Fixture {
        svm,
        owner,
        agent,
        policy,
        mint: mint.pubkey(),
        source: source.pubkey(),
        destination: destination.pubkey(),
    }
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).unwrap();
}

fn token_balance(svm: &LiteSVM, token_account: &Pubkey) -> u64 {
    let account = svm.get_account(token_account).unwrap();
    token_amount(&account.data)
}

/// Attempts a policy-gated CPI transfer of `amount` from source to
/// destination, signed by the agent, forwarded through the policy PDA's
/// delegate authority.
fn authorize_and_invoke_transfer(fx: &mut Fixture, amount: u64) -> Result<(), ()> {
    fx.svm.expire_blockhash();

    let mut accounts = agacy_policy_v2::accounts::AuthorizeAndInvoke {
        policy: fx.policy,
        agent: fx.agent.pubkey(),
        target_program: spl_token_id(),
    }
    .to_account_metas(None);
    accounts.extend(
        spl_transfer_accounts(fx.source, fx.destination, fx.policy)
            .into_iter()
            .map(|meta| AccountMeta { is_signer: false, ..meta }),
    );

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::AuthorizeAndInvoke {
            amount,
            instruction_data: spl_transfer_data(amount),
        }
        .data(),
        accounts,
    );

    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&fx.agent.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fx.agent]).unwrap();
    fx.svm.send_transaction(tx).map(|_| ()).map_err(|_| ())
}

#[test]
fn moves_real_spl_tokens_through_the_policy_pdas_delegate_authority() {
    let mut fx = setup();
    let before = token_balance(&fx.svm, &fx.destination);

    assert!(authorize_and_invoke_transfer(&mut fx, 5_000_000).is_ok());

    let after = token_balance(&fx.svm, &fx.destination);
    assert_eq!(after - before, 5_000_000, "the CPI'd transfer must actually move real tokens");
}

#[test]
fn refuses_to_forward_a_transfer_above_the_policy_limit_even_though_the_spl_delegate_would_allow_it() {
    let mut fx = setup();
    let before = token_balance(&fx.svm, &fx.destination);

    assert!(authorize_and_invoke_transfer(&mut fx, MAX_PER_TRANSFER + 1).is_err());

    let after = token_balance(&fx.svm, &fx.destination);
    assert_eq!(before, after, "a policy-rejected CPI must not move any tokens");
}

#[test]
fn accumulates_spend_against_the_same_period_across_multiple_cpi_transfers() {
    let mut fx = setup();
    assert!(authorize_and_invoke_transfer(&mut fx, 20_000_000).is_ok());
    assert!(authorize_and_invoke_transfer(&mut fx, 20_000_000).is_ok());
    assert!(authorize_and_invoke_transfer(&mut fx, 20_000_000).is_err());
}
