//! Owner-PDA custody: the policy PDA becomes the token account's actual
//! owner, not merely its delegate.
//!
//! This is the arrangement Token-2022 confidential transfer requires — it
//! ignores delegate fields entirely (`OwnerMismatch` against a real devnet
//! account with `delegatedAmount = u64::MAX`, see
//! `scripts/verify-confidential-delegate-devnet.ts`). It is also the point at
//! which the owner's unilateral escape route disappears, so the tests below
//! are weighted accordingly: roughly half of them are about getting *out*, or
//! about an agent trying to make custody permanent in its own favour.
//!
//! Classic SPL Token is used here for the same reason `delegate_cpi.rs` uses
//! it: litesvm bundles it, and the custody mechanism — who the account's
//! `owner` field points at, and who can produce that signature — is identical
//! under Token-2022. Only the instruction that eventually spends differs, and
//! that difference is exercised for real against devnet rather than here.
//!
//! SPL Token's byte layout is hand-encoded for the reason documented at the
//! top of `delegate_cpi.rs`: no published `spl-token` release depends on the
//! same generation of `Pubkey`/`Instruction` types as anchor-lang 1.1.2.

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
const STARTING_BALANCE: u64 = 200_000_000;

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

fn spl_token_id() -> Pubkey {
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

fn spl_transfer_data(amount: u64) -> Vec<u8> {
    let mut data = vec![3]; // Transfer
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

/// `SetAuthority { AccountOwner, Some(new_authority) }` — the payload an
/// agent would forward to take the account for itself, and the reason
/// `custody_guard.rs` exists.
fn spl_set_account_owner_data(new_authority: Pubkey) -> Vec<u8> {
    let mut data = vec![6, 2, 1]; // SetAuthority | AuthorityType::AccountOwner | COption::Some
    data.extend_from_slice(new_authority.as_ref());
    data
}

fn spl_close_account_data() -> Vec<u8> {
    vec![9] // CloseAccount
}

fn spl_transfer_ix(source: Pubkey, destination: Pubkey, authority: Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new(destination, false),
            AccountMeta::new_readonly(authority, true),
        ],
        data: spl_transfer_data(amount),
    }
}

fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

/// SPL Token `Account` layout: mint(32) | owner(32) | amount(8) | ...
fn token_owner(data: &[u8]) -> Pubkey {
    Pubkey::new_from_array(data[32..64].try_into().unwrap())
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    policy: Pubkey,
    #[allow(dead_code)]
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    /// A second account the owner keeps for themselves — never custodied.
    /// Used to prove a custodied policy cannot be pointed at other accounts.
    outsider: Pubkey,
}

fn create_token_account(svm: &mut LiteSVM, payer: &Keypair, mint: Pubkey, owner: Pubkey) -> Pubkey {
    let account = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_LEN);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &account.pubkey(),
        rent,
        TOKEN_ACCOUNT_LEN as u64,
        &spl_token_id(),
    );
    let init = spl_initialize_account_ix(account.pubkey(), mint, owner);
    send(svm, &[create, init], payer, &[payer, &account]);
    account.pubkey()
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

    let source = create_token_account(&mut svm, &owner, mint.pubkey(), owner.pubkey());
    let destination = create_token_account(&mut svm, &owner, mint.pubkey(), owner.pubkey());
    let outsider = create_token_account(&mut svm, &owner, mint.pubkey(), owner.pubkey());

    let mint_to = spl_mint_to_ix(
        mint.pubkey(),
        source.into(),
        owner.pubkey(),
        STARTING_BALANCE,
    );
    let mint_outsider = spl_mint_to_ix(mint.pubkey(), outsider, owner.pubkey(), STARTING_BALANCE);
    send(&mut svm, &[mint_to, mint_outsider], &owner, &[&owner]);

    Fixture {
        svm,
        owner,
        agent,
        policy,
        mint: mint.pubkey(),
        source,
        destination,
        outsider,
    }
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) {
    try_send(svm, ixs, payer, signers).expect("transaction was expected to succeed");
}

fn try_send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    signers: &[&Keypair],
) -> Result<(), ()> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|_| ())
}

fn token_account_data(svm: &LiteSVM, account: &Pubkey) -> Vec<u8> {
    svm.get_account(account).unwrap().data
}

fn balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    token_amount(&token_account_data(svm, account))
}

fn owner_of(svm: &LiteSVM, account: &Pubkey) -> Pubkey {
    token_owner(&token_account_data(svm, account))
}

fn assume_custody(fx: &mut Fixture, token_account: Pubkey) -> Result<(), ()> {
    let (policy, owner) = (fx.policy, fx.owner.insecure_clone());
    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::AssumeCustody {}.data(),
        agacy_policy_v2::accounts::AssumeCustody {
            policy,
            owner: owner.pubkey(),
            token_account,
            token_program: spl_token_id(),
        }
        .to_account_metas(None),
    );
    try_send(&mut fx.svm, &[ix], &owner, &[&owner])
}

/// `signer` is passed separately from the `owner` account the instruction
/// names, because the interesting failure case is exactly when they differ.
fn release_custody(
    fx: &mut Fixture,
    token_account: Pubkey,
    new_authority: Pubkey,
    signer: Keypair,
    claimed_owner: Pubkey,
) -> Result<(), ()> {
    let policy = fx.policy;
    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::ReleaseCustody { new_authority }.data(),
        agacy_policy_v2::accounts::ReleaseCustody {
            policy,
            owner: claimed_owner,
            token_account,
            token_program: spl_token_id(),
        }
        .to_account_metas(None),
    );
    try_send(&mut fx.svm, &[ix], &signer, &[&signer])
}

/// Owner releases custody back to themselves — the ordinary recovery path.
fn owner_releases(fx: &mut Fixture, token_account: Pubkey, to: Pubkey) -> Result<(), ()> {
    let owner = fx.owner.insecure_clone();
    let owner_key = owner.pubkey();
    release_custody(fx, token_account, to, owner, owner_key)
}

/// Forwards arbitrary `instruction_data` through `authorize_and_invoke` with
/// a transfer-shaped account list. The whole point of several tests below is
/// that the data and the account list can disagree — an attacker controls
/// both — so they are separate parameters.
fn forward(
    fx: &mut Fixture,
    amount: u64,
    source: Pubkey,
    destination: Pubkey,
    instruction_data: Vec<u8>,
) -> Result<(), ()> {
    let mut accounts = agacy_policy_v2::accounts::AuthorizeAndInvoke {
        policy: fx.policy,
        agent: fx.agent.pubkey(),
        target_program: spl_token_id(),
    }
    .to_account_metas(None);
    accounts.extend([
        AccountMeta::new(source, false),
        AccountMeta::new(destination, false),
        AccountMeta::new_readonly(fx.policy, false),
    ]);

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::AuthorizeAndInvoke {
            amount,
            instruction_data,
        }
        .data(),
        accounts,
    );
    let agent = fx.agent.insecure_clone();
    try_send(&mut fx.svm, &[ix], &agent, &[&agent])
}

fn transfer_through_policy(fx: &mut Fixture, amount: u64) -> Result<(), ()> {
    let (source, destination) = (fx.source, fx.destination);
    forward(fx, amount, source, destination, spl_transfer_data(amount))
}

/// Takes custody of the fixture's own source account — the setup nearly every
/// test below starts from.
fn custody_source(fx: &mut Fixture) {
    let source = fx.source;
    assume_custody(fx, source).expect("owner should be able to hand over their own account");
}

// --- custody itself -------------------------------------------------------

#[test]
fn assume_custody_makes_the_policy_pda_the_accounts_real_on_chain_owner() {
    let mut fx = setup();
    let (source, policy, owner_key) = (fx.source, fx.policy, fx.owner.pubkey());
    assert_eq!(owner_of(&fx.svm, &source), owner_key);

    assert!(assume_custody(&mut fx, source).is_ok());

    assert_eq!(
        owner_of(&fx.svm, &source),
        policy,
        "custody must change the token account's actual owner field, not just a flag in our own state"
    );
}

#[test]
fn a_custodied_account_still_spends_normally_within_policy() {
    let mut fx = setup();
    custody_source(&mut fx);
    let destination = fx.destination;
    let before = balance(&fx.svm, &destination);

    assert!(transfer_through_policy(&mut fx, 5_000_000).is_ok());

    assert_eq!(balance(&fx.svm, &destination) - before, 5_000_000);
}

#[test]
fn a_custodied_account_is_still_bound_by_the_period_limit() {
    let mut fx = setup();
    custody_source(&mut fx);

    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(
        transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_err(),
        "custody must not weaken the spend limit it exists to enforce"
    );
}

#[test]
fn custody_cannot_be_taken_twice() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (outsider, owner_key) = (fx.outsider, fx.owner.pubkey());

    assert!(
        assume_custody(&mut fx, outsider).is_err(),
        "a second account would overwrite the record of the first, orphaning it"
    );
    assert_eq!(owner_of(&fx.svm, &outsider), owner_key);
}

// --- the attacks custody makes possible -----------------------------------

/// The single most important test in this file. Before `custody_guard.rs`,
/// this transaction succeeded: one unit of spend budget buys `SetAuthority`,
/// and the agent owns the account outright with every limit in this program
/// permanently irrelevant.
#[test]
fn an_agent_cannot_spend_one_token_of_budget_to_steal_the_whole_account() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, destination, policy, agent_key) =
        (fx.source, fx.destination, fx.policy, fx.agent.pubkey());

    let theft = forward(
        &mut fx,
        1,
        source,
        destination,
        spl_set_account_owner_data(agent_key),
    );

    assert!(theft.is_err(), "SetAuthority must never be forwardable");
    assert_eq!(
        owner_of(&fx.svm, &source),
        policy,
        "the account must still answer to the policy, not the agent"
    );
}

#[test]
fn an_agent_cannot_close_the_custodied_account() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, destination) = (fx.source, fx.destination);

    assert!(forward(&mut fx, 1, source, destination, spl_close_account_data()).is_err());
    assert_eq!(balance(&fx.svm, &source), STARTING_BALANCE);
}

/// A policy is scoped to one account. Without this check the PDA's signature
/// would work against *any* account that happens to answer to it, so a second
/// agent's account could be drained through the first agent's budget.
#[test]
fn a_custodied_policy_cannot_be_pointed_at_a_different_account() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (outsider, destination) = (fx.outsider, fx.destination);
    let before = balance(&fx.svm, &outsider);

    let result = forward(
        &mut fx,
        1_000_000,
        outsider,
        destination,
        spl_transfer_data(1_000_000),
    );

    assert!(result.is_err());
    assert_eq!(balance(&fx.svm, &outsider), before);
}

#[test]
fn a_refused_forward_does_not_consume_any_spend_budget() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, destination, agent_key) = (fx.source, fx.destination, fx.agent.pubkey());

    // Would burn most of the period, if the reject path charged for it.
    for _ in 0..3 {
        assert!(forward(
            &mut fx,
            MAX_PER_TRANSFER,
            source,
            destination,
            spl_set_account_owner_data(agent_key),
        )
        .is_err());
    }

    // The full period must still be available afterwards.
    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(transfer_through_policy(&mut fx, 10_000_000).is_ok());
}

// --- the recovery hatch ---------------------------------------------------

#[test]
fn release_custody_gives_the_account_back_and_the_owner_can_use_it_directly() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, destination, owner_key) = (fx.source, fx.destination, fx.owner.pubkey());

    assert!(owner_releases(&mut fx, source, owner_key).is_ok());
    assert_eq!(owner_of(&fx.svm, &source), owner_key);

    // The real test of a recovery hatch is not the state change — it is that
    // the owner can actually move the funds again afterwards, with no
    // involvement from this program at all.
    let before = balance(&fx.svm, &destination);
    let owner = fx.owner.insecure_clone();
    let ix = spl_transfer_ix(source, destination, owner_key, 123_000_000);
    send(&mut fx.svm, &[ix], &owner, &[&owner]);

    assert_eq!(balance(&fx.svm, &destination) - before, 123_000_000);
}

/// A recovery hatch that stops working once things go wrong is not a recovery
/// hatch. The period budget being fully spent is the most ordinary "things
/// went wrong" state there is.
#[test]
fn release_custody_works_with_the_spend_budget_completely_exhausted() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, owner_key) = (fx.source, fx.owner.pubkey());

    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(transfer_through_policy(&mut fx, MAX_PER_TRANSFER).is_ok());
    assert!(transfer_through_policy(&mut fx, 10_000_000).is_ok());
    assert!(transfer_through_policy(&mut fx, 1).is_err(), "period should be exhausted");

    assert!(owner_releases(&mut fx, source, owner_key).is_ok());
    assert_eq!(owner_of(&fx.svm, &source), owner_key);
}

/// The owner may no longer control their original key — that is a plausible
/// reason to need recovery in the first place — so the destination is theirs
/// to choose rather than hardcoded back to `owner`.
#[test]
fn release_custody_can_hand_the_account_to_a_rescue_wallet() {
    let mut fx = setup();
    custody_source(&mut fx);
    let source = fx.source;
    let rescue = Keypair::new();

    assert!(owner_releases(&mut fx, source, rescue.pubkey()).is_ok());

    assert_eq!(owner_of(&fx.svm, &source), rescue.pubkey());
}

#[test]
fn the_agent_cannot_release_custody_to_itself() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, policy) = (fx.source, fx.policy);
    let agent = fx.agent.insecure_clone();
    let agent_key = agent.pubkey();

    assert!(release_custody(&mut fx, source, agent_key, agent, agent_key).is_err());
    assert_eq!(owner_of(&fx.svm, &source), policy);
}

/// Naming the real owner does not help the agent either, but it fails one
/// layer earlier than the test above and it is worth being precise about
/// which layer: the owner is a `Signer`, so a transaction naming them cannot
/// even be *assembled* without their signature. Asserted at construction
/// rather than by sending, because there is no transaction to send.
#[test]
fn the_agent_cannot_even_assemble_a_release_that_names_the_real_owner() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, policy, owner_key) = (fx.source, fx.policy, fx.owner.pubkey());
    let agent = fx.agent.insecure_clone();

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::ReleaseCustody {
            new_authority: agent.pubkey(),
        }
        .data(),
        agacy_policy_v2::accounts::ReleaseCustody {
            policy,
            owner: owner_key,
            token_account: source,
            token_program: spl_token_id(),
        }
        .to_account_metas(None),
    );
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&agent.pubkey()), &blockhash);

    assert!(
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&agent]).is_err(),
        "the owner's signature is missing and cannot be manufactured"
    );
    assert_eq!(owner_of(&fx.svm, &source), policy);
}

/// So the agent's remaining option is to name the owner but mark them as a
/// non-signer, which *is* a sendable transaction. This one is caught by the
/// program: Anchor's `Signer` type rejects the account before the handler
/// runs.
#[test]
fn the_agent_cannot_release_custody_by_marking_the_owner_as_a_non_signer() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, policy, owner_key) = (fx.source, fx.policy, fx.owner.pubkey());
    let agent = fx.agent.insecure_clone();

    let mut accounts = agacy_policy_v2::accounts::ReleaseCustody {
        policy,
        owner: owner_key,
        token_account: source,
        token_program: spl_token_id(),
    }
    .to_account_metas(None);
    for meta in accounts.iter_mut() {
        if meta.pubkey == owner_key {
            meta.is_signer = false;
        }
    }

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::ReleaseCustody {
            new_authority: agent.pubkey(),
        }
        .data(),
        accounts,
    );

    assert!(try_send(&mut fx.svm, &[ix], &agent, &[&agent]).is_err());
    assert_eq!(owner_of(&fx.svm, &source), policy);
}

#[test]
fn releasing_an_account_this_policy_never_custodied_is_refused() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (outsider, owner_key) = (fx.outsider, fx.owner.pubkey());

    assert!(owner_releases(&mut fx, outsider, owner_key).is_err());
}

#[test]
fn custody_can_be_taken_again_after_being_released() {
    let mut fx = setup();
    custody_source(&mut fx);
    let (source, policy, owner_key) = (fx.source, fx.policy, fx.owner.pubkey());
    owner_releases(&mut fx, source, owner_key).unwrap();

    assert!(
        assume_custody(&mut fx, source).is_ok(),
        "release must clear the record, not leave the policy permanently unusable"
    );
    assert_eq!(owner_of(&fx.svm, &source), policy);
}

// --- delegate mode must keep working --------------------------------------

/// Custody is opt-in. The existing delegate arrangement (`delegate_cpi.rs`)
/// has to survive these changes untouched, so this asserts the mint the
/// fixture builds is still spendable without any custody call at all.
#[test]
fn a_policy_that_never_took_custody_is_unaffected_by_any_of_this() {
    let mut fx = setup();
    let (source, destination, policy) = (fx.source, fx.destination, fx.policy);
    let owner = fx.owner.insecure_clone();

    let mut data = vec![4]; // Approve
    data.extend_from_slice(&100_000_000u64.to_le_bytes());
    let approve = Instruction {
        program_id: spl_token_id(),
        accounts: vec![
            AccountMeta::new(source, false),
            AccountMeta::new_readonly(policy, false),
            AccountMeta::new_readonly(owner.pubkey(), true),
        ],
        data,
    };
    send(&mut fx.svm, &[approve], &owner, &[&owner]);

    let before = balance(&fx.svm, &destination);
    assert!(transfer_through_policy(&mut fx, 5_000_000).is_ok());
    assert_eq!(balance(&fx.svm, &destination) - before, 5_000_000);
}
