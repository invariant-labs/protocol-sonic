use crate::math::{get_max_liquidity, LiquidityResult};
use crate::ErrorCode::{self, *};
use crate::*;

use anchor_spl::{token, token_2022};
use invariant::program::Invariant;
use invariant::structs::pool::Pool;
use invariant::structs::position::Position;
use invariant::structs::position_list::PositionList;
use invariant::structs::tick::Tick;
use invariant::structs::Tickmap;
// use anchor_lang::prelude::*;
use invariant::decimals::*;

use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use invariant::structs::*;

const SWAP_POOLS: [&'static str; 11] = [
    "ApindooEUVcVbp2CCwZDSQ6EKVZMqfQmeHJ7wFwSkfxC", // Pool address used in tests
    "DHNLTwn9Y3Re6TZSxxKKSWsCFpJ3gZwhvSGDUj6PP8Pk", // Pool address used in tests
    "F9tTxkZZrWKMHGcJyxJygER6BiF4D8WHFftve4p6xxSG", // Pool address used in tests
    "BHMc4kE8C8Yjy3kouVG19UD7uZ5Hmtbwiro1jsRMXy27", // Pool address used in tests
    "FV4ypSZ6mTiggAPsWcrPDxR84wiuao4AGaBeMWp9piYy", // Pool address used in tests
    "F89YjPNUfP5Q6xxnk8ZSiV3tHzCYKH7TvgLE1Mc9s7H",  // testnet btc/eth 0.01
    "2DqmbNPisbN7nbuAdVr85rs6pR6jpvMVw8iDia2vAXp7", // testnet btc/usdc 0.01
    "E2B7KUFwjxrsy9cC17hmadPsxWHD1NufZXTyrtuz8YxC", // SOL/USDC 0.09
    "HRgVv1pyBLXdsAddq4ubSqo8xdQWRrYbvmXqEDtectce", // ETH/USDC 0.09
    "86vPh8ctgeQnnn8qPADy5BkzrqoH5XjMCWvkd4tYhhmM", // SOL/ETH 0.09
    "FvVsbwsbGVo6PVfimkkPhpcRfBrRitiV946nMNNuz7f9", // TETH/ETH 0.01
];

const POSITION_POOLS: [&'static str; 48] = [
    "6efW2pggVhkWqFR6qp6ReTUWFuKQezfdpadM4gXScH6w", // Pool address used in tests
    "ApindooEUVcVbp2CCwZDSQ6EKVZMqfQmeHJ7wFwSkfxC", // Pool address used in tests
    "DHNLTwn9Y3Re6TZSxxKKSWsCFpJ3gZwhvSGDUj6PP8Pk", // Pool address used in tests
    "F9tTxkZZrWKMHGcJyxJygER6BiF4D8WHFftve4p6xxSG", // Pool address used in tests
    "BHMc4kE8C8Yjy3kouVG19UD7uZ5Hmtbwiro1jsRMXy27", // Pool address used in tests
    "FV4ypSZ6mTiggAPsWcrPDxR84wiuao4AGaBeMWp9piYy", // Pool address used in tests
    "F89YjPNUfP5Q6xxnk8ZSiV3tHzCYKH7TvgLE1Mc9s7H",  // testnet btc/eth 0.01
    "61sHhFrRDxwpVXro8iuUjVCmFwtjmvzACNzNmdQiHf1B", // testnet btc/eth 0.03
    "EQujvjSpb14w9dsyLD6243HVcSD5SgQHkUKK5RLCGcKf", // testnet btc/eth 0.05
    "HU6fzpfcXGEFXU6tFJD5EBs2r4F4XbhxSATkhVT9rFKZ", // testnet btc/eth 0.09
    "DLBJyTS7rCVEZJuBY7y3D4TmZYjXDoia9hacNa7iNPXh", // testnet btc/eth 0.1
    "9ijZd9MGku5BneX7FKNmbeMdaiYGJFiqtBzDrbxjCbrk", // testnet btc/eth 0.3
    "8Mms3JRXUWAyPS1jqxM3iAdVi1BvYBi6BU4DDtvTTs1g", // testnet btc/eth 1
    "2DqmbNPisbN7nbuAdVr85rs6pR6jpvMVw8iDia2vAXp7", // testnet btc/usdc 0.01
    "DNnX3hv9H3ykh29Zjm52zaWT7iE947S7CdMuKNVH52nY", // testnet btc/usdc 0.03
    "EmxjrerEvNSbwGneqgb2MNT27JTng4uXWcMGfTofFrgV", // testnet btc/usdc 0.05
    "5f63BRrvoqf3TH2xvWNWtaqRo3sTbPuHjMaVspn7pDKp", // testnet btc/usdc 0.09
    "4ecDThVdiP6wHN2Tc6etpJt8hBtp573pgPb72vWodcVr", // testnet btc/usdc 0.1
    "3DvAH5NwZikhZpsTMbZvZVjHsf6AjfXW3H5gZAfmejyG", // testnet btc/usdc 0.3
    "GmCRe13oLWSz7pWmqsnLxTxF8zXapWTQSRjmfbJ654XZ", // testnet btc/usdc 1
    "DA75rd2KfPyYJY286qgwtYMfwfjTY6T53sM5Hto9FWfi", // SOL/USDC 0.01
    "DXSJENyZAsrSTESpKGtC2YsEsBEauns47Qt46tN8p9NF", // SOL/USDC 0.02
    "6ip62Wj6FYpe1rJm7Wo3ebPCDivWi5hjqRBYGnn8Ee7Q", // SOL/USDC 0.05
    "E2B7KUFwjxrsy9cC17hmadPsxWHD1NufZXTyrtuz8YxC", // SOL/uSDC 0.09
    "5N5j6yMzazQVPa9fycC2rjqHaj8f1mZJbLVS6A7CJ1iF", // SOL/USDC 0.1
    "2YMcH9VEBXKzA4c2DHua487ZpGaZarYeRjgNBXPxHSRj", // SOL/USDC 0.3
    "GuXMNMmmrP1MgYMCm4RcKV7R1jef5LZBjJSxX7c3YH7R", // SOL/USDC 0.1
    "G8Skt6kgqVL9ocYn4aYVGs3gUg8EfQrTJAkA2qt3gcs8", // ETH/USDC 0.01
    "FdEcxaJ9cDW5Y3AZ79eDtzdvK7uaxSEfn5vPb47ew5yg", // ETH/USDC 0.02
    "3f8r3ioxkAZViSp5PcA319K9HB2ZF7aSK2CeaL6w1Lho", // ETH/USDC 0.05
    "HRgVv1pyBLXdsAddq4ubSqo8xdQWRrYbvmXqEDtectce", // ETH/USDC 0.09
    "8wTVWkMitZZBAgH8fAxwUc9qxVdCxZdMpw554xUKksym", // ETH/USDC 0.1
    "JC2Uyumt8zpwAkwHawwSds8cCTL8M2ESceg4DpPApznb", // ETH/USDC 0.3
    "5WFyCtryxTK3v7LMS1169m1Vz1xUauxJYHfRyMh8uhoH", // ETH/USDC 1
    "6AL6jcaDUfeg3NrybF2PpmFjyKc8XPqcu8MDXAjoyjjM", // ETH/SOL 0.01
    "FSBb5Atma2HpUhembdBT1edYw1kmVPHVqvtR1Q11jBGL", // ETH/SOL 0.02
    "7owDutq5guBRS94XCbVy1Q1tW6nXNhHeeQPeDTQ1xTYb", // ETH/SOL 0.05
    "86vPh8ctgeQnnn8qPADy5BkzrqoH5XjMCWvkd4tYhhmM", // ETH/SOL 0.09
    "5nVk1wDt6TnLXiPvTDmfKzLoRbBJKuHm4pSneTPPWWS2", // ETH/SOL 0.1
    "DSPSc9ManiurhdDBJA3XgZvc1MDibeocrKBB4MukDouE", // ETH/SOL 0.3
    "4x7P9KXWm9QdueFFvoVY5Sd8B4YKsGUBB7xQ3iDQQQoa", // ETH/SOL 1
    "FvVsbwsbGVo6PVfimkkPhpcRfBrRitiV946nMNNuz7f9", // ETH/TETH 0.01
    "2MPKn48cLpMYrqJv3Yucet2LDduZQMi6FBsdqKANvg6X", // ETH/TETH 0.02
    "9YdHK4nPkFS9f3wJ9JTmHnya55nbpRr1nBU3LHZvSBme", // ETH/TETH 0.05
    "9za12Ea7dH51N4kdhSpaKJxekSPWXgKHavdiFG8DEVXc", // ETH/TETH 0.09
    "4E8HzjsxvBpiMYPshihf9qUiuvL6nh833kuxzRYvQ642", // ETH/TETH 0.1
    "ykVrPy3CWKLpfeTt7rCaRouz37kdcWqBaAcArEtGToq",  // ETH/TETH 0.3
    "HrMrnPC6F9c9CV2ZinEgWP26pupRDNaKLuB4UXKHzBGd", // ETH/TETH 1
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
