//! Runs the compiled program against a simulated SVM (litesvm) — this
//! exercises real account creation, PDA derivation, and signer checks, not
//! just the pure arithmetic already covered by program/'s Rust unit tests.
//! Mirrors that native program's test cases so the two can be compared
//! directly.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{instruction::Instruction, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
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
const LIMIT_PUBKEY: [u8; 32] = [7; 32];
const MAX_PER_TRANSFER_CT: [u8; 64] = [8; 64];
const MAX_PER_PERIOD_CT: [u8; 64] = [9; 64];

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    policy: Pubkey,
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
    svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();

    let ix = Instruction::new_with_bytes(
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
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&owner.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&owner]).unwrap();
    svm.send_transaction(tx).unwrap();

    Fixture {
        svm,
        owner,
        agent,
        policy,
    }
}

fn setup_confidential() -> Fixture {
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
    svm.airdrop(&owner.pubkey(), 1_000_000_000).unwrap();

    let ix = Instruction::new_with_bytes(
        program_id,
        &agacy_policy_v2::instruction::InitializeConfidential {
            agent: agent.pubkey(),
            limit_pubkey: LIMIT_PUBKEY,
            max_per_transfer_ct: MAX_PER_TRANSFER_CT,
            max_per_period_ct: MAX_PER_PERIOD_CT,
            period_seconds: PERIOD_SECONDS,
        }
        .data(),
        agacy_policy_v2::accounts::Initialize {
            policy,
            owner: owner.pubkey(),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&owner.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&owner]).unwrap();
    svm.send_transaction(tx).unwrap();

    Fixture {
        svm,
        owner,
        agent,
        policy,
    }
}

fn read_policy(svm: &LiteSVM, policy: &Pubkey) -> agacy_policy_v2::state::Policy {
    let account = svm.get_account(policy).unwrap();
    let mut data: &[u8] = &account.data;
    agacy_policy_v2::state::Policy::try_deserialize(&mut data).unwrap()
}

fn authorize(fx: &mut Fixture, amount: u64) -> Result<(), ()> {
    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::Authorize { amount }.data(),
        agacy_policy_v2::accounts::Authorize {
            policy: fx.policy,
            agent: fx.agent.pubkey(),
        }
        .to_account_metas(None),
    );
    // Two authorize(20_000_000) calls in a row build byte-identical
    // transactions (same accounts, same instruction, same signer) unless the
    // blockhash changes between them — without this, the second is rejected
    // as an already-processed duplicate, which looks like a policy failure
    // but isn't one.
    fx.svm.expire_blockhash();
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&fx.agent.pubkey()), &blockhash);
    let tx =
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fx.agent]).unwrap();
    fx.svm.send_transaction(tx).map(|_| ()).map_err(|_| ())
}

#[test]
fn initializes_with_the_owner_and_agent_recorded() {
    let fx = setup();
    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.owner, fx.owner.pubkey());
    assert_eq!(state.agent, fx.agent.pubkey());
    assert_eq!(state.max_per_transfer, MAX_PER_TRANSFER);
    assert_eq!(state.spent_in_period, 0);
}

#[test]
fn confidential_initialization_never_writes_plaintext_limits() {
    let fx = setup_confidential();
    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.owner, fx.owner.pubkey());
    assert_eq!(state.agent, fx.agent.pubkey());
    assert_eq!(state.max_per_transfer, 0);
    assert_eq!(state.max_per_period, 0);
    assert_eq!(state.spent_in_period, 0);
    assert_eq!(state.limit_pubkey, LIMIT_PUBKEY);
    assert_eq!(state.max_per_transfer_ct, MAX_PER_TRANSFER_CT);
    assert_eq!(state.max_per_period_ct, MAX_PER_PERIOD_CT);
}

#[test]
fn plaintext_updates_cannot_repopulate_a_confidential_policy() {
    let mut fx = setup_confidential();
    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::UpdateLimits {
            max_per_transfer: MAX_PER_TRANSFER,
            max_per_period: MAX_PER_PERIOD,
        }
        .data(),
        agacy_policy_v2::accounts::UpdateLimits {
            policy: fx.policy,
            owner: fx.owner.pubkey(),
        }
        .to_account_metas(None),
    );
    fx.svm.expire_blockhash();
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&fx.owner.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fx.owner]).unwrap();
    assert!(fx.svm.send_transaction(tx).is_err());

    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.max_per_transfer, 0);
    assert_eq!(state.max_per_period, 0);
}

#[test]
fn allows_a_transfer_within_both_limits() {
    let mut fx = setup();
    assert!(authorize(&mut fx, 5_000_000).is_ok());
    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.spent_in_period, 5_000_000);
}

#[test]
fn rejects_a_transfer_above_the_per_transfer_limit() {
    let mut fx = setup();
    assert!(authorize(&mut fx, MAX_PER_TRANSFER + 1).is_err());
    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.spent_in_period, 0, "a rejected authorize must not move the total");
}

#[test]
fn rejects_a_transfer_that_would_breach_the_period_limit() {
    let mut fx = setup();
    assert!(authorize(&mut fx, 20_000_000).is_ok());
    assert!(authorize(&mut fx, 20_000_000).is_ok());
    // 40M spent so far; one more 20M would hit 60M, over the 50M period cap.
    assert!(authorize(&mut fx, 20_000_000).is_err());
}

#[test]
fn refuses_a_zero_amount() {
    let mut fx = setup();
    assert!(authorize(&mut fx, 0).is_err());
}

#[test]
fn refuses_a_signer_that_is_not_the_bound_agent() {
    let mut fx = setup();
    let impostor = Keypair::new();
    fx.svm.airdrop(&impostor.pubkey(), 1_000_000_000).unwrap();

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::Authorize { amount: 1_000_000 }.data(),
        agacy_policy_v2::accounts::Authorize {
            policy: fx.policy,
            agent: impostor.pubkey(),
        }
        .to_account_metas(None),
    );
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&impostor.pubkey()), &blockhash);
    let tx =
        VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&impostor]).unwrap();
    assert!(fx.svm.send_transaction(tx).is_err());
}

#[test]
fn only_the_owner_can_update_limits() {
    let mut fx = setup();

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::UpdateLimits {
            max_per_transfer: 1,
            max_per_period: 1,
        }
        .data(),
        agacy_policy_v2::accounts::UpdateLimits {
            policy: fx.policy,
            owner: fx.agent.pubkey(),
        }
        .to_account_metas(None),
    );
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&fx.agent.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fx.agent]).unwrap();
    assert!(
        fx.svm.send_transaction(tx).is_err(),
        "the agent must not be able to raise its own ceiling"
    );

    let ix = Instruction::new_with_bytes(
        agacy_policy_v2::id(),
        &agacy_policy_v2::instruction::UpdateLimits {
            max_per_transfer: 9_000_000,
            max_per_period: 9_000_000,
        }
        .data(),
        agacy_policy_v2::accounts::UpdateLimits {
            policy: fx.policy,
            owner: fx.owner.pubkey(),
        }
        .to_account_metas(None),
    );
    let blockhash = fx.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&fx.owner.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&fx.owner]).unwrap();
    fx.svm.send_transaction(tx).unwrap();

    let state = read_policy(&fx.svm, &fx.policy);
    assert_eq!(state.max_per_transfer, 9_000_000);
}
