use crate::structs::{DerivedAccountIdent, Locks};
use anchor_lang::prelude::*;
use invariant::cpi::accounts::TransferPositionOwnership;
use invariant::program::Invariant;
use invariant::structs::Position;
use invariant::structs::PositionList;

#[derive(Accounts)]
#[instruction(index: u32)]
pub struct UnlockPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds=[Locks::IDENT, owner.key().as_ref()], bump = locks.bump)]
    pub locks: Account<'info, Locks>,
    #[account(mut, seeds = [b"positionlistv1", locks.key().as_ref()], bump = authority_list.load()?.bump, seeds::program = invariant::ID)]
    pub authority_list: AccountLoader<'info, PositionList>,

    /// INVARIANT
    pub inv_program: Program<'info, Invariant>,
    #[account(mut, seeds = [b"positionlistv1", owner.key().as_ref()], bump = position_list.load()?.bump, seeds::program = invariant::ID)]
    pub position_list: AccountLoader<'info, PositionList>,
    #[account(mut,
        seeds = [b"positionv1",
        locks.key().as_ref(),
        &index.to_le_bytes()],
        bump = position.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub position: AccountLoader<'info, Position>,
    #[account(mut,
        seeds = [b"positionv1",
        locks.key().as_ref(),
        &(authority_list.load()?.head - 1).to_le_bytes()],
        bump = last_position.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub last_position: AccountLoader<'info, Position>,
    /// CHECK: initialized via CPI call
    #[account(mut, 
        seeds = [b"positionv1",
        owner.key().as_ref(),
        &position_list.load()?.head.to_le_bytes()],
        seeds::program = invariant::ID,
        bump
    )]
    pub transferred_position: UncheckedAccount<'info>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

impl<'info> UnlockPosition<'info> {
    pub fn transfer_position(
        &self,
    ) -> CpiContext<'_, '_, '_, 'info, TransferPositionOwnership<'info>> {
        CpiContext::new(
            self.inv_program.to_account_info(),
            TransferPositionOwnership {
                payer: self.owner.to_account_info(),
                owner_list: self.authority_list.to_account_info(),
                recipient_list: self.position_list.to_account_info(),
                new_position: self.transferred_position.to_account_info(),
                removed_position: self.position.to_account_info(),
                last_position: self.last_position.to_account_info(),
                owner: self.locks.to_account_info(),
                recipient: self.owner.to_account_info(),
                rent: self.rent.to_account_info(),
                system_program: self.system_program.to_account_info(),
            },
        )
    }

    pub fn process(
        &mut self,
        index: u32,
    ) -> Result<()> {
        require!(
            self.locks.is_expired(index)?,
            crate::ErrorCode::LockNotExpired
        );

        self.locks.remove_lock(index)?;

        let owner_pubkey = self.owner.key();

        let signer_seeds: &[&[&[u8]]] =
            &[&[Locks::IDENT, owner_pubkey.as_ref(), &[self.locks.bump]]];

        invariant::cpi::transfer_position_ownership(self.transfer_position().with_signer(signer_seeds), index)?;

        Locks::realloc(
            &self.locks.to_account_info(),
            &self.owner.key,
            &[
                self.owner.to_account_info(),
                self.locks.to_account_info(),
                self.system_program.to_account_info(),
            ],
            false,
        )?;

        Ok(())
    }
}
