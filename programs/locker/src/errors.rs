use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid lock duration")]
    InvalidLockDuration = 0, // 1770
    #[msg("Lock not expired")]
    LockNotExpired = 1, // 1771
    #[msg("Couldnt retrieve current timestamp")]
    ClockError = 2, // 1772
    #[msg("Invalid Position")]
    InvalidPosition = 3, // 1773
    #[msg("Invalid token program")]
    InvalidTokenProgram = 4, // 1774
    #[msg("Lock not found")]
    LockNotFound = 5, // 1775
    #[msg("Too many locks")]
    ExceededLockLimit = 6, // 1776
}
