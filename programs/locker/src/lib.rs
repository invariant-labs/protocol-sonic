use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod structs;
pub mod types;

pub use errors::ErrorCode;
pub use instructions::*;
pub use types::*;

declare_id!("34CS5UnQfoNmJ2MUgBc2VuM3BYFv7oYJTbEsbKrp3Zia");

#[program]
pub mod locker {

    use super::*;

    pub fn initialize_user_locks(ctx: Context<InitializeUserLocks>) -> Result<()> {
        ctx.accounts.process(ctx.bumps.locks)
    }

    pub fn lock_position(ctx: Context<LockPosition>, index: u32, lock_duration: u64) -> Result<()> {
        ctx.accounts.process(lock_duration, index)
    }

    pub fn unlock_position(ctx: Context<UnlockPosition>, index: u32) -> Result<()> {
        ctx.accounts.process(index)
    }

    pub fn claim_fee(
        ctx: Context<ClaimFee>,
        index: u32,
        lower_tick_index: i32,
        upper_tick_index: i32,
    ) -> Result<()> {
        ctx.accounts
            .process(index, lower_tick_index, upper_tick_index)
    }
}
