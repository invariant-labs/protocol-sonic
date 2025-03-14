use crate::{
    decimals::{Liquidity, SecondsPerLiquidity},
    size,
};
use anchor_lang::prelude::*;
#[account(zero_copy(unsafe))]
#[repr(packed)]
#[derive(PartialEq, Default, Debug)]
pub struct UserStake {
    pub incentive: Pubkey,
    pub position: Pubkey,
    pub seconds_per_liquidity_initial: SecondsPerLiquidity,
    pub liquidity: Liquidity,
    pub bump: u8,
}

size!(UserStake);
