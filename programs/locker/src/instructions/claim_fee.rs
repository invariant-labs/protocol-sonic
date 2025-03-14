use crate::structs::{DerivedAccountIdent, Locks};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount as ITokenAccount, TokenInterface};
use invariant::cpi::accounts::{ClaimFee as ClaimFeeCpi, TransferPositionOwnership};
use invariant::program::Invariant;
use invariant::structs::{Pool, Position, Tick};
use invariant::structs::{PositionList, State};

#[derive(Accounts)]
#[instruction(index: u32, lower_tick_index: i32, upper_tick_index: i32)]
pub struct ClaimFee<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds=[Locks::IDENT, owner.key().as_ref()], bump = locks.bump)]
    pub locks: Account<'info, Locks>,
    #[account(mut, seeds = [b"positionlistv1", locks.key().as_ref()], bump = authority_list.load()?.bump, seeds::program = invariant::ID)]
    pub authority_list: AccountLoader<'info, PositionList>,

    /// INVARIANT
    pub inv_program: Program<'info, Invariant>,
    #[account(seeds = [b"statev1".as_ref()], bump = inv_state.load()?.bump, seeds::program = invariant::ID)]
    pub inv_state: AccountLoader<'info, State>,
    /// CHECK: Ignore
    #[account(constraint = inv_program_authority.key() == inv_state.load()?.authority)]
    pub inv_program_authority: AccountInfo<'info>,
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
    /// CHECK: initialized via CPI call
    #[account(mut, 
        seeds = [b"positionv1",
        owner.key().as_ref(),
        &position_list.load()?.head.to_le_bytes()],
        seeds::program = invariant::ID,
        bump
    )]
    pub transferred_position: UncheckedAccount<'info>,
    #[account(mut,
        seeds = [b"positionv1",
        locks.key().as_ref(),
        &(authority_list.load()?.head - 1).to_le_bytes()],
        bump = last_position.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub last_position: AccountLoader<'info, Position>,
    #[account(mut,
        seeds = [b"poolv1", token_x.key().as_ref(), token_y.key().as_ref(), &pool.load()?.fee.v.to_le_bytes(), &pool.load()?.tick_spacing.to_le_bytes()],
        bump = pool.load()?.bump,
        seeds::program = invariant::ID
    )]
    pub pool: AccountLoader<'info, Pool>,
    #[account(mut,
        seeds = [b"tickv1", pool.key().as_ref(), &lower_tick_index.to_le_bytes()],
        bump = lower_tick.load()?.bump,
        constraint = lower_tick_index == position.load()?.lower_tick_index,
        seeds::program = invariant::ID
    )]
    pub lower_tick: AccountLoader<'info, Tick>,
    #[account(mut,
        seeds = [b"tickv1", pool.key().as_ref(), &upper_tick_index.to_le_bytes()],
        bump = upper_tick.load()?.bump,
        constraint = upper_tick_index == position.load()?.upper_tick_index,
        seeds::program = invariant::ID
    )]
    pub upper_tick: AccountLoader<'info, Tick>,
    #[account(constraint = token_x.key() == pool.load()?.token_x, mint::token_program = token_x_program)]
    pub token_x: Box<InterfaceAccount<'info, Mint>>,
    #[account(constraint = token_y.key() == pool.load()?.token_y, mint::token_program = token_y_program)]
    pub token_y: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut,
        constraint = account_x.mint == token_x.key(),
        constraint = &account_x.owner == owner.key,
        token::token_program = token_x_program
    )]
    pub account_x: Box<InterfaceAccount<'info, ITokenAccount>>,
    #[account(mut,
        constraint = account_y.mint == token_y.key(),
        constraint = &account_y.owner == owner.key,
        token::token_program = token_y_program
    )]
    pub account_y: Box<InterfaceAccount<'info, ITokenAccount>>,
    #[account(mut,
        constraint = inv_reserve_x.mint == token_x.key(),
        constraint = &inv_reserve_x.owner == inv_program_authority.key,
        constraint = inv_reserve_x.key() == pool.load()?.token_x_reserve,
        token::token_program = token_x_program
    )]
    pub inv_reserve_x: Box<InterfaceAccount<'info, ITokenAccount>>,
    #[account(mut,
        constraint = inv_reserve_y.mint == token_y.key(),
        constraint = &inv_reserve_y.owner == inv_program_authority.key ,
        constraint = inv_reserve_y.key() == pool.load()?.token_y_reserve,
        token::token_program = token_y_program
    )]
    pub inv_reserve_y: Box<InterfaceAccount<'info, ITokenAccount>>,
    pub token_x_program: Interface<'info, TokenInterface>,
    pub token_y_program: Interface<'info, TokenInterface>,
    pub rent: Sysvar<'info, Rent>,
    pub system_program: Program<'info, System>,
}

impl<'info> ClaimFee<'info> {
    pub fn transfer_to_user(
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
    pub fn claim_fee(&self) -> CpiContext<'_, '_, '_, 'info, ClaimFeeCpi<'info>> {
        CpiContext::new(
            self.inv_program.to_account_info(),
            ClaimFeeCpi {
                state: self.inv_state.to_account_info(),
                position: self.transferred_position.to_account_info(),
                pool: self.pool.to_account_info(),
                owner: self.owner.to_account_info(),
                lower_tick: self.lower_tick.to_account_info(),
                upper_tick: self.upper_tick.to_account_info(),
                token_x: self.token_x.to_account_info(),
                token_y: self.token_y.to_account_info(),
                account_x: self.account_x.to_account_info(),
                account_y: self.account_y.to_account_info(),
                reserve_x: self.inv_reserve_x.to_account_info(),
                reserve_y: self.inv_reserve_y.to_account_info(),
                program_authority: self.inv_program_authority.to_account_info(),
                token_x_program: self.token_x_program.to_account_info(),
                token_y_program: self.token_y_program.to_account_info(),
            },
        )
    }

    pub fn transfer_back(&self) -> CpiContext<'_, '_, '_, 'info, TransferPositionOwnership<'info>> {
        CpiContext::new(
            self.inv_program.to_account_info(),
            TransferPositionOwnership {
                payer: self.owner.to_account_info(),
                owner_list: self.position_list.to_account_info(),
                recipient_list: self.authority_list.to_account_info(),
                new_position: self.last_position.to_account_info(),
                removed_position: self.transferred_position.to_account_info(),
                last_position: self.transferred_position.to_account_info(),
                owner: self.owner.to_account_info(),
                recipient: self.locks.to_account_info(),
                rent: self.rent.to_account_info(),
                system_program: self.system_program.to_account_info(),
            },
        )
    }

    pub fn process(
        &mut self,
        inv_index: u32,
        lower_tick_index: i32,
        upper_tick_index: i32,
    ) -> Result<()> {
        let owner_pubkey = self.owner.key();
        let signer_seeds: &[&[&[u8]]] =
            &[&[Locks::IDENT, owner_pubkey.as_ref(), &[self.locks.bump]]];

        invariant::cpi::transfer_position_ownership(self.transfer_to_user().with_signer(signer_seeds), inv_index)?;

        let index = self.position_list.load()?.head - 1;

        invariant::cpi::claim_fee(
            self.claim_fee(),
            index,
            lower_tick_index,
            upper_tick_index,
        )?;

        invariant::cpi::transfer_position_ownership(self.transfer_back(), index)?;

        Ok(())
    }
}
