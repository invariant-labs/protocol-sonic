use crate::decimals::*;
use crate::math::*;
use crate::structs::*;
use crate::util::*;
use crate::ErrorCode::{self, *};
use anchor_lang::prelude::*;
use anchor_spl::token::{self, TokenAccount, Transfer};
use invariant::structs::Position;

#[derive(Accounts)]
#[instruction(index: u32, nonce: u8)]
pub struct Withdraw<'info> {
    #[account(mut,
        seeds = [b"staker", incentive.key().as_ref(), position.load()?.pool.as_ref(), &position.load()?.id.to_le_bytes()],
        bump = user_stake.load()?.bump,
    )]
    pub user_stake: AccountLoader<'info, UserStake>,
    #[account(mut,
        constraint = user_stake.load()?.incentive == incentive.key() @ InvalidIncentive
    )]
    pub incentive: AccountLoader<'info, Incentive>,
    #[account(mut,
        constraint = incentive_token_account.owner == staker_authority.key() @ InvalidTokenAccount
    )]
    pub incentive_token_account: Account<'info, TokenAccount>,
    #[account(
        seeds = [b"positionv1",
        owner.key.as_ref(),
        &index.to_le_bytes(),],
        bump = position.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub position: AccountLoader<'info, Position>,
    #[account(mut,
        constraint = owner_token_account.key() != incentive_token_account.key() @ InvalidTokenAccount,
        constraint = owner_token_account.owner == position.load()?.owner @ InvalidOwner
    )]
    pub owner_token_account: Account<'info, TokenAccount>,
    #[account(seeds = [b"staker".as_ref()], bump = nonce)]
    /// CHECK: ignore
    pub staker_authority: AccountInfo<'info>,
    #[account(mut)]
    /// CHECK: ignore
    pub owner: AccountInfo<'info>,
    #[account(address = token::ID)]
    /// CHECK: ignore
    pub token_program: AccountInfo<'info>,
}

impl<'info> Withdraw<'info> {
    fn withdraw(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.incentive_token_account.to_account_info(),
                to: self.owner_token_account.to_account_info(),
                authority: self.staker_authority.to_account_info().clone(),
            },
        )
    }
}

pub fn handler(ctx: Context<Withdraw>, _index: i32, nonce: u8) -> Result<()> {
    msg!("WITHDRAW");

    let mut incentive = ctx.accounts.incentive.load_mut()?;
    {
        let user_stake = &mut ctx.accounts.user_stake.load_mut()?;
        let position = ctx.accounts.position.load()?;

        let update_slot = position.last_slot;
        let slot = get_current_slot();

        require!(slot == update_slot, ErrorCode::SlotsAreNotEqual);
        require!(user_stake.liquidity.v != 0, ErrorCode::ZeroSecondsStaked);

        let seconds_per_liquidity_inside =
            SecondsPerLiquidity::new(position.seconds_per_liquidity_inside.v);

        let reward_unclaimed = incentive.total_reward_unclaimed;

        require!(
            reward_unclaimed != TokenAmount::new(0),
            ErrorCode::ZeroAmount
        );

        let (seconds_inside, reward) = calculate_reward(
            reward_unclaimed,
            incentive.total_seconds_claimed,
            incentive.start_time,
            incentive.end_time,
            user_stake.liquidity,
            user_stake.seconds_per_liquidity_initial,
            seconds_per_liquidity_inside,
            Seconds::now(),
        )
        .unwrap();

        incentive.total_seconds_claimed = incentive.total_seconds_claimed + seconds_inside;
        incentive.total_reward_unclaimed = reward_unclaimed - reward;
        user_stake.seconds_per_liquidity_initial = seconds_per_liquidity_inside;

        let seeds = &[STAKER_SEED.as_bytes(), &[nonce]];
        let signer = &[&seeds[..]];

        let cpi_ctx = ctx.accounts.withdraw().with_signer(signer);

        if !reward.is_zero() {
            token::transfer(cpi_ctx, reward.get())?;
        }
    }

    if Seconds::now() > { incentive.end_time } {
        require!(incentive.num_of_stakes > 0, ErrorCode::NoStakes);
        close(
            ctx.accounts.user_stake.to_account_info(),
            ctx.accounts.owner.to_account_info(),
        )
        .unwrap();

        incentive.num_of_stakes -= 1;
    }

    Ok(())
}
