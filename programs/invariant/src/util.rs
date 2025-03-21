use anchor_lang::solana_program::system_program;
use anchor_spl::{
    token::Token,
    token_2022::spl_token_2022::{
        self,
        extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
    },
    token_interface::Mint,
};
use std::cell::RefMut;
use std::convert::TryInto;

use crate::math::calculate_price_sqrt;
use crate::structs::pool::Pool;
use crate::structs::tick::Tick;
use crate::structs::tickmap::Tickmap;
use crate::structs::tickmap::{get_search_limit, MAX_TICK, TICK_LIMIT};

use crate::*;

pub fn check_ticks(tick_lower: i32, tick_upper: i32, tick_spacing: u16) -> Result<()> {
    // Check order
    require!(tick_lower < tick_upper, ErrorCode::InvalidTickIndex);

    check_tick(tick_lower, tick_spacing)?;
    check_tick(tick_upper, tick_spacing)?;

    Ok(())
}

pub fn check_tick(tick_index: i32, tick_spacing: u16) -> Result<()> {
    // Check order
    require!(
        tick_index.checked_rem(tick_spacing.into()) == Some(0),
        ErrorCode::InvalidTickIndex
    );

    let tickmap_index = tick_index.checked_div(tick_spacing.into()).unwrap();

    require!(tickmap_index >= (-TICK_LIMIT), ErrorCode::InvalidTickIndex);
    require!(tickmap_index < TICK_LIMIT, ErrorCode::InvalidTickIndex);
    require!(tick_index >= (-MAX_TICK), ErrorCode::InvalidTickIndex);
    require!(tick_index <= MAX_TICK, ErrorCode::InvalidTickIndex);

    Ok(())
}

pub fn get_max_tick(tick_spacing: u16) -> i32 {
    let limit_by_space = TICK_LIMIT
        .checked_sub(1)
        .unwrap()
        .checked_mul(tick_spacing.into())
        .unwrap();
    limit_by_space.min(MAX_TICK - MAX_TICK % tick_spacing as i32)
}

// Finds closes initialized tick in direction of trade
// and compares its price to the price limit of the trade
pub fn get_closer_limit(
    sqrt_price_limit: Price,
    x_to_y: bool,
    current_tick: i32,
    tick_spacing: u16,
    tickmap: &Tickmap,
) -> Result<(Price, Option<(i32, bool)>)> {
    let closes_tick_index = if x_to_y {
        tickmap.prev_initialized(current_tick, tick_spacing)
    } else {
        tickmap.next_initialized(current_tick, tick_spacing)
    };

    match closes_tick_index {
        Some(index) => {
            let price = calculate_price_sqrt(index);
            // trunk-ignore(clippy/if_same_then_else)
            if x_to_y && price > sqrt_price_limit {
                Ok((price, Some((index, true))))
            } else if !x_to_y && price < sqrt_price_limit {
                Ok((price, Some((index, true))))
            } else {
                Ok((sqrt_price_limit, None))
            }
        }
        None => {
            let index = get_search_limit(current_tick, tick_spacing, !x_to_y);
            let price = calculate_price_sqrt(index);

            require!(current_tick != index, ErrorCode::LimitReached);

            // trunk-ignore(clippy/if_same_then_else)
            if x_to_y && price > sqrt_price_limit {
                Ok((price, Some((index, false))))
            } else if !x_to_y && price < sqrt_price_limit {
                Ok((price, Some((index, false))))
            } else {
                Ok((sqrt_price_limit, None))
            }
        }
    }
}

pub fn cross_tick(tick: &mut RefMut<Tick>, pool: &mut Pool, current_timestamp: u64) -> Result<()> {
    tick.fee_growth_outside_x = pool
        .fee_growth_global_x
        .unchecked_sub(tick.fee_growth_outside_x);
    tick.fee_growth_outside_y = pool
        .fee_growth_global_y
        .unchecked_sub(tick.fee_growth_outside_y);

    let seconds_passed: u64 = current_timestamp.checked_sub(pool.start_timestamp).unwrap();
    tick.seconds_outside = seconds_passed - tick.seconds_outside;

    if !pool.liquidity.is_zero() {
        pool.update_seconds_per_liquidity_global(current_timestamp);
    } else {
        pool.last_timestamp = current_timestamp;
    }
    tick.seconds_per_liquidity_outside = pool
        .seconds_per_liquidity_global
        .unchecked_sub(tick.seconds_per_liquidity_outside);

    // When going to higher tick net_liquidity should be added and for going lower subtracted
    if (pool.current_tick_index >= tick.index) ^ tick.sign {
        // trunk-ignore(clippy/assign_op_pattern)
        pool.liquidity = pool.liquidity + tick.liquidity_change;
    } else {
        // trunk-ignore(clippy/assign_op_pattern)
        pool.liquidity = pool.liquidity - tick.liquidity_change;
    }

    Ok(())
}

pub fn get_current_timestamp() -> u64 {
    Clock::get().unwrap().unix_timestamp.try_into().unwrap()
}

pub fn get_current_slot() -> u64 {
    Clock::get().unwrap().slot
}

pub fn close<'info>(info: AccountInfo<'info>, sol_destination: AccountInfo<'info>) -> Result<()> {
    // Transfer tokens from the account to the sol_destination.
    let dest_starting_lamports = sol_destination.lamports();
    **sol_destination.lamports.borrow_mut() =
        dest_starting_lamports.checked_add(info.lamports()).unwrap();
    **info.lamports.borrow_mut() = 0;

    info.assign(&system_program::ID);
    info.realloc(0, false).map_err(Into::into)
}

pub fn is_supported_mint(mint_account: &InterfaceAccount<Mint>) -> Result<bool> {
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == Token::id() {
        return Ok(true);
    }

    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    let extensions = mint.get_extension_types()?;
    for e in extensions {
        if e != ExtensionType::MetadataPointer
            && e != ExtensionType::TokenMetadata
            && e != ExtensionType::InterestBearingConfig
        {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod test {
    use std::cell::RefCell;

    use super::*;

    #[test]
    fn test_get_closer_limit() -> Result<()> {
        let tickmap = &mut Tickmap::default();
        tickmap.flip(true, 0, 1);
        // tick limit closer
        {
            let (result, from_tick) =
                get_closer_limit(Price::from_integer(5), true, 100, 1, tickmap)?;

            let expected = Price::from_integer(5);
            assert_eq!(result, expected);
            assert_eq!(from_tick, None);
        }
        // trade limit closer
        {
            let (result, from_tick) =
                get_closer_limit(Price::from_scale(1, 1), true, 100, 1, tickmap)?;
            let expected = Price::from_integer(1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, Some((0, true)));
        }
        // other direction
        {
            let (result, from_tick) =
                get_closer_limit(Price::from_integer(2), false, -5, 1, tickmap)?;
            let expected = Price::from_integer(1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, Some((0, true)));
        }
        // other direction
        {
            let (result, from_tick) =
                get_closer_limit(Price::from_scale(1, 1), false, -100, 10, tickmap)?;
            let expected = Price::from_scale(1, 1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, None);
        }
        Ok(())
    }

    #[test]
    fn test_cross_tick() -> Result<()> {
        let max_time_range = 10 * 365 * 24 * 3600;
        {
            let mut pool = Pool {
                fee_growth_global_x: FeeGrowth::new(45),
                fee_growth_global_y: FeeGrowth::new(35),
                liquidity: Liquidity::from_integer(4),
                last_timestamp: 15,
                start_timestamp: 4,
                seconds_per_liquidity_global: SecondsPerLiquidity::from_integer(11),
                current_tick_index: 7,
                ..Default::default()
            };
            let tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(30),
                fee_growth_outside_y: FeeGrowth::new(25),
                index: 3,
                seconds_outside: 5,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(3),
                liquidity_change: Liquidity::from_integer(1),
                ..Default::default()
            };
            let max = max_time_range + 15;

            let result_pool = Pool {
                fee_growth_global_x: FeeGrowth::new(45),
                fee_growth_global_y: FeeGrowth::new(35),
                liquidity: Liquidity::from_integer(5),
                last_timestamp: 315360015,
                start_timestamp: 4,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(
                    78840011000000000000000000000000,
                ),
                current_tick_index: 7,
                ..Default::default()
            };
            let result_tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(15),
                fee_growth_outside_y: FeeGrowth::new(10),
                index: 3,
                seconds_outside: 315360006,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(
                    78840010999999999999999999999997,
                ),
                liquidity_change: Liquidity::from_integer(1),
                ..Default::default()
            };

            let ref_tick = RefCell::new(tick);
            let mut refmut_tick = ref_tick.borrow_mut();

            cross_tick(&mut refmut_tick, &mut pool, max).ok();

            assert_eq!(*refmut_tick, result_tick);
            assert_eq!(pool, result_pool);
        }
        {
            let mut pool = Pool {
                fee_growth_global_x: FeeGrowth::new(68),
                fee_growth_global_y: FeeGrowth::new(59),
                liquidity: Liquidity::new(0),
                last_timestamp: 9,
                start_timestamp: 34,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(32),
                current_tick_index: 4,
                ..Default::default()
            };
            let tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(42),
                fee_growth_outside_y: FeeGrowth::new(14),
                index: 9,
                seconds_outside: 41,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(23),
                liquidity_change: Liquidity::new(0),
                ..Default::default()
            };
            let result_pool = Pool {
                fee_growth_global_x: FeeGrowth::new(68),
                fee_growth_global_y: FeeGrowth::new(59),
                liquidity: Liquidity::new(0),
                last_timestamp: 1844674407370,
                start_timestamp: 34,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(32),
                current_tick_index: 4,
                ..Default::default()
            };
            let result_tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(26),
                fee_growth_outside_y: FeeGrowth::new(45),
                index: 9,
                seconds_outside: 1844674407295,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(9),
                liquidity_change: Liquidity::from_integer(0),
                ..Default::default()
            };

            let fef_tick = RefCell::new(tick);
            let mut refmut_tick = fef_tick.borrow_mut();
            cross_tick(&mut refmut_tick, &mut pool, 1844674407370).ok();
            assert_eq!(*refmut_tick, result_tick);
            assert_eq!(pool, result_pool);
        }
        // fee_growth_outside should underflow
        {
            let mut pool = Pool {
                fee_growth_global_x: FeeGrowth::new(3402),
                fee_growth_global_y: FeeGrowth::new(3401),
                liquidity: Liquidity::new(14),
                last_timestamp: 9,
                start_timestamp: 15,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(22),
                current_tick_index: 9,
                ..Default::default()
            };
            let tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(26584),
                fee_growth_outside_y: FeeGrowth::new(1256588),
                index: 45,
                seconds_outside: 74,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(23),
                liquidity_change: Liquidity::new(10),
                ..Default::default()
            };
            let max = max_time_range + pool.last_timestamp;
            let result_pool = Pool {
                fee_growth_global_x: FeeGrowth::new(3402),
                fee_growth_global_y: FeeGrowth::new(3401),
                liquidity: Liquidity::new(4),
                last_timestamp: max,
                start_timestamp: 15,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(
                    22525714285714285714285714285714285736,
                ),
                current_tick_index: 9,
                ..Default::default()
            };
            let result_tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(340282366920938463463374607431768188274),
                fee_growth_outside_y: FeeGrowth::new(340282366920938463463374607431766958269),
                index: 45,
                seconds_outside: 315359920,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(
                    22525714285714285714285714285714285713,
                ),
                liquidity_change: Liquidity::new(10),
                ..Default::default()
            };

            let fef_tick = RefCell::new(tick);
            let mut refmut_tick = fef_tick.borrow_mut();
            cross_tick(&mut refmut_tick, &mut pool, max).ok();
            assert_eq!(*refmut_tick, result_tick);
            assert_eq!(pool, result_pool);
        }
        // seconds_per_liquidity_outside should underflow
        {
            let mut pool = Pool {
                fee_growth_global_x: FeeGrowth::new(145),
                fee_growth_global_y: FeeGrowth::new(364),
                liquidity: Liquidity::new(14),
                last_timestamp: 16,
                start_timestamp: 15,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(354),
                current_tick_index: 9,
                ..Default::default()
            };
            let tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(99),
                fee_growth_outside_y: FeeGrowth::new(256),
                index: 45,
                seconds_outside: 74,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(35),
                liquidity_change: Liquidity::new(10),
                ..Default::default()
            };
            let max = max_time_range + pool.last_timestamp;
            let result_pool = Pool {
                fee_growth_global_x: FeeGrowth::new(145),
                fee_growth_global_y: FeeGrowth::new(364),
                liquidity: Liquidity::new(4),
                last_timestamp: max,
                start_timestamp: 15,
                seconds_per_liquidity_global: SecondsPerLiquidity::new(
                    22525714285714285714285714285714286068,
                ),
                current_tick_index: 9,
                ..Default::default()
            };
            let result_tick = Tick {
                fee_growth_outside_x: FeeGrowth::new(46),
                fee_growth_outside_y: FeeGrowth::new(108),
                index: 45,
                seconds_outside: 315359927,
                seconds_per_liquidity_outside: SecondsPerLiquidity::new(
                    22525714285714285714285714285714286033,
                ),
                liquidity_change: Liquidity::new(10),
                ..Default::default()
            };

            let fef_tick = RefCell::new(tick);
            let mut refmut_tick = fef_tick.borrow_mut();
            cross_tick(&mut refmut_tick, &mut pool, max).ok();
            assert_eq!(*refmut_tick, result_tick);
            assert_eq!(pool, result_pool);
        }
        Ok(())
    }
}
