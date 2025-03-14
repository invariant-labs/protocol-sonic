use crate::structs::{DerivedAccountIdent, DerivedAccountSize, Locks};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeUserLocks<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(init, payer = owner, space = Locks::LEN, seeds=[Locks::IDENT, owner.key().as_ref()], bump)]
    pub locks: Account<'info, Locks>,

    pub system_program: Program<'info, System>,
}

impl<'info> InitializeUserLocks<'info> {
    pub fn process(&mut self, bump: u8) -> Result<()> {
        self.locks.bump = bump;
        Ok(())
    }
}
