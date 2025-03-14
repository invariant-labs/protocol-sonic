import { assert } from 'chai'
import { calculatePriceSqrt, MAX_TICK, MIN_TICK } from '@invariant-labs/sdk'
import { alignTickToSpacing, priceToTickInRange } from '@invariant-labs/sdk/src/tick'

describe('Ticks test', () => {
  describe('test all positive ticks', () => {
    it('positive ticks', () => {
      const tickSpacing = 1
      for (let n = 0; n < MAX_TICK; n++) {
        const expectedTick = n
        const sqrtPriceDecimal = calculatePriceSqrt(expectedTick)

        const tickAtPrice = priceToTickInRange(sqrtPriceDecimal, MIN_TICK, MAX_TICK, tickSpacing)
        assert.equal(tickAtPrice, expectedTick)

        const tickAbovePrice = priceToTickInRange(
          sqrtPriceDecimal.subn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickAbovePrice, expectedTick - 1)

        const tickBelowPrice = priceToTickInRange(
          sqrtPriceDecimal.addn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickBelowPrice, expectedTick)
      }
    })
  })
  describe('test all negative ticks', () => {
    it('positive ticks', () => {
      const tickSpacing = 1
      for (let n = 0; n < MAX_TICK; n++) {
        const expectedTick = -n
        const sqrtPriceDecimal = calculatePriceSqrt(expectedTick)

        const tickAtPrice = priceToTickInRange(sqrtPriceDecimal, MIN_TICK, MAX_TICK, tickSpacing)
        assert.equal(tickAtPrice, expectedTick)

        const tickAbovePrice = priceToTickInRange(
          sqrtPriceDecimal.subn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickAbovePrice, expectedTick - 1)

        const tickBelowPrice = priceToTickInRange(
          sqrtPriceDecimal.addn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickBelowPrice, expectedTick)
      }
    })
  })
  describe('test all positive ticks greater than 1', () => {
    it('positive ticks', () => {
      const tickSpacing = 3
      for (let n = 0; n < MAX_TICK - 1; n++) {
        const tick = n
        const sqrtPriceDecimal = calculatePriceSqrt(tick)

        // get tick at sqrt(1.0001^(n))
        const expectedTick = alignTickToSpacing(tick, tickSpacing)
        const tickAtPrice = priceToTickInRange(sqrtPriceDecimal, MIN_TICK, MAX_TICK, tickSpacing)

        assert.equal(tickAtPrice, expectedTick)

        // get tick slightly below sqrt(1.0001^n)
        const expectedTickAbove = alignTickToSpacing(tick - 1, tickSpacing)
        const tickAbovePrice = priceToTickInRange(
          sqrtPriceDecimal.subn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickAbovePrice, expectedTickAbove)

        // get tick slightly above sqrt(1.0001^n)
        const expectedTickBelow = alignTickToSpacing(tick, tickSpacing)
        const tickBelowPrice = priceToTickInRange(
          sqrtPriceDecimal.addn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickBelowPrice, expectedTickBelow)
      }
    })
  })
  describe('test all negative ticks greater than 1', () => {
    it('positive ticks', () => {
      const tickSpacing = 4
      for (let n = 0; n < MAX_TICK; n++) {
        const tick = -n
        const sqrtPriceDecimal = calculatePriceSqrt(tick)

        // get tick at sqrt(1.0001^(n))
        const expectedTick = alignTickToSpacing(tick, tickSpacing)
        const tickAtPrice = priceToTickInRange(sqrtPriceDecimal, MIN_TICK, MAX_TICK, tickSpacing)
        assert.equal(tickAtPrice, expectedTick)

        // get tick slightly below sqrt(1.0001^n)
        const expectedTickAbove = alignTickToSpacing(tick - 1, tickSpacing)
        const tickAbovePrice = priceToTickInRange(
          sqrtPriceDecimal.subn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickAbovePrice, expectedTickAbove)

        // get tick slightly above sqrt(1.0001^n)
        const expectedTickBelow = alignTickToSpacing(tick, tickSpacing)
        const tickBelowPrice = priceToTickInRange(
          sqrtPriceDecimal.addn(1),
          MIN_TICK,
          MAX_TICK,
          tickSpacing
        )
        assert.equal(tickBelowPrice, expectedTickBelow)
      }
    })
  })
})
