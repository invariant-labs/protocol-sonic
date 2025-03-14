mod decimals;
mod errors;
mod instructions;
mod math;

use crate::decimals::{LiquidityInterface, PriceInterface};
use anchor_lang::prelude::*;

use errors::ErrorCode;
use instructions::*;

declare_id!("2M7bbQFj2E2bM41FeY1Tah1tnkkWt46Bvn7fE5sZjWmK");

#[program]
pub mod invariant_autoswap {

    use super::*;
    pub fn swap_and_create_position<'info>(
        ctx: Context<'_, '_, 'info, 'info, SwapAndCreatePosition<'info>>,
        _lower_tick_index: i32,
        _upper_tick_index: i32,
        swap_amount: u64,
        x_to_y: bool,
        sqrt_price_limit: PriceInterface,
        by_amount_in: bool,
        amount_x: u64,
        amount_y: u64,
        min_liquidity_delta: LiquidityInterface,
        slippage_limit_lower: PriceInterface,
        slippage_limit_upper: PriceInterface,
    ) -> Result<()> {
        SwapAndCreatePosition::handler(
            ctx,
            swap_amount,
            x_to_y,
            by_amount_in,
            sqrt_price_limit,
            amount_x,
            amount_y,
            min_liquidity_delta,
            slippage_limit_lower,
            slippage_limit_upper,
        )
    }
}
