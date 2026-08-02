//! On-chain spend policy enforcement for Agacy agent wallets.
//!
//! Why this program exists at all: the TypeScript policy check in
//! `server/services/spend-policy.ts` only binds an agent that chooses to route
//! through our server. An agent holding the token account's authority could
//! call Token-2022 directly and ignore it entirely — the same weakness that
//! makes "please don't spend more than $10" in a system prompt security
//! theatre rather than a limit.
//!
//! Here the limit is a property of the account, not a request to the agent.
//! The policy PDA is the token account's delegate, so the agent cannot move
//! funds without this program approving first, and this program answers to the
//! owner's stored limits rather than to whatever the model decided.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::{clock::Clock, Sysvar},
};

entrypoint!(process_instruction);

/// Fixed byte layout of a policy account. Kept explicit rather than derived so
/// the client and program cannot drift apart silently.
///
/// discriminator(1) | owner(32) | agent(32) | max_per_transfer(8)
///   | max_per_period(8) | period_seconds(8) | spent_in_period(8) | period_start(8)
pub const POLICY_ACCOUNT_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8;

const DISCRIMINATOR: u8 = 0xA6;

/// Instruction tags. First byte of instruction data.
const IX_INITIALIZE: u8 = 0;
const IX_AUTHORIZE: u8 = 1;
const IX_UPDATE_LIMITS: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_per_transfer: u64,
    pub max_per_period: u64,
    pub period_seconds: i64,
    pub spent_in_period: u64,
    pub period_start: i64,
}

impl Policy {
    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < POLICY_ACCOUNT_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        if data[0] != DISCRIMINATOR {
            return Err(ProgramError::UninitializedAccount);
        }

        Ok(Policy {
            owner: Pubkey::new_from_array(read_32(data, 1)),
            agent: Pubkey::new_from_array(read_32(data, 33)),
            max_per_transfer: u64::from_le_bytes(read_8(data, 65)),
            max_per_period: u64::from_le_bytes(read_8(data, 73)),
            period_seconds: i64::from_le_bytes(read_8(data, 81)),
            spent_in_period: u64::from_le_bytes(read_8(data, 89)),
            period_start: i64::from_le_bytes(read_8(data, 97)),
        })
    }

    pub fn pack(&self, data: &mut [u8]) -> ProgramResult {
        if data.len() < POLICY_ACCOUNT_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        data[0] = DISCRIMINATOR;
        data[1..33].copy_from_slice(self.owner.as_ref());
        data[33..65].copy_from_slice(self.agent.as_ref());
        data[65..73].copy_from_slice(&self.max_per_transfer.to_le_bytes());
        data[73..81].copy_from_slice(&self.max_per_period.to_le_bytes());
        data[81..89].copy_from_slice(&self.period_seconds.to_le_bytes());
        data[89..97].copy_from_slice(&self.spent_in_period.to_le_bytes());
        data[97..105].copy_from_slice(&self.period_start.to_le_bytes());
        Ok(())
    }

    /// Decide whether `amount` may be spent right now, and return the policy
    /// state that should be written back if it may.
    ///
    /// Rolling the period forward is part of the same decision rather than a
    /// separate maintenance step: if the period has elapsed, the old spend
    /// total is stale and must not be allowed to block a fresh request.
    pub fn authorize(&self, amount: u64, now: i64) -> Result<Policy, PolicyError> {
        if amount == 0 {
            return Err(PolicyError::ZeroAmount);
        }
        if amount > self.max_per_transfer {
            return Err(PolicyError::ExceedsPerTransferLimit);
        }

        let period_elapsed = now.saturating_sub(self.period_start) >= self.period_seconds;
        let (spent, period_start) = if period_elapsed {
            (0, now)
        } else {
            (self.spent_in_period, self.period_start)
        };

        let new_total = spent
            .checked_add(amount)
            .ok_or(PolicyError::ExceedsPeriodLimit)?;
        if new_total > self.max_per_period {
            return Err(PolicyError::ExceedsPeriodLimit);
        }

        Ok(Policy {
            spent_in_period: new_total,
            period_start,
            ..*self
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyError {
    ZeroAmount,
    ExceedsPerTransferLimit,
    ExceedsPeriodLimit,
}

impl From<PolicyError> for ProgramError {
    fn from(error: PolicyError) -> Self {
        ProgramError::Custom(match error {
            PolicyError::ZeroAmount => 1,
            PolicyError::ExceedsPerTransferLimit => 2,
            PolicyError::ExceedsPeriodLimit => 3,
        })
    }
}

pub fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, rest) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    match *tag {
        IX_INITIALIZE => initialize(accounts, rest),
        IX_AUTHORIZE => authorize(accounts, rest),
        IX_UPDATE_LIMITS => update_limits(accounts, rest),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// accounts: [policy (writable), owner (signer)]
/// data: agent(32) | max_per_transfer(8) | max_per_period(8) | period_seconds(8)
fn initialize(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let policy_account = next_account_info(iter)?;
    let owner = next_account_info(iter)?;

    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 56 {
        return Err(ProgramError::InvalidInstructionData);
    }
    if policy_account.data.borrow()[0] == DISCRIMINATOR {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    let policy = Policy {
        owner: *owner.key,
        agent: Pubkey::new_from_array(read_32(data, 0)),
        max_per_transfer: u64::from_le_bytes(read_8(data, 32)),
        max_per_period: u64::from_le_bytes(read_8(data, 40)),
        period_seconds: i64::from_le_bytes(read_8(data, 48)),
        spent_in_period: 0,
        period_start: Clock::get()?.unix_timestamp,
    };

    policy.pack(&mut policy_account.data.borrow_mut())?;
    msg!("Agacy policy initialized");
    Ok(())
}

/// The enforcement point.
///
/// accounts: [policy (writable), agent (signer)]
/// data: amount(8)
fn authorize(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let policy_account = next_account_info(iter)?;
    let agent = next_account_info(iter)?;

    if !agent.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let policy = Policy::unpack(&policy_account.data.borrow())?;

    // The agent bound at initialization is the only one this policy speaks for.
    // Without this, any signer could spend against someone else's budget.
    if policy.agent != *agent.key {
        return Err(ProgramError::IllegalOwner);
    }

    let amount = u64::from_le_bytes(read_8(data, 0));
    let updated = policy.authorize(amount, Clock::get()?.unix_timestamp)?;
    updated.pack(&mut policy_account.data.borrow_mut())?;

    msg!("Authorized {} within policy", amount);
    Ok(())
}

/// accounts: [policy (writable), owner (signer)]
/// data: max_per_transfer(8) | max_per_period(8)
fn update_limits(accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let policy_account = next_account_info(iter)?;
    let owner = next_account_info(iter)?;

    if !owner.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let policy = Policy::unpack(&policy_account.data.borrow())?;
    // Only the owner may loosen or tighten limits — never the agent, which is
    // the whole point of keeping the two identities separate.
    if policy.owner != *owner.key {
        return Err(ProgramError::IllegalOwner);
    }

    let updated = Policy {
        max_per_transfer: u64::from_le_bytes(read_8(data, 0)),
        max_per_period: u64::from_le_bytes(read_8(data, 8)),
        ..policy
    };
    updated.pack(&mut policy_account.data.borrow_mut())?;

    msg!("Agacy policy limits updated");
    Ok(())
}

fn read_32(data: &[u8], offset: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&data[offset..offset + 32]);
    out
}

fn read_8(data: &[u8], offset: usize) -> [u8; 8] {
    let mut out = [0u8; 8];
    out.copy_from_slice(&data[offset..offset + 8]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> Policy {
        Policy {
            owner: Pubkey::new_unique(),
            agent: Pubkey::new_unique(),
            max_per_transfer: 20_000_000,
            max_per_period: 50_000_000,
            period_seconds: 86_400,
            spent_in_period: 0,
            period_start: 1_000,
        }
    }

    #[test]
    fn allows_a_transfer_within_both_limits() {
        let updated = policy().authorize(5_000_000, 1_100).unwrap();
        assert_eq!(updated.spent_in_period, 5_000_000);
    }

    #[test]
    fn allows_a_transfer_exactly_at_the_per_transfer_limit() {
        assert!(policy().authorize(20_000_000, 1_100).is_ok());
    }

    #[test]
    fn rejects_a_transfer_above_the_per_transfer_limit() {
        assert_eq!(
            policy().authorize(20_000_001, 1_100),
            Err(PolicyError::ExceedsPerTransferLimit)
        );
    }

    #[test]
    fn rejects_a_zero_amount() {
        assert_eq!(policy().authorize(0, 1_100), Err(PolicyError::ZeroAmount));
    }

    #[test]
    fn rejects_a_transfer_that_would_breach_the_period_limit() {
        let mut p = policy();
        p.spent_in_period = 45_000_000;
        assert_eq!(
            p.authorize(6_000_000, 1_100),
            Err(PolicyError::ExceedsPeriodLimit)
        );
    }

    #[test]
    fn accumulates_spend_across_transfers_in_the_same_period() {
        let p = policy();
        let after_first = p.authorize(10_000_000, 1_100).unwrap();
        let after_second = after_first.authorize(10_000_000, 1_200).unwrap();
        assert_eq!(after_second.spent_in_period, 20_000_000);
    }

    #[test]
    fn resets_the_budget_once_the_period_has_elapsed() {
        let mut p = policy();
        p.spent_in_period = 50_000_000;
        // Same request is refused inside the period...
        assert!(p.authorize(1_000_000, 1_100).is_err());
        // ...and allowed once the period rolls over.
        let updated = p.authorize(1_000_000, 1_000 + 86_400).unwrap();
        assert_eq!(updated.spent_in_period, 1_000_000);
        assert_eq!(updated.period_start, 1_000 + 86_400);
    }

    #[test]
    fn cannot_overflow_the_period_total() {
        let mut p = policy();
        p.spent_in_period = u64::MAX;
        p.max_per_period = u64::MAX;
        assert_eq!(
            p.authorize(1, 1_100),
            Err(PolicyError::ExceedsPeriodLimit)
        );
    }

    #[test]
    fn round_trips_through_pack_and_unpack() {
        let original = policy();
        let mut buffer = [0u8; POLICY_ACCOUNT_LEN];
        original.pack(&mut buffer).unwrap();
        assert_eq!(Policy::unpack(&buffer).unwrap(), original);
    }

    #[test]
    fn refuses_to_read_an_uninitialized_account() {
        let buffer = [0u8; POLICY_ACCOUNT_LEN];
        assert_eq!(
            Policy::unpack(&buffer).unwrap_err(),
            ProgramError::UninitializedAccount
        );
    }
}
