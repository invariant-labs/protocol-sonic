use decimal::U192;
use invariant::{decimals::*, math::calculate_price_sqrt};
use std::convert::TryInto;

#[derive(Debug)]
pub struct LiquidityResult {
    #[allow(dead_code)]
    pub x: TokenAmount,
    #[allow(dead_code)]
    pub y: TokenAmount,
    pub l: Liquidity,
}

#[derive(Debug)]
pub struct SingleTokenLiquidity {
    pub l: Liquidity,
    pub amount: TokenAmount,
}

pub fn get_liquidity_by_y_sqrt_price(
    y: TokenAmount,
    lower_sqrt_price: Price,
    upper_sqrt_price: Price,
    current_sqrt_price: Price,
    rounding_up: bool,
) -> SingleTokenLiquidity {
    assert!(
        current_sqrt_price > lower_sqrt_price,
        "Current sqrt price is less than or equal to lower sqrt price"
    );

    if upper_sqrt_price <= current_sqrt_price {
        let sqrt_price_diff = upper_sqrt_price.checked_sub(lower_sqrt_price).unwrap();
        let liquidity = Liquidity::new(
            U192::from(y.get())
                .checked_mul(U192::from(Price::from_integer(1).get()))
                .unwrap()
                .checked_mul(U192::from(Liquidity::from_integer(1).get()))
                .unwrap()
                .checked_div(U192::from(sqrt_price_diff.get()))
                .unwrap()
                .try_into()
                .unwrap(),
        );
        return SingleTokenLiquidity {
            l: liquidity,
            amount: TokenAmount(0),
        };
    }

    let sqrt_price_diff = current_sqrt_price.checked_sub(lower_sqrt_price).unwrap();
    let liquidity = Liquidity::new(
        U192::from(y.get())
            .checked_mul(U192::from(Price::from_integer(1).get()))
            .unwrap()
            .checked_mul(U192::from(Liquidity::from_integer(1).get()))
            .unwrap()
            .checked_div(U192::from(sqrt_price_diff.get()))
            .unwrap()
            .try_into()
            .unwrap(),
    );
    let denominator = current_sqrt_price.big_mul(upper_sqrt_price);
    let nominator = upper_sqrt_price.checked_sub(current_sqrt_price).unwrap();

    let x = calculate_x(nominator, denominator, liquidity, rounding_up);

    SingleTokenLiquidity {
        l: liquidity,
        amount: x,
    }
}

pub fn get_liquidity_by_x_sqrt_price(
    x: TokenAmount,
    lower_sqrt_price: Price,
    upper_sqrt_price: Price,
    current_sqrt_price: Price,
    rounding_up: bool,
) -> SingleTokenLiquidity {
    assert!(
        upper_sqrt_price > current_sqrt_price,
        "Upper sqrt price is less than current sqrt price"
    );

    if current_sqrt_price < lower_sqrt_price {
        let nominator = lower_sqrt_price.big_mul(upper_sqrt_price);
        let denominator = upper_sqrt_price.checked_sub(lower_sqrt_price).unwrap();
        let liquidity = Liquidity::new(
            U256::from(x.get())
                .checked_mul(U256::from(nominator.get()))
                .unwrap()
                .checked_mul(U256::from(Liquidity::from_integer(1).get()))
                .unwrap()
                .checked_div(U256::from(denominator.get()))
                .unwrap()
                .try_into()
                .unwrap(),
        );
        return SingleTokenLiquidity {
            l: liquidity,
            amount: TokenAmount(0),
        };
    }

    let nominator = current_sqrt_price.big_mul(upper_sqrt_price);
    let denominator = upper_sqrt_price.checked_sub(current_sqrt_price).unwrap();
    let liquidity = Liquidity::new(
        U256::from(x.get())
            .checked_mul(U256::from(nominator.get()))
            .unwrap()
            .checked_mul(U256::from(Liquidity::from_integer(1).get()))
            .unwrap()
            .checked_div(U256::from(denominator.get()))
            .unwrap()
            .try_into()
            .unwrap(),
    );

    let sqrt_price_diff = current_sqrt_price.checked_sub(lower_sqrt_price).unwrap();
    let y = calculate_y(sqrt_price_diff, liquidity, rounding_up);
    SingleTokenLiquidity {
        l: liquidity,
        amount: y,
    }
}

pub fn calculate_x(
    nominator: Price,
    denominator: Price,
    liquidity: Liquidity,
    rounding_up: bool,
) -> TokenAmount {
    let common = liquidity.big_mul(nominator).big_div(denominator).get();

    if rounding_up {
        TokenAmount::new(
            (U192::from(common)
                .checked_add(U192::from(Liquidity::from_integer(1).get()))
                .unwrap()
                .checked_sub(U192::from(1))
                .unwrap()
                .checked_div(U192::from(Liquidity::from_integer(1).get())))
            .unwrap()
            .try_into()
            .unwrap(),
        )
    } else {
        TokenAmount::new(
            (common.checked_div(Liquidity::from_integer(1).get()))
                .unwrap()
                .try_into()
                .unwrap(),
        )
    }
}

pub fn calculate_y(sqrt_price_diff: Price, liquidity: Liquidity, rounding_up: bool) -> TokenAmount {
    let shifted_liquidity = liquidity
        .get()
        .checked_div(Liquidity::from_integer(1).get())
        .unwrap();
    if rounding_up {
        TokenAmount::new(
            (U256::from(sqrt_price_diff.get()).checked_mul(U256::from(shifted_liquidity)))
                .unwrap()
                .checked_add(U256::from(
                    Price::from_integer(1).get().checked_sub(1).unwrap(),
                ))
                .unwrap()
                .checked_div(U256::from(Price::from_integer(1).get()))
                .unwrap()
                .try_into()
                .unwrap(),
        )
    } else {
        TokenAmount::new(
            U256::from(sqrt_price_diff.get())
                .checked_mul(U256::from(shifted_liquidity))
                .unwrap()
                .checked_div(U256::from(Price::from_integer(1).get()))
                .unwrap()
                .try_into()
                .unwrap(),
        )
    }
}

pub fn get_max_liquidity(
    x: TokenAmount,
    y: TokenAmount,
    lower_tick: i32,
    upper_tick: i32,
    current_sqrt_price: Price,
    rounding_up: bool,
) -> LiquidityResult {
    let lower_sqrt_price = calculate_price_sqrt(lower_tick);
    let upper_sqrt_price = calculate_price_sqrt(upper_tick);

    if upper_sqrt_price <= current_sqrt_price {
        let liquidity = get_liquidity_by_y_sqrt_price(
            y,
            lower_sqrt_price,
            upper_sqrt_price,
            current_sqrt_price,
            rounding_up,
        );
        return LiquidityResult {
            l: liquidity.l,
            x: liquidity.amount,
            y,
        };
    }

    if current_sqrt_price <= lower_sqrt_price {
        let liquidity = get_liquidity_by_x_sqrt_price(
            x,
            lower_sqrt_price,
            upper_sqrt_price,
            current_sqrt_price,
            rounding_up,
        );
        return LiquidityResult {
            l: liquidity.l,
            x,
            y: liquidity.amount,
        };
    }

    let result_by_y = get_liquidity_by_y_sqrt_price(
        y,
        lower_sqrt_price,
        upper_sqrt_price,
        current_sqrt_price,
        rounding_up,
    );
    let result_by_x = get_liquidity_by_x_sqrt_price(
        x,
        lower_sqrt_price,
        upper_sqrt_price,
        current_sqrt_price,
        rounding_up,
    );

    let result = if result_by_x.l > result_by_y.l {
        if result_by_x.amount <= y {
            LiquidityResult {
                x,
                y: result_by_x.amount,
                l: result_by_x.l,
            }
        } else {
            LiquidityResult {
                x: result_by_y.amount,
                y,
                l: result_by_y.l,
            }
        }
    } else {
        if result_by_y.amount <= x {
            LiquidityResult {
                x: result_by_y.amount,
                y,
                l: result_by_y.l,
            }
        } else {
            LiquidityResult {
                x,
                y: result_by_x.amount,
                l: result_by_x.l,
            }
        }
    };

    result
}

#[cfg(test)]
mod test {
    use super::*;
    use invariant::math::*;
    use invariant::structs::*;
    use invariant::util::*;

    #[test]
    fn get_max_liquidity_full_range_limit_tick_spacing_100() {
        let max_liquidity = get_max_liquidity(
            TokenAmount::new(u64::MAX - 2_u64.pow(24)),
            TokenAmount::new(u64::MAX - 2_u64.pow(24)),
            -get_max_tick(100),
            get_max_tick(100),
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 18447025809048884511436060); // < 2^84
    }

    #[test]
    fn get_max_liquidity_full_range_limit_tick_spacing_1() {
        let lower_tick = -get_max_tick(1);
        let upper_tick = get_max_tick(1);
        let mut pool = Pool {
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        // assert_eq!(max_liquidity.l.v, 10349643991034368177654906); // < 2^85

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_token_y() {
        let lower_tick = -get_max_tick(1);
        let upper_tick = get_max_tick(1) / 2;
        let mut pool = Pool {
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 10349643991034368178777016);
        assert_eq!(max_liquidity.x.0, 6935394941246374175);
        assert_eq!(max_liquidity.y.0, 9223372036854775808);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_token_x() {
        let lower_tick = -get_max_tick(1) / 2;
        let upper_tick = get_max_tick(1);
        let mut pool = Pool {
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 10349643991035813454799457);
        assert_eq!(max_liquidity.x.0, 9223372036854775808);
        assert_eq!(max_liquidity.y.0, 6935394941253979007);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        // rounding inaccuracy
        assert_eq!(result.1, max_liquidity.y + TokenAmount(1));
    }
    #[test]
    fn get_max_liquidity_more_only_token_x() {
        let lower_tick = -get_max_tick(1) / 2;
        let mut pool = Pool {
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };
        let upper_tick = pool.current_tick_index;

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 13763977075119826339578234);
        assert_eq!(max_liquidity.x.0, 0);
        assert_eq!(max_liquidity.y.0, 9223372036854775808);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_only_token_y() {
        let upper_tick = get_max_tick(1) / 2;

        let mut pool = Pool {
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };
        let lower_tick = pool.current_tick_index;

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 13763977075132996811378852);
        assert_eq!(max_liquidity.x.0, 9223372036854775808);
        assert_eq!(max_liquidity.y.0, 0);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_token_y_tick_spacing_100() {
        let tick_spacing = 100;
        let lower_tick = -get_max_tick(tick_spacing);
        let upper_tick = get_max_tick(tick_spacing) / 2;
        let mut pool = Pool {
            tick_spacing,
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 9223512904532830992336444);
        assert_eq!(max_liquidity.x.0, 9187467171782888944);
        assert_eq!(max_liquidity.y.0, 9223372036854775808);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_token_x_tick_spacing_100() {
        let tick_spacing = 100;
        let lower_tick = -get_max_tick(tick_spacing) / 2;
        let upper_tick = get_max_tick(tick_spacing);
        let mut pool = Pool {
            tick_spacing,
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 9223512904533167889741016);
        assert_eq!(max_liquidity.x.0, 9223372036854775808);
        assert_eq!(max_liquidity.y.0, 9187467171789842454);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        // rounding inaccuracy
        assert_eq!(result.1, max_liquidity.y + TokenAmount(1));
    }
    #[test]
    fn get_max_liquidity_more_only_token_x_tick_spacing_100() {
        let tick_spacing = 100;
        let lower_tick = -get_max_tick(tick_spacing) / 2;
        let mut pool = Pool {
            tick_spacing,
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };
        let upper_tick = pool.current_tick_index;

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 9259558637276441324875993);
        assert_eq!(max_liquidity.x.0, 0);
        assert_eq!(max_liquidity.y.0, 9223372036854775808);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }

    #[test]
    fn get_max_liquidity_more_only_token_y_tick_spacing_100() {
        let tick_spacing = 100;
        let upper_tick = get_max_tick(tick_spacing) / 2;

        let mut pool = Pool {
            tick_spacing,
            current_tick_index: 0,
            liquidity: Liquidity::new(0),
            sqrt_price: Price::from_integer(1),
            ..Default::default()
        };
        let lower_tick = pool.current_tick_index;

        let max_liquidity = get_max_liquidity(
            TokenAmount::new(2u64.pow(63)),
            TokenAmount::new(2u64.pow(63)),
            lower_tick,
            upper_tick,
            Price::from_integer(1),
            true,
        );
        assert_eq!(max_liquidity.l.v, 9259558637283111183839552);
        assert_eq!(max_liquidity.x.0, 9223372036854775808);
        assert_eq!(max_liquidity.y.0, 0);

        let result =
            calculate_amount_delta(&mut pool, max_liquidity.l, true, upper_tick, lower_tick)
                .unwrap();
        assert_eq!(result.0, max_liquidity.x);
        assert_eq!(result.1, max_liquidity.y);
    }
}
