use crate::decimals::*;
use crate::ErrorCode;
use crate::Result;
use std::cmp;

pub fn calculate_reward(
    total_reward_unclaimed: TokenAmount,
    total_seconds_claimed: Seconds,
    start_time: Seconds,
    end_time: Seconds,
    liquidity: Liquidity,
    seconds_per_liquidity_inside_initial: SecondsPerLiquidity,
    seconds_per_liquidity_inside: SecondsPerLiquidity,
    current_time: Seconds,
) -> Result<(Seconds, TokenAmount)> {
    if current_time <= start_time {
        return Err(ErrorCode::NotStarted.into());
    }

    let seconds_inside = Seconds::from_decimal(
        seconds_per_liquidity_inside.unchecked_sub(seconds_per_liquidity_inside_initial)
            * liquidity,
    );

    let total_seconds_unclaimed =
        cmp::max(end_time, current_time) - start_time - total_seconds_claimed;

    let result = total_reward_unclaimed * seconds_inside / total_seconds_unclaimed;
    Ok((seconds_inside, result))
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn test_calculate_reward_1() {
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1_000_000),
            Seconds::new(0),
            Seconds::new(1637002223),
            Seconds::new(1640002223),
            Liquidity::from_integer(1_000_000),
            SecondsPerLiquidity::from_scale(4_000_000, 12),
            SecondsPerLiquidity::from_scale(10_000_000, 12),
            Seconds::new(1637002232),
        )
        .unwrap();
        assert_eq!(result, TokenAmount::new(2));
        assert_eq!(seconds_inside, Seconds::new(6));
    }
    #[test]
    fn test_calculate_reward_2() {
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(0),
            Seconds::new(100),
            Liquidity::from_integer(2_000_000),
            SecondsPerLiquidity::from_scale(10_000_000, 12),
            SecondsPerLiquidity::from_scale(35_000_000, 12),
            Seconds::new(50),
        )
        .unwrap();
        assert_eq!(result, TokenAmount::new(500));
        assert_eq!(seconds_inside, Seconds::new(50));
    }

    #[test]
    fn test_calculate_reward_3() {
        //half the liquidity over 20% of the total duration
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(10),
            SecondsPerLiquidity::new(0),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(120),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(200));
        assert_eq!(seconds_inside, Seconds::new(20));
    }

    #[test]
    fn test_calculate_reward_4() {
        //reward is lesser if end time was exceeded
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(100),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(1),
            Seconds::new(300),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(500));
        assert_eq!(seconds_inside, Seconds::new(100));
    }

    #[test]
    fn test_calculate_reward_5() {
        //reward is lesser if end time was exceeded
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(100),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(1),
            Seconds::new(201),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(990));
        assert_eq!(seconds_inside, Seconds::new(100));
    }

    #[test]
    fn test_calculate_reward_6() {
        // reward is greater if some seconds was claimed
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(10),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(5),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(120),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(111));
        assert_eq!(seconds_inside, Seconds::new(10));
    }

    #[test]
    fn test_calculate_reward_7() {
        // 0 reward because total_reward_unclaimed = 0
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(0),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(5),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(120),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(10));
    }

    #[test]
    fn test_calculate_reward_8() {
        // 0 seconds inside
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(5),
            SecondsPerLiquidity::from_integer(2),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(120),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(0));
    }

    #[test]
    fn test_calculate_reward_9() {
        //0 liquidity gets 0 reward
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(120),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(0));
    }

    #[test]
    fn test_calculate_reward_10() {
        //current time is before start
        let failed = calculate_reward(
            TokenAmount::new(1000),
            Seconds::new(0),
            Seconds::new(100),
            Seconds::new(200),
            Liquidity::from_integer(5),
            SecondsPerLiquidity::from_integer(0),
            SecondsPerLiquidity::from_integer(2),
            Seconds::new(99),
        )
        .is_err();

        assert_eq!(failed, true);
    }

    #[test]
    fn test_calculate_reward_11() {
        //result should be less than 1 token
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(100_000),
            Seconds::new(0),
            Seconds::new(1637002223),
            Seconds::new(1640002223),
            Liquidity::from_integer(1_000_000),
            SecondsPerLiquidity::from_scale(4_000_000, 12),
            SecondsPerLiquidity::from_scale(10_000_000, 12),
            Seconds::new(1637002232),
        )
        .unwrap();
        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(6));
    }
    // test underflow
    #[test]
    fn test_calculate_reward_12() {
        //result should be less than 1 token
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(100_000),
            Seconds::new(0),
            Seconds::new(1637002223),
            Seconds::new(1640002223),
            Liquidity::from_integer(1_000_000),
            SecondsPerLiquidity::new(u128::MAX),
            SecondsPerLiquidity::from_scale(6_000_000, 12),
            Seconds::new(1637002232),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(6));
    }
    //zero seconds perLiquidity
    #[test]
    fn test_calculate_reward_13() {
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(100_000),
            Seconds::new(0),
            Seconds::new(1637002223),
            Seconds::new(1640002223),
            Liquidity::from_integer(1_000_000),
            SecondsPerLiquidity::new(6_000_000),
            SecondsPerLiquidity::new(6_000_000),
            Seconds::new(1637002232),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(0));
        assert_eq!(seconds_inside, Seconds::new(0));
    }

    //data from real case
    #[test]
    fn test_calculate_reward_14() {
        let (seconds_inside, result) = calculate_reward(
            TokenAmount::new(2388706726),
            Seconds::new(676842),
            Seconds::new(1660469274),
            Seconds::new(1661765264),
            Liquidity::from_scale(97003457938114000000_u128, 12),
            SecondsPerLiquidity::new(340282366920938463463374607431768211446),
            SecondsPerLiquidity::new(2),
            Seconds::new(1661334904),
        )
        .unwrap();

        assert_eq!(result, TokenAmount::new(4490775));
        assert_eq!(seconds_inside, Seconds::new(1164));
    }
}
