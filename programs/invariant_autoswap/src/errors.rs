use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Provided token account is different than expected")]
    InvalidTokenAccount = 0, // 1770
    #[msg("Admin address is different than expected")]
    InvalidOwner = 1, // 1771
    #[msg("Provided token account mint is different than expected mint token")]
    InvalidMint = 2, // 1772
    #[msg("Provided tickmap is different than expected")]
    InvalidTickmap = 3, // 1773
    #[msg("Provided tickmap owner is different than program ID")]
    InvalidTickmapOwner = 4, // 1774
    #[msg("Position liquidity would be lower than provided limit")]
    LiquidityBelowMinimum = 5, // 1775
    #[msg("Swapping with swap and create position was not enabled for this pool")]
    SwapDisabled = 6, // 1776
    #[msg("Not enough tokens to create a position after swap")]
    InvalidTokenAmountAfterSwap = 7, // 1777
    #[msg("Creating a position with swap and create position was disabled for this pool")]
    CreatePositionDisabled = 8, // 1778
    #[msg("Provided authority is different than expected")]
    InvalidAuthority = 9, // 1779
}
