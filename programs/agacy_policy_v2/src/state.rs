use anchor_lang::prelude::*;

/// Same fields and the same policy math as the deployed native program
/// (`program/src/lib.rs`), reimplemented as a PDA so this program can sign
/// for the account itself. Field order/meaning is unchanged so the two can be
/// compared directly by anyone auditing the migration.
#[account]
#[derive(InitSpace)]
pub struct Policy {
    pub owner: Pubkey,
    pub agent: Pubkey,
    pub max_per_transfer: u64,
    pub max_per_period: u64,
    pub period_seconds: i64,
    pub spent_in_period: u64,
    pub period_start: i64,
    pub bump: u8,
}
