//! What the policy PDA's signature is allowed to authorize.
//!
//! Under the *delegate* model this module would be close to unnecessary: an
//! SPL delegate can only move tokens, and `SetAuthority`/`CloseAccount` reject
//! a delegate outright, so the worst an unrestricted `invoke_signed` could do
//! was a transfer — which is exactly what the policy check already gates.
//!
//! Under the *owner-PDA custody* model that assumption dies. Once the PDA is
//! the token account's owner, `authorize_and_invoke` forwarding arbitrary
//! bytes to an arbitrary program is a total custody escape, not a transfer
//! path: an agent calls it with `amount = 1` (trivially inside any policy),
//! and `instruction_data = SetAuthority { AccountOwner -> agent }`. The policy
//! check passes, the PDA signs, and the agent now owns the account outright
//! with every limit in this program permanently irrelevant. One lamport of
//! budget buys the whole account.
//!
//! So custody is only safe if the PDA's signature is narrow by construction.
//! This module is that narrowing: an allowlist of (program, instruction) pairs
//! rather than a denylist, because a denylist silently fails open every time
//! Token-2022 adds an instruction, and "fails open" here means "loses the
//! account".
//!
//! Deliberately *not* claimed: this does not verify the amount encoded in a
//! confidential transfer's ciphertext matches the `amount` the policy checked.
//! That gap is documented in docs/PRIVACY_ARCHITECTURE.md §14.3 and is
//! untouched by anything here — this file bounds *what kind of action* the
//! PDA can sign, not *how much* an encrypted one moves.

use anchor_lang::prelude::*;

use crate::{constants::*, error::PolicyError};

/// What a forwarded instruction is permitted to be used for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CpiKind {
    /// Moves tokens out of the account. Must be charged against the policy.
    Spend,
    /// Touches the account's own bookkeeping without moving anything out of
    /// it. Must NOT be charged against the policy — see `custody_maintenance`.
    Maintenance,
}

/// Decide whether this program is willing to sign `data` for `program_id` at
/// all, and if so, whether it counts as spending.
///
/// Rejecting by default is the whole point: an instruction this function does
/// not recognise is refused, not passed through.
pub fn classify_cpi(program_id: &Pubkey, data: &[u8]) -> Result<CpiKind> {
    require!(
        *program_id == SPL_TOKEN_ID || *program_id == TOKEN_2022_ID,
        PolicyError::ForbiddenCpiProgram
    );

    let tag = *data.first().ok_or(PolicyError::ForbiddenCpiInstruction)?;

    match tag {
        token_ix::TRANSFER | token_ix::TRANSFER_CHECKED => Ok(CpiKind::Spend),

        token_ix::CONFIDENTIAL_TRANSFER_EXTENSION => {
            require!(*program_id == TOKEN_2022_ID, PolicyError::ForbiddenCpiProgram);
            let sub_tag = *data.get(1).ok_or(PolicyError::ForbiddenCpiInstruction)?;
            match sub_tag {
                confidential_ix::TRANSFER | confidential_ix::TRANSFER_WITH_FEE => Ok(CpiKind::Spend),
                // Both of these move value only *within* one account, and
                // both are owner-authority instructions — so once the PDA
                // owns the account, nobody can call them unless this program
                // can. Without `ApplyPendingBalance` every confidential
                // payment the agent receives is stuck in pending forever;
                // without `Deposit` the account can never be topped up
                // confidentially again. Custody would create those dead ends
                // itself, so it has to provide the way out. Neither may
                // consume spend budget: nothing leaves the account, and
                // charging incoming funds against an outgoing allowance would
                // be plainly wrong.
                confidential_ix::APPLY_PENDING_BALANCE | confidential_ix::DEPOSIT => {
                    Ok(CpiKind::Maintenance)
                }
                _ => Err(PolicyError::ForbiddenCpiInstruction.into()),
            }
        }

        // Named explicitly so the rejection is obviously deliberate rather
        // than an oversight: these are the instructions that would end
        // custody rather than exercise it.
        token_ix::SET_AUTHORITY => Err(PolicyError::ForbiddenCpiInstruction.into()),

        _ => Err(PolicyError::ForbiddenCpiInstruction.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn confidential(sub_tag: u8) -> Vec<u8> {
        vec![token_ix::CONFIDENTIAL_TRANSFER_EXTENSION, sub_tag]
    }

    #[test]
    fn allows_plain_and_checked_transfers_on_both_token_programs() {
        for program in [SPL_TOKEN_ID, TOKEN_2022_ID] {
            for tag in [token_ix::TRANSFER, token_ix::TRANSFER_CHECKED] {
                assert_eq!(classify_cpi(&program, &[tag, 0, 0]).unwrap(), CpiKind::Spend);
            }
        }
    }

    #[test]
    fn allows_confidential_transfers_and_charges_them_as_spend() {
        for sub_tag in [confidential_ix::TRANSFER, confidential_ix::TRANSFER_WITH_FEE] {
            assert_eq!(
                classify_cpi(&TOKEN_2022_ID, &confidential(sub_tag)).unwrap(),
                CpiKind::Spend
            );
        }
    }

    #[test]
    fn treats_within_account_moves_as_maintenance_not_spend() {
        for sub_tag in [
            confidential_ix::APPLY_PENDING_BALANCE,
            confidential_ix::DEPOSIT,
        ] {
            assert_eq!(
                classify_cpi(&TOKEN_2022_ID, &confidential(sub_tag)).unwrap(),
                CpiKind::Maintenance
            );
        }
    }

    /// `Withdraw` also stays inside one account, but it converts a
    /// confidential balance into a public one — an agent must not be able to
    /// strip its owner's privacy on its own.
    #[test]
    fn refuses_confidential_withdraw_even_though_nothing_leaves_the_account() {
        assert!(classify_cpi(&TOKEN_2022_ID, &confidential(6)).is_err());
    }

    /// The attack this whole module exists to stop.
    #[test]
    fn refuses_set_authority_which_would_hand_the_account_away() {
        let mut data = vec![token_ix::SET_AUTHORITY, AUTHORITY_TYPE_ACCOUNT_OWNER, 1];
        data.extend_from_slice(&[7u8; 32]);
        for program in [SPL_TOKEN_ID, TOKEN_2022_ID] {
            assert!(classify_cpi(&program, &data).is_err());
        }
    }

    #[test]
    fn refuses_every_other_token_instruction_including_ones_added_later() {
        for tag in 0u8..=255 {
            if matches!(tag, token_ix::TRANSFER | token_ix::TRANSFER_CHECKED) {
                continue;
            }
            if tag == token_ix::CONFIDENTIAL_TRANSFER_EXTENSION {
                continue;
            }
            assert!(
                classify_cpi(&SPL_TOKEN_ID, &[tag, 0, 0]).is_err(),
                "tag {tag} should not be forwardable"
            );
        }
    }

    #[test]
    fn refuses_unknown_confidential_sub_instructions() {
        for sub_tag in 0u8..=255 {
            if matches!(
                sub_tag,
                confidential_ix::TRANSFER
                    | confidential_ix::TRANSFER_WITH_FEE
                    | confidential_ix::APPLY_PENDING_BALANCE
                    | confidential_ix::DEPOSIT
            ) {
                continue;
            }
            assert!(classify_cpi(&TOKEN_2022_ID, &confidential(sub_tag)).is_err());
        }
    }

    #[test]
    fn refuses_any_program_that_is_not_a_token_program() {
        let system = anchor_lang::solana_program::system_program::ID;
        assert!(classify_cpi(&system, &[token_ix::TRANSFER, 0]).is_err());
        assert!(classify_cpi(&crate::id(), &[token_ix::TRANSFER, 0]).is_err());
    }

    /// Classic SPL Token has no tag 27, so accepting it there would mean
    /// forwarding something whose meaning we have not actually checked.
    #[test]
    fn refuses_the_confidential_extension_tag_on_classic_spl_token() {
        assert!(classify_cpi(&SPL_TOKEN_ID, &confidential(confidential_ix::TRANSFER)).is_err());
    }

    #[test]
    fn refuses_truncated_instruction_data() {
        assert!(classify_cpi(&SPL_TOKEN_ID, &[]).is_err());
        assert!(classify_cpi(
            &TOKEN_2022_ID,
            &[token_ix::CONFIDENTIAL_TRANSFER_EXTENSION]
        )
        .is_err());
    }
}
