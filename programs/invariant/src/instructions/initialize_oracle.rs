use crate::errors::ErrorCode;
use crate::structs::oracle::Oracle;
use crate::structs::pool::Pool;
use crate::ErrorCode::*;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::token_interface::Mint;

#[derive(Accounts)]
pub struct InitializeOracle<'info> {
    #[account(mut,
        seeds = [b"poolv1", token_x.key().as_ref(), token_y.key().as_ref(), &pool.load()?.fee.v.to_le_bytes(), &pool.load()?.tick_spacing.to_le_bytes()],
        bump = pool.load()?.bump
    )]
    pub pool: AccountLoader<'info, Pool>,
    #[account(zero)]
    pub oracle: AccountLoader<'info, Oracle>,
    #[account(constraint = token_x.key() == pool.load()?.token_x @ InvalidTokenAccount)]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = token_y.key() == pool.load()?.token_y @ InvalidTokenAccount)]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,
    pub payer: Signer<'info>,
    pub rent: Sysvar<'info, Rent>,
    #[account(address = system_program::ID)]
    /// CHECK: Ignore
    pub system_program: AccountInfo<'info>,
}

impl<'info> InitializeOracle<'info> {
    pub fn handler(&self) -> Result<()> {
        msg!("INVARIANT: INITIALIZE ORACLE");

        let oracle = &mut self.oracle.load_init()?;
        let pool = &mut self.pool.load_mut()?;

        require!(
            !pool.oracle_initialized,
            ErrorCode::OracleAlreadyInitialized
        );

        pool.set_oracle(self.oracle.key());
        oracle.init();

        Ok(())
    }
}
