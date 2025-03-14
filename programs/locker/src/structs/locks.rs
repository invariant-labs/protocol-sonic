use super::{DerivedAccountIdent, DerivedAccountSize};
#[allow(unused_imports)]
use crate::ErrorCode::{ClockError, InvalidLockDuration, LockNotFound};
use crate::{derive_account_ident, derive_account_size};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;

#[account]
#[derive(PartialEq, Default, Debug, InitSpace)]
pub struct Locks {
    #[max_len(10)]
    pub positions: Vec<LockedPosition>,
    pub bump: u8,
}

#[derive(PartialEq, Copy, Clone, Default, Debug, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct LockedPosition {
    pub position_id: u128,
    pub end_timestamp: u64,
}

derive_account_ident!(Locks);
derive_account_size!(Locks);
derive_account_size!(LockedPosition);

impl Locks {
    pub const MAX_LOCKS: usize = 10;

    pub fn add_lock(&mut self, position_id: u128, lock_duration: u64) -> Result<()> {
        // if self.now()? + lock_duration < u64::MAX - 301 {
        //     return Err(InvalidLockDuration.into());
        // }

        let new_lock = LockedPosition {
            position_id,
            end_timestamp: self.now()? + lock_duration,
        };

        self.positions.push(new_lock);

        Ok(())
    }

    pub fn is_expired(&self, index: u32) -> Result<bool> {
        Ok(self.positions[index as usize].end_timestamp <= self.now()?)
    }

    pub fn get_id(&self, index: usize) -> u128 {
        self.positions[index].position_id
    }

    pub fn remove_lock(&mut self, index: u32) -> Result<()> {
        self.positions.swap_remove(index as usize);

        Ok(())
    }

    pub fn get_index(&self, position_id: u128) -> Result<usize> {
        self.positions
            .iter()
            .position(|lock| lock.position_id == position_id)
            .ok_or(LockNotFound.into())
    }

    pub fn now(&self) -> Result<u64> {
        Ok(Clock::get().map_err(|_| ClockError)?.unix_timestamp as u64)
    }

    pub fn realloc(
        locks: &AccountInfo,
        owner: &Pubkey,
        account_infos: &[AccountInfo],
        add: bool,
    ) -> Result<()> {
        if add {
            let len = locks.data_len() + LockedPosition::LEN;
            let required_lamports = Rent::get()?.minimum_balance(len);
            let current_lamports = locks.get_lamports();
            let lamports = required_lamports - current_lamports;

            invoke(
                &system_instruction::transfer(owner, &locks.key(), lamports),
                account_infos,
            )?;

            locks.realloc(len, true)?;
        } else {
            let new_len = locks.data_len() - LockedPosition::LEN;
            let required_lamports = Rent::get()?.minimum_balance(new_len);
            let current_lamports = locks.get_lamports();
            let transferable = current_lamports - required_lamports;

            locks.realloc(new_len, true)?;
            locks.sub_lamports(transferable)?;
            // at 0 index is owner account info
            account_infos[0].add_lamports(transferable)?;
        }
        Ok(())
    }
}
