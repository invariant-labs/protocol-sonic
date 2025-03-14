use crate::structs::{DerivedAccountIdent, Locks};
use crate::ErrorCode;
use anchor_lang::prelude::*;
use invariant::cpi::accounts::TransferPositionOwnership;
use invariant::program::Invariant;
use invariant::structs::{Position, PositionList};

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct LockPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds=[Locks::IDENT, owner.key().as_ref()], bump = locks.bump)]
    pub locks: Account<'info, Locks>,
    #[account(mut, seeds = [b"positionlistv1", locks.key().as_ref()], bump = authority_list.load()?.bump, seeds::program = invariant::ID)]
    pub authority_list: AccountLoader<'info, PositionList>,

    /// INVARIANT
    pub inv_program: Program<'info, Invariant>,
    /// CHECK: initialized via CPI call
    #[account(mut, 
        seeds = [b"positionv1",
        locks.key().as_ref(),
        &authority_list.load()?.head.to_le_bytes()],
        seeds::program = invariant::ID,
        bump
    )]
    pub transferred_position: UncheckedAccount<'info>,
    #[account(mut,
        seeds = [b"positionv1",
        owner.key().as_ref(),
        &index.to_le_bytes()],
        seeds::program = invariant::ID,
        bump = position.load()?.bump,
    )]
    pub position: AccountLoader<'info, Position>,
    #[account(mut,
        seeds = [b"positionv1",
        owner.key().as_ref(),
        &(position_list.load()?.head - 1).to_le_bytes()],
        seeds::program = invariant::ID,
        bump = last_position.load()?.bump
    )]
    pub last_position: AccountLoader<'info, Position>,

    #[account(mut, seeds = [b"positionlistv1", owner.key().as_ref()], bump = position_list.load()?.bump, seeds::program = invariant::ID)]
    pub position_list: AccountLoader<'info, PositionList>,

    pub rent: Sysvar<'info, Rent>,

    pub system_program: Program<'info, System>,
}

impl<'info> LockPosition<'info> {
    pub fn transfer_position(
        &self,
    ) -> CpiContext<'_, '_, '_, 'info, TransferPositionOwnership<'info>> {
        CpiContext::new(
            self.inv_program.to_account_info(),
            TransferPositionOwnership {
                payer: self.owner.to_account_info(),
                owner_list: self.position_list.to_account_info(),
                recipient_list: self.authority_list.to_account_info(),
                new_position: self.transferred_position.to_account_info(),
                removed_position: self.position.to_account_info(),
                last_position: self.last_position.to_account_info(),
                owner: self.owner.to_account_info(),
                recipient: self.locks.to_account_info(),
                rent: self.rent.to_account_info(),
                system_program: self.system_program.to_account_info(),
            },
        )
    }

    pub fn process(&mut self, lock_duration: u64, index: u32) -> Result<()> {
        require!(
            self.locks.positions.len() < Locks::MAX_LOCKS,
            ErrorCode::ExceededLockLimit
        );

        let position_id = self.position.load()?.id;

        self.locks.add_lock(position_id, lock_duration)?;

        invariant::cpi::transfer_position_ownership(self.transfer_position(), index)?;

        Locks::realloc(
            &self.locks.to_account_info(),
            &self.owner.key,
            &[
                self.owner.to_account_info(),
                self.locks.to_account_info(),
                self.system_program.to_account_info(),
            ],
            true,
        )?;

        Ok(())
    }
}
