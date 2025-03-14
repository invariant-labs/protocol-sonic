use crate::{Liquidity, Price, SecondsPerLiquidity};
use anchor_lang::prelude::*;

#[event]
pub struct CreatePositionEvent {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub id: u128,
    pub liquidity: Liquidity,
    pub lower_tick: i32,
    pub upper_tick: i32,
    pub current_timestamp: u64,
    pub seconds_per_liquidity_inside_initial: SecondsPerLiquidity,
}

#[event]
pub struct RemovePositionEvent {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub id: u128,
    pub liquidity: Liquidity,
    pub upper_tick: i32,
    pub current_tick: i32,
    pub lower_tick: i32,
    pub upper_tick_seconds_per_liquidity_outside: SecondsPerLiquidity,
    pub lower_tick_seconds_per_liquidity_outside: SecondsPerLiquidity,
    pub pool_seconds_per_liquidity_global: SecondsPerLiquidity,
    pub current_timestamp: u64,
}

#[event]
pub struct SwapEvent {
    pub swapper: Pubkey,
    pub token_x: Pubkey,
    pub token_y: Pubkey,
    pub x_to_y: bool,
    pub fee: u64,
    pub price_before_swap: Price,
    pub price_after_swap: Price,
}
