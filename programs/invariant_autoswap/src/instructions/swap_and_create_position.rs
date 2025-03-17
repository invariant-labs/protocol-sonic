use crate::math::{get_max_liquidity, LiquidityResult};
use crate::ErrorCode::{self, *};
use crate::*;
use anchor_spl::{token, token_2022};
use invariant::decimals::*;
use invariant::program::Invariant;
use invariant::structs::pool::Pool;
use invariant::structs::position::Position;
use invariant::structs::position_list::PositionList;
use invariant::structs::tick::Tick;
use invariant::structs::Tickmap;

use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use invariant::structs::*;

const SWAP_POOLS: [&'static str; 5] = [
    "2KwaYnbHKtt1Z3BqxNbRzthNzggCXX1tYS89drhQfLXD", // Pool address used in tests
    "2QC7osoRf9FU55hyjBXrsCK3em5wHREGm53t264RQrpc", // Pool address used in tests
    "B4XuhBqztnfMHeDVLDwnqPuGDMTrWRzUMzAHSkBJUQg3", // Pool address used in tests
    "7JuNzpcJBrpXWvETstYEYHcMBMc5eZeMeCxkHzsxmCNZ", // Pool address used in tests
    "H4QcXPqL88TUhgD2U5CgJRQEn1qMcBbxRkdczTPxP71f", // testnet ETH/USDC 0.09%
];

const POSITION_POOLS: [&'static str; 11] = [
    "2KwaYnbHKtt1Z3BqxNbRzthNzggCXX1tYS89drhQfLXD", // Pool address used in tests
    "2QC7osoRf9FU55hyjBXrsCK3em5wHREGm53t264RQrpc", // Pool address used in tests
    "6efW2pggVhkWqFR6qp6ReTUWFuKQezfdpadM4gXScH6w", // Pool address used in tests
    "B4XuhBqztnfMHeDVLDwnqPuGDMTrWRzUMzAHSkBJUQg3", // Pool address used in tests
    "6sz2VkpVqCKpG4bYoBqiivqRabhaCMh1mb8nWd9GANsy", // Pool address used in tests
    "9n2seWqMUN4atuSnTCGQCHTxcv7nyNbVKUMR6rvKw3mV",
    "4q4Cz8J7vitaKEeQHDaXmraqoREUWAmJoTVgtyYFAsiC",
    "GV6QNt9jjDhhWuRFKjW8ngfs73s8Jp6gmQf8bN35QePD",
    "H4QcXPqL88TUhgD2U5CgJRQEn1qMcBbxRkdczTPxP71f",
    "8evBEzMErLUoifqBeWJX7vmes1aEni5Lfk5M2iZZJGjP",
    "9kJHH3r1vdPmGuBVYF5p1cpMKs4BHGaMd7eU1D2qPb9v",
];

#[derive(Accounts)]
#[instruction( lower_tick_index: i32, upper_tick_index: i32)]
pub struct SwapAndCreatePosition<'info> {
    pub invariant: Program<'info, Invariant>,
    #[account(seeds = [b"statev1".as_ref()], seeds::program = invariant::ID, bump = state.load()?.bump)]
    pub state: AccountLoader<'info, State>,
    #[account(mut,
        seeds = [b"positionv1",
        owner.key.as_ref(),
        &position_list.load()?.head.to_le_bytes()],
        bump,
        seeds::program = invariant::ID
    )]
    /// CHECK: Uninitialized position account
    pub position: AccountInfo<'info>,
    #[account(mut,
        seeds = [b"poolv1", token_x.key().as_ref(), token_y.key().as_ref(), &position_pool.load()?.fee.v.to_le_bytes(), &position_pool.load()?.tick_spacing.to_le_bytes()],
        bump = position_pool.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub position_pool: AccountLoader<'info, Pool>,
    #[account(mut,
        seeds = [b"poolv1", token_x.key().as_ref(), token_y.key().as_ref(), &swap_pool.load()?.fee.v.to_le_bytes(), &swap_pool.load()?.tick_spacing.to_le_bytes()],
        bump = swap_pool.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub swap_pool: AccountLoader<'info, Pool>,
    #[account(mut,
        seeds = [b"positionlistv1", owner.key.as_ref()],
        bump = position_list.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub position_list: AccountLoader<'info, PositionList>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,
        seeds = [b"tickv1", position_pool.key().as_ref(), &lower_tick_index.to_le_bytes()],
        bump = lower_tick.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub lower_tick: AccountLoader<'info, Tick>,
    #[account(mut,
        seeds = [b"tickv1", position_pool.key().as_ref(), &upper_tick_index.to_le_bytes()],
        bump = upper_tick.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub upper_tick: AccountLoader<'info, Tick>,
    #[account(mut,
        constraint = position_tickmap.key() == position_pool.load()?.tickmap @ InvalidTickmap,
        constraint = position_tickmap.to_account_info().owner == invariant.key @ InvalidTickmapOwner,
    )]
    pub position_tickmap: AccountLoader<'info, Tickmap>,
    #[account(mut,
      constraint = swap_tickmap.key() == swap_pool.load()?.tickmap @ InvalidTickmap,
      constraint = swap_tickmap.to_account_info().owner == invariant.key @ InvalidTickmapOwner,
    )]
    pub swap_tickmap: AccountLoader<'info, Tickmap>,
    #[account(constraint = token_x.key() == position_pool.load()?.token_x @ InvalidTokenAccount, mint::token_program = token_x_program)]
    #[account(constraint = token_x.key() == swap_pool.load()?.token_x @ InvalidTokenAccount)]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = token_y.key() == position_pool.load()?.token_y @ InvalidTokenAccount, mint::token_program = token_y_program)]
    #[account(constraint = token_y.key() == swap_pool.load()?.token_y @ InvalidTokenAccount)]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut,
        constraint = account_x.mint == token_x.key() @ InvalidMint,
        constraint = &account_x.owner == owner.key @ InvalidOwner,
        token::token_program = token_x_program,
    )]
    pub account_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = account_y.mint == token_y.key() @ InvalidMint,
        constraint = &account_y.owner == owner.key @ InvalidOwner,
        token::token_program = token_y_program,
    )]
    pub account_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = position_reserve_x.mint == token_x.key() @ InvalidMint,
        constraint = &position_reserve_x.owner == program_authority.key @ InvalidOwner,
        constraint = position_reserve_x.key() == position_pool.load()?.token_x_reserve @ InvalidTokenAccount,
        token::token_program = token_x_program,
    )]
    pub position_reserve_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
        constraint = position_reserve_y.mint == token_y.key() @ InvalidMint,
        constraint = &position_reserve_y.owner == program_authority.key @ InvalidOwner,
        constraint = position_reserve_y.key() == position_pool.load()?.token_y_reserve @ InvalidTokenAccount,
        token::token_program = token_y_program,
    )]
    pub position_reserve_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
      constraint = swap_reserve_x.mint == token_x.key() @ InvalidMint,
      constraint = &swap_reserve_x.owner == program_authority.key @ InvalidOwner,
      constraint = swap_reserve_x.key() == swap_pool.load()?.token_x_reserve @ InvalidTokenAccount,
      token::token_program = token_x_program,
  )]
    pub swap_reserve_x: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut,
      constraint = swap_reserve_y.mint == token_y.key() @ InvalidMint,
      constraint = &swap_reserve_y.owner == program_authority.key @ InvalidOwner,
      constraint = swap_reserve_y.key() == swap_pool.load()?.token_y_reserve @ InvalidTokenAccount,
      token::token_program = token_y_program,
  )]
    pub swap_reserve_y: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(constraint = &state.load()?.authority == program_authority.key @ InvalidAuthority)]
    /// CHECK: ignore
    pub program_authority: AccountInfo<'info>,

    #[account(constraint = token_x_program.key() == token::ID || token_x_program.key() == token_2022::ID)]
    pub token_x_program: Interface<'info, TokenInterface>,
    #[account(constraint = token_y_program.key() == token::ID || token_y_program.key() == token_2022::ID)]
    pub token_y_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
    /// CHECK: Accounts used for RPC calls optimization
    #[account(address = Pubkey::find_program_address(&[b"eventoptaccv1", position_pool.key().as_ref()], invariant.key).0)]
    pub event_opt_acc: AccountInfo<'info>,
}

impl<'info> SwapAndCreatePosition<'info> {
    pub fn swap_context<'a, 'b, 'c>(
        ctx: &Context<'a, 'b, 'c, 'info, Self>,
    ) -> CpiContext<'a, 'b, 'c, 'info, invariant::cpi::accounts::Swap<'info>> {
        let swap_accounts = invariant::cpi::accounts::Swap {
            owner: ctx.accounts.owner.to_account_info(),
            account_x: ctx.accounts.account_x.to_account_info(),
            account_y: ctx.accounts.account_y.to_account_info(),
            reserve_x: ctx.accounts.swap_reserve_x.to_account_info(),
            reserve_y: ctx.accounts.swap_reserve_y.to_account_info(),
            program_authority: ctx.accounts.program_authority.to_account_info(),
            state: ctx.accounts.state.to_account_info(),
            tickmap: ctx.accounts.swap_tickmap.to_account_info(),
            pool: ctx.accounts.swap_pool.to_account_info(),
            token_x: ctx.accounts.token_x.to_account_info(),
            token_y: ctx.accounts.token_y.to_account_info(),
            token_x_program: ctx.accounts.token_x_program.to_account_info(),
            token_y_program: ctx.accounts.token_y_program.to_account_info(),
        };

        CpiContext::new(ctx.accounts.invariant.to_account_info(), swap_accounts)
            .with_remaining_accounts(ctx.remaining_accounts.to_vec())
    }

    pub fn create_position_context<'a, 'b, 'c>(
        ctx: &Context<'a, 'b, 'c, 'info, Self>,
    ) -> invariant::cpi::accounts::CreatePosition<'info> {
        let create_position_accounts = invariant::cpi::accounts::CreatePosition {
            state: ctx.accounts.state.to_account_info(),
            reserve_x: ctx.accounts.position_reserve_x.to_account_info(),
            reserve_y: ctx.accounts.position_reserve_y.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
            account_x: ctx.accounts.account_x.to_account_info(),
            account_y: ctx.accounts.account_y.to_account_info(),
            program_authority: ctx.accounts.program_authority.to_account_info(),
            event_opt_acc: ctx.accounts.event_opt_acc.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_x: ctx.accounts.token_x.to_account_info(),
            token_y: ctx.accounts.token_y.to_account_info(),
            tickmap: ctx.accounts.position_tickmap.to_account_info(),
            token_x_program: ctx.accounts.token_x_program.to_account_info(),
            token_y_program: ctx.accounts.token_y_program.to_account_info(),
            lower_tick: ctx.accounts.lower_tick.to_account_info(),
            upper_tick: ctx.accounts.upper_tick.to_account_info(),
            position: ctx.accounts.position.to_account_info(),
            payer: ctx.accounts.owner.to_account_info(),
            owner: ctx.accounts.owner.to_account_info(),
            pool: ctx.accounts.position_pool.to_account_info(),
            position_list: ctx.accounts.position_list.to_account_info(),
        };

        create_position_accounts
    }
    pub fn handler(
        ctx: Context<'_, '_, 'info, 'info, SwapAndCreatePosition<'info>>,
        amount: u64,
        x_to_y: bool,
        by_amount_in: bool,
        sqrt_price_limit: PriceInterface,
        amount_x: u64,
        amount_y: u64,
        min_liquidity: LiquidityInterface,
        slippage_limit_lower: PriceInterface,
        slippage_limit_upper: PriceInterface,
    ) -> Result<()> {
        msg!("INVARIANT AUTOSWAP: SWAP AND CREATE");
        // Without binding parameters to local variables they will be lost after cpi call
        let sqrt_price_limit = Price::new(sqrt_price_limit.v);
        let min_liquidity = Liquidity::new(min_liquidity.v);
        let slippage_limit_lower = Price::new(slippage_limit_lower.v);
        let slippage_limit_upper = Price::new(slippage_limit_upper.v);

        require!(
            SWAP_POOLS.contains(&ctx.accounts.swap_pool.key().to_string().as_str()),
            ErrorCode::SwapDisabled
        );

        require!(
            POSITION_POOLS.contains(&ctx.accounts.position_pool.key().to_string().as_str()),
            ErrorCode::CreatePositionDisabled
        );

        let x_before_swap = TokenAmount(ctx.accounts.account_x.amount);
        let y_before_swap = TokenAmount(ctx.accounts.account_y.amount);

        invariant::cpi::swap(
            Self::swap_context(&ctx),
            x_to_y,
            amount,
            by_amount_in,
            sqrt_price_limit.v,
        )?;

        ctx.accounts.account_x.reload()?;
        ctx.accounts.account_y.reload()?;

        let x_after_swap = TokenAmount(ctx.accounts.account_x.amount);
        let y_after_swap = TokenAmount(ctx.accounts.account_y.amount);
        let (mut max_position_amount_x, mut max_position_amount_y) = if x_to_y {
            (
                amount_x
                    .checked_sub(x_before_swap.checked_sub(x_after_swap).unwrap().get())
                    .ok_or(ErrorCode::InvalidTokenAmountAfterSwap)?,
                amount_y
                    .checked_add(y_after_swap.checked_sub(y_before_swap).unwrap().get())
                    .unwrap(),
            )
        } else {
            (
                amount_x
                    .checked_add(x_after_swap.checked_sub(x_before_swap).unwrap().get())
                    .unwrap(),
                amount_y
                    .checked_sub(y_before_swap.checked_sub(y_after_swap).unwrap().get())
                    .ok_or(ErrorCode::InvalidTokenAmountAfterSwap)?,
            )
        };

        // This is needed to avoid the cases where rounding is imperfect
        if max_position_amount_x > 0 {
            max_position_amount_x = max_position_amount_x.checked_sub(1).unwrap();
        }
        if max_position_amount_y > 0 {
            max_position_amount_y = max_position_amount_y.checked_sub(1).unwrap();
        }

        let LiquidityResult {
            l: liquidity_delta, ..
        } = get_max_liquidity(
            TokenAmount(max_position_amount_x),
            TokenAmount(max_position_amount_y),
            ctx.accounts.lower_tick.load()?.index,
            ctx.accounts.upper_tick.load()?.index,
            Price::new(ctx.accounts.position_pool.load()?.sqrt_price.v),
            true,
        );

        let lower_tick_index = ctx.accounts.lower_tick.load()?.index;
        let upper_tick_index = ctx.accounts.upper_tick.load()?.index;

        let create_position_context = CpiContext::new(
            ctx.accounts.invariant.to_account_info(),
            Self::create_position_context(&ctx),
        );

        invariant::cpi::create_position(
            create_position_context,
            lower_tick_index,
            upper_tick_index,
            liquidity_delta,
            slippage_limit_lower,
            slippage_limit_upper,
        )?;
        let mut position_buf: &[u8] = &ctx.accounts.position.try_borrow_mut_data()?;
        let position = Position::try_deserialize(&mut position_buf)?;

        require!(
            { position.liquidity } >= min_liquidity,
            ErrorCode::LiquidityBelowMinimum
        );

        Ok(())
    }
}
