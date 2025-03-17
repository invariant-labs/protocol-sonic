use anchor_lang::prelude::*;
// these types should be used for interface only

#[zero_copy]
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct PriceInterface {
    pub v: u128,
}

#[zero_copy]
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct LiquidityInterface {
    pub v: u128,
}
