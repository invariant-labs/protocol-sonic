use crate::decimals::*;
use crate::structs::*;
use crate::util::get_current_slot;
use crate::ErrorCode::{self, *};

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use invariant::program::Invariant;
use invariant::structs::Position;

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct CreateUserStake<'info> {
    #[account(init,
        seeds = [b"staker", incentive.key().as_ref(), position.load()?.pool.as_ref(), &position.load()?.id.to_le_bytes() ],
        payer = signer,
        bump, space = UserStake::LEN)]
    pub user_stake: AccountLoader<'info, UserStake>,
    #[account(
        seeds = [b"positionv1",
        owner.key.as_ref(),
        &index.to_le_bytes(),],
        bump = position.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub position: AccountLoader<'info, Position>,
    #[account(mut,
        constraint = incentive.load()?.pool == position.load()?.pool @ DifferentIncentivePool
    )]
    pub incentive: AccountLoader<'info, Incentive>,
    /// CHECK: ignore
    pub owner: AccountInfo<'info>,
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(address = invariant::ID)]
    pub invariant: Program<'info, Invariant>,
    #[account(address = system_program::ID)]
    /// CHECK: ignore
    pub system_program: AccountInfo<'info>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateUserStake>) -> Result<()> {
    msg!("STAKE");
    let mut incentive = ctx.accounts.incentive.load_mut()?;
    require!(
        Seconds::now() >= { incentive.start_time },
        ErrorCode::NotStarted
    );
    require!(Seconds::now() < { incentive.end_time }, ErrorCode::Ended);
    require!(incentive.num_of_stakes < u64::MAX, ErrorCode::NoStakes);

    let user_stake = &mut ctx.accounts.user_stake.load_init()?;
    let position = ctx.accounts.position.load()?;
    let update_slot = position.last_slot;
    let slot = get_current_slot();
    require!(slot == update_slot, ErrorCode::SlotsAreNotEqual);

    **user_stake = UserStake {
        position: ctx.accounts.position.key(),
        liquidity: Liquidity::new({ position.liquidity }.get()),
        incentive: ctx.accounts.incentive.key(),
        bump: ctx.bumps.user_stake,
        seconds_per_liquidity_initial: SecondsPerLiquidity::from_decimal(
            position.seconds_per_liquidity_inside,
        ),
    };
    incentive.num_of_stakes += 1;
    let liquidity = user_stake.liquidity;
    require!(!liquidity.is_zero(), ErrorCode::ZeroLiquidity);
    Ok(())
}
