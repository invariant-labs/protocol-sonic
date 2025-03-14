import { BN } from '@coral-xyz/anchor'
import { assert } from 'chai'
import { Tick, Tickmap } from './market'
import {
  DECIMAL,
  DENOMINATOR,
  getMaxTick,
  getMinTick,
  LIQUIDITY_DENOMINATOR,
  LIQUIDITY_SCALE,
  PRICE_DENOMINATOR,
  PRICE_SCALE
} from './utils'

export const TICK_LIMIT = 44_364
export const MAX_TICK = 221_818
export const MIN_TICK = -MAX_TICK
export const TICK_SEARCH_RANGE = 256

export const U64_MAX = new BN('18446744073709551615')

export interface SwapResult {
  nextPrice: BN
  amountIn: BN
  amountOut: BN
  feeAmount: BN
}

export const isInitialized = (tickmap: Tickmap, index: number, tickSpacing: number) => {
  if (index % tickSpacing !== 0) {
    throw Error("invalid arguments can't check tick")
  }
  const toIndex = Math.floor(index / tickSpacing) + TICK_LIMIT
  const byte = Math.floor(toIndex / 8)
  const bit = Math.floor(toIndex % 8)

  const value = tickmap.bitmap[byte] & (1 << bit)

  return value !== 0
}
export const priceToTick = (val: number): number => {
  return Math.log(val) / Math.log(1.0001)
}

export const fromInteger = (integer: number): BN => {
  return new BN(integer).mul(DENOMINATOR)
}

export const calculatePriceSqrt = (tickIndex: number): BN => {
  const tick = Math.abs(tickIndex)
  if (tick > MAX_TICK) {
    throw Error('tick over bounds')
  }
  let price = new BN(DENOMINATOR)

  if ((tick & 0x1) !== 0) price = price.mul(new BN('1000049998750')).div(DENOMINATOR)
  if ((tick & 0x2) !== 0) price = price.mul(new BN('1000100000000')).div(DENOMINATOR)
  if ((tick & 0x4) !== 0) price = price.mul(new BN('1000200010000')).div(DENOMINATOR)
  if ((tick & 0x8) !== 0) price = price.mul(new BN('1000400060004')).div(DENOMINATOR)
  if ((tick & 0x10) !== 0) price = price.mul(new BN('1000800280056')).div(DENOMINATOR)
  if ((tick & 0x20) !== 0) price = price.mul(new BN('1001601200560')).div(DENOMINATOR)
  if ((tick & 0x40) !== 0) price = price.mul(new BN('1003204964963')).div(DENOMINATOR)
  if ((tick & 0x80) !== 0) price = price.mul(new BN('1006420201726')).div(DENOMINATOR)
  if ((tick & 0x100) !== 0) price = price.mul(new BN('1012881622442')).div(DENOMINATOR)
  if ((tick & 0x200) !== 0) price = price.mul(new BN('1025929181080')).div(DENOMINATOR)
  if ((tick & 0x400) !== 0) price = price.mul(new BN('1052530684591')).div(DENOMINATOR)
  if ((tick & 0x800) !== 0) price = price.mul(new BN('1107820842005')).div(DENOMINATOR)
  if ((tick & 0x1000) !== 0) price = price.mul(new BN('1227267017980')).div(DENOMINATOR)
  if ((tick & 0x2000) !== 0) price = price.mul(new BN('1506184333421')).div(DENOMINATOR)
  if ((tick & 0x4000) !== 0) price = price.mul(new BN('2268591246242')).div(DENOMINATOR)
  if ((tick & 0x8000) !== 0) price = price.mul(new BN('5146506242525')).div(DENOMINATOR)
  if ((tick & 0x10000) !== 0) price = price.mul(new BN('26486526504348')).div(DENOMINATOR)
  if ((tick & 0x20000) !== 0) price = price.mul(new BN('701536086265529')).div(DENOMINATOR)

  if (tickIndex < 0) {
    return DENOMINATOR.mul(DENOMINATOR)
      .div(price)
      .mul(new BN(10).pow(new BN(PRICE_SCALE - DECIMAL)))
  }

  return price.mul(new BN(10).pow(new BN(PRICE_SCALE - DECIMAL)))
}

export const sqrt = (num: BN): BN => {
  if (num.lt(new BN(0))) {
    throw new Error('Sqrt only works on non-negative inputs')
  }
  if (num.lt(new BN(2))) {
    return num
  }

  const smallCand = sqrt(num.shrn(2)).shln(1)
  const largeCand = smallCand.add(new BN(1))

  if (largeCand.mul(largeCand).gt(num)) {
    return smallCand
  } else {
    return largeCand
  }
}

export const calculatePriceAfterSlippage = (priceSqrt: BN, slippage: BN, up: boolean): BN => {
  // using sqrt of slippage, because price is a sqrt
  const multiplier = up ? slippage.add(DENOMINATOR) : DENOMINATOR.sub(slippage)
  const slippageSqrt = sqrt(multiplier.mul(DENOMINATOR))

  return priceSqrt.mul(slippageSqrt).div(DENOMINATOR)
}

export const calculateSwapStep = (
  currentPrice: BN,
  targetPrice: BN,
  liquidity: BN,
  amount: BN,
  byAmountIn: boolean,
  fee: BN
): SwapResult => {
  if (liquidity.eqn(0)) {
    return {
      nextPrice: targetPrice,
      amountIn: new BN(0),
      amountOut: new BN(0),
      feeAmount: new BN(0)
    }
  }

  const aToB = currentPrice.gte(targetPrice)

  let nextPrice: BN = new BN(0)
  let amountIn: BN = new BN(0)
  let amountOut: BN = new BN(0)
  let feeAmount: BN = new BN(0)

  if (byAmountIn) {
    const amountAfterFee: BN = fromInteger(1).sub(fee).mul(amount).div(DENOMINATOR)
    if (aToB) {
      amountIn = getDeltaX(targetPrice, currentPrice, liquidity, true) ?? U64_MAX
    } else {
      amountIn = getDeltaY(targetPrice, currentPrice, liquidity, true) ?? U64_MAX
    }
    if (amountAfterFee.gte(amountIn)) {
      nextPrice = targetPrice
    } else {
      nextPrice = getNextPriceFromInput(currentPrice, liquidity, amountAfterFee, aToB)
    }
  } else {
    if (aToB) {
      amountOut = getDeltaY(targetPrice, currentPrice, liquidity, false) ?? U64_MAX
    } else {
      amountOut = getDeltaX(currentPrice, targetPrice, liquidity, false) ?? U64_MAX
    }
    if (amount.gte(amountOut)) {
      nextPrice = targetPrice
    } else {
      nextPrice = getNextPriceFromOutput(currentPrice, liquidity, amount, aToB)
    }
  }

  const max = targetPrice.eq(nextPrice)

  if (aToB) {
    // TODO: refactor "as BN" casting
    if (!(max && byAmountIn)) {
      amountIn = getDeltaX(nextPrice, currentPrice, liquidity, true) as BN
    }
    if (!(max && !byAmountIn)) {
      amountOut = getDeltaY(nextPrice, currentPrice, liquidity, false) as BN
    }
  } else {
    if (!(max && byAmountIn)) {
      amountIn = getDeltaY(currentPrice, nextPrice, liquidity, true) as BN
    }
    if (!(max && !byAmountIn)) {
      amountOut = getDeltaX(currentPrice, nextPrice, liquidity, false) as BN
    }
  }

  if (amountIn === null || amountOut === null) throw new Error('Amount would be greater than u64')

  if (!byAmountIn && amountOut.gt(amount)) {
    amountOut = amount
  }

  if (byAmountIn && !nextPrice.eq(targetPrice)) {
    feeAmount = amount.sub(amountIn)
  } else {
    feeAmount = amountIn.mul(fee).add(DENOMINATOR.subn(1)).div(DENOMINATOR)
  }

  return {
    nextPrice,
    amountIn,
    amountOut,
    feeAmount
  }
}

export const getDeltaX = (priceA: BN, priceB: BN, liquidity: BN, up: boolean): BN | null => {
  let deltaPrice: BN
  if (priceA.gt(priceB)) {
    deltaPrice = priceA.sub(priceB)
  } else {
    deltaPrice = priceB.sub(priceA)
  }

  const nominator: BN = liquidity.mul(deltaPrice).div(LIQUIDITY_DENOMINATOR)

  if (up) {
    const denominatorUp: BN = priceA.mul(priceB).div(PRICE_DENOMINATOR)
    const result = nominator
      .mul(PRICE_DENOMINATOR)
      .add(denominatorUp.subn(1))
      .div(denominatorUp)
      .add(PRICE_DENOMINATOR.subn(1))
      .div(PRICE_DENOMINATOR)
    return result.lte(U64_MAX) ? result : null
  } else {
    const denominatorDown: BN = priceA
      .mul(priceB)
      .add(PRICE_DENOMINATOR.subn(1))
      .div(PRICE_DENOMINATOR)
    const result = nominator.mul(PRICE_DENOMINATOR).div(denominatorDown).div(PRICE_DENOMINATOR)
    return result.lte(U64_MAX) ? result : null
  }
}

export const getDeltaY = (priceA: BN, priceB: BN, liquidity: BN, up: boolean): BN | null => {
  let deltaPrice: BN
  if (priceA.gt(priceB)) {
    deltaPrice = priceA.sub(priceB)
  } else {
    deltaPrice = priceB.sub(priceA)
  }

  if (up) {
    const result = deltaPrice
      .mul(liquidity)
      .add(LIQUIDITY_DENOMINATOR.subn(1))
      .div(LIQUIDITY_DENOMINATOR)
      .add(PRICE_DENOMINATOR.subn(1))
      .div(PRICE_DENOMINATOR)
    return result.lte(U64_MAX) ? result : null
  } else {
    const result = deltaPrice.mul(liquidity).div(LIQUIDITY_DENOMINATOR).div(PRICE_DENOMINATOR)
    return result.lte(U64_MAX) ? result : null
  }
}

const getNextPriceFromInput = (price: BN, liquidity: BN, amount: BN, aToB: boolean): BN => {
  assert.isTrue(price.gt(new BN(0)))
  assert.isTrue(liquidity.gt(new BN(0)))

  if (aToB) {
    return getNextPriceXUp(price, liquidity, amount, true)
  } else {
    return getNextPriceYDown(price, liquidity, amount, true)
  }
}

const getNextPriceFromOutput = (price: BN, liquidity: BN, amount: BN, aToB: boolean): BN => {
  assert.isTrue(price.gt(new BN(0)))
  assert.isTrue(liquidity.gt(new BN(0)))

  if (aToB) {
    return getNextPriceYDown(price, liquidity, amount, false)
  } else {
    return getNextPriceXUp(price, liquidity, amount, false)
  }
}

// L * price / (L +- amount * price)
export const getNextPriceXUp = (price: BN, liquidity: BN, amount: BN, add: boolean): BN => {
  if (amount.eqn(0)) {
    return price
  }

  const bigLiquidity: BN = liquidity.mul(new BN(10).pow(new BN(PRICE_SCALE - LIQUIDITY_SCALE)))
  const priceMulAmount: BN = price.mul(amount)

  let denominator: BN
  if (add) {
    denominator = bigLiquidity.add(priceMulAmount)
  } else {
    denominator = bigLiquidity.sub(priceMulAmount)
  }

  const nominator: BN = price
    .mul(liquidity)
    .add(LIQUIDITY_DENOMINATOR.subn(1))
    .div(LIQUIDITY_DENOMINATOR)
  return nominator.mul(PRICE_DENOMINATOR).add(denominator.subn(1)).div(denominator)
}

// price +- (amount / L)
export const getNextPriceYDown = (price: BN, liquidity: BN, amount: BN, add: boolean): BN => {
  let quotient: BN

  if (add) {
    quotient = amount
      .mul(PRICE_DENOMINATOR)
      .mul(PRICE_DENOMINATOR)
      .div(liquidity.mul(new BN(10).pow(new BN(PRICE_SCALE - LIQUIDITY_SCALE))))
    return price.add(quotient)
  } else {
    quotient = amount
      .mul(PRICE_DENOMINATOR)
      .mul(PRICE_DENOMINATOR)
      .add(liquidity.mul(new BN(10).pow(new BN(PRICE_SCALE - LIQUIDITY_SCALE))).subn(1))
      .div(liquidity.mul(new BN(10).pow(new BN(PRICE_SCALE - LIQUIDITY_SCALE))))
    return price.sub(quotient)
  }
}

export const findClosestTicks = (
  ticks: number[],
  current: number,
  tickSpacing: number,
  limit: number,
  maxRange: number = Infinity,
  oneWay: 'up' | 'down' | undefined = undefined
) => {
  if (current % tickSpacing !== 0) {
    throw Error("invalid arguments can't find initialized ticks")
  }

  const currentIndex = Math.floor(current / tickSpacing) + TICK_LIMIT

  let above = currentIndex + 1
  let below = currentIndex

  const found: number[] = []

  let reachedTop = oneWay === 'down'
  let reachedBottom = oneWay === 'up'

  while (found.length < limit && above - below < maxRange * 2) {
    if (!reachedTop) {
      const valueAbove = ticks[Math.floor(above / 8)] & (1 << above % 8)
      if (valueAbove) found.push(above)
      reachedTop = above >= 2 * TICK_LIMIT
      above++
    }
    if (!reachedBottom) {
      const valueBelow = ticks[Math.floor(below / 8)] & (1 << below % 8)
      if (valueBelow) found.unshift(below)
      reachedBottom = below < 0
      below--
    }

    if (reachedTop && reachedBottom) {
      break
    }
  }

  // two can be added in the last iteration
  if (found.length > limit) found.pop()

  return found.map(i => (i - TICK_LIMIT) * tickSpacing)
}

const mulUp = (a: BN, b: BN) => {
  return a.mul(b).add(PRICE_DENOMINATOR.subn(1)).div(PRICE_DENOMINATOR)
}

const divUp = (a: BN, b: BN) => {
  return a.add(b).subn(1).div(b)
}

const calculateY = (priceDiff: BN, liquidity: BN, roundingUp: boolean) => {
  const shiftedLiquidity = liquidity.div(LIQUIDITY_DENOMINATOR)

  if (roundingUp) {
    return mulUp(priceDiff, shiftedLiquidity)
  }
  return priceDiff.mul(shiftedLiquidity).div(PRICE_DENOMINATOR)
}

const calculateX = (nominator: BN, denominator: BN, liquidity: BN, roundingUp: boolean) => {
  const common = liquidity.mul(nominator).div(denominator)
  if (roundingUp) {
    return divUp(common, LIQUIDITY_DENOMINATOR)
  }
  return common.div(LIQUIDITY_DENOMINATOR)
}

export const getX = (
  liquidity: BN,
  upperSqrtPrice: BN,
  currentSqrtPrice: BN,
  lowerSqrtPrice: BN
): BN => {
  if (
    upperSqrtPrice.lte(new BN(0)) ||
    currentSqrtPrice.lte(new BN(0)) ||
    lowerSqrtPrice.lte(new BN(0))
  ) {
    throw new Error('Price cannot be lower or equal 0')
  }

  let denominator: BN
  let nominator: BN

  if (currentSqrtPrice.gte(upperSqrtPrice)) {
    return new BN(0)
  } else if (currentSqrtPrice.lt(lowerSqrtPrice)) {
    denominator = lowerSqrtPrice.mul(upperSqrtPrice).div(PRICE_DENOMINATOR)
    nominator = upperSqrtPrice.sub(lowerSqrtPrice)
  } else {
    denominator = upperSqrtPrice.mul(currentSqrtPrice).div(PRICE_DENOMINATOR)
    nominator = upperSqrtPrice.sub(currentSqrtPrice)
  }

  return liquidity.mul(nominator).div(denominator).div(LIQUIDITY_DENOMINATOR)
}

export const getXfromLiquidity = (liquidity: BN, upperSqrtPrice: BN, lowerSqrtPrice: BN): BN => {
  if (upperSqrtPrice.lte(new BN(0)) || lowerSqrtPrice.lte(new BN(0))) {
    throw new Error('Price cannot be lower or equal 0')
  }

  const denominator = lowerSqrtPrice.mul(upperSqrtPrice).div(PRICE_DENOMINATOR)
  const nominator = upperSqrtPrice.sub(lowerSqrtPrice)

  return liquidity.mul(nominator).div(denominator).div(LIQUIDITY_DENOMINATOR)
}

export const getY = (
  liquidity: BN,
  upperSqrtPrice: BN,
  currentSqrtPrice: BN,
  lowerSqrtPrice: BN
): BN => {
  if (
    lowerSqrtPrice.lte(new BN(0)) ||
    currentSqrtPrice.lte(new BN(0)) ||
    upperSqrtPrice.lte(new BN(0))
  ) {
    throw new Error('Price cannot be 0')
  }

  let difference: BN
  if (currentSqrtPrice.lt(lowerSqrtPrice)) {
    return new BN(0)
  } else if (currentSqrtPrice.gte(upperSqrtPrice)) {
    difference = upperSqrtPrice.sub(lowerSqrtPrice)
  } else {
    difference = currentSqrtPrice.sub(lowerSqrtPrice)
  }

  return liquidity.mul(difference).div(PRICE_DENOMINATOR).div(LIQUIDITY_DENOMINATOR)
}

export const getLiquidity = (
  x: BN,
  y: BN,
  lowerTick: number,
  upperTick: number,
  currentSqrtPrice: BN,
  roundingUp: boolean,
  tickSpacing?: number
): {
  x: BN
  y: BN
  liquidity: BN
} => {
  if ((lowerTick === -Infinity || upperTick === Infinity) && tickSpacing === undefined) {
    throw new Error('tickSpacing is required for calculating full range liquidity')
  }

  const lowerTickIndex = lowerTick !== -Infinity ? lowerTick : getMinTick(tickSpacing as number)
  const upperTickIndex = upperTick !== Infinity ? upperTick : getMaxTick(tickSpacing as number)

  const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)

  if (upperSqrtPrice.lt(currentSqrtPrice)) {
    // single token y
    return {
      ...getLiquidityByYPrice(y, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, roundingUp),
      y
    }
  } else if (currentSqrtPrice.lt(lowerSqrtPrice)) {
    // single token x
    return {
      ...getLiquidityByXPrice(x, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, roundingUp),
      x
    }
  }

  const { liquidity: liquidityByY, x: _estimatedX } = getLiquidityByYPrice(
    y,
    lowerSqrtPrice,
    upperSqrtPrice,
    currentSqrtPrice,
    roundingUp
  )
  const { liquidity: liquidityByX, y: _estimatedY } = getLiquidityByXPrice(
    x,
    lowerSqrtPrice,
    upperSqrtPrice,
    currentSqrtPrice,
    roundingUp
  )
  return {
    x,
    y,
    liquidity: liquidityByY.lt(liquidityByX) ? liquidityByY : liquidityByX
  }
}

export const getLiquidityByX = (
  x: BN,
  lowerTick: number,
  upperTick: number,
  currentSqrtPrice: BN,
  roundingUp: boolean,
  tickSpacing?: number
) => {
  if ((lowerTick === -Infinity || upperTick === Infinity) && tickSpacing === undefined) {
    throw new Error('tickSpacing is required for calculating full range liquidity')
  }

  const lowerTickIndex = lowerTick !== -Infinity ? lowerTick : getMinTick(tickSpacing as number)
  const upperTickIndex = upperTick !== Infinity ? upperTick : getMaxTick(tickSpacing as number)

  const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)

  return getLiquidityByXPrice(x, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, roundingUp)
}

export const getLiquidityByXPrice = (
  x: BN,
  lowerSqrtPrice: BN,
  upperSqrtPrice: BN,
  currentSqrtPrice: BN,
  roundingUp: boolean
): {
  liquidity: BN
  y: BN
} => {
  if (upperSqrtPrice.lt(currentSqrtPrice)) {
    throw new Error('liquidity cannot be determined')
  }

  if (currentSqrtPrice.lt(lowerSqrtPrice)) {
    const nominator = lowerSqrtPrice.mul(upperSqrtPrice).div(PRICE_DENOMINATOR)
    const denominator = upperSqrtPrice.sub(lowerSqrtPrice)
    const liquidity = x.mul(nominator).mul(LIQUIDITY_DENOMINATOR).div(denominator)

    return {
      liquidity: liquidity,
      y: new BN(0)
    }
  }

  const nominator = currentSqrtPrice.mul(upperSqrtPrice).div(PRICE_DENOMINATOR)
  const denominator = upperSqrtPrice.sub(currentSqrtPrice)
  const liquidity = x.mul(nominator).div(denominator).mul(LIQUIDITY_DENOMINATOR)
  const priceDiff = currentSqrtPrice.sub(lowerSqrtPrice)
  const y = calculateY(priceDiff, liquidity, roundingUp)

  return {
    liquidity: liquidity,
    y
  }
}

export const getLiquidityByY = (
  y: BN,
  lowerTick: number,
  upperTick: number,
  currentSqrtPrice: BN,
  roundingUp: boolean,
  tickSpacing?: number
) => {
  if ((lowerTick === -Infinity || upperTick === Infinity) && tickSpacing === undefined) {
    throw new Error('tickSpacing is required for calculating full range liquidity')
  }

  const lowerTickIndex = lowerTick !== -Infinity ? lowerTick : getMinTick(tickSpacing as number)
  const upperTickIndex = upperTick !== Infinity ? upperTick : getMaxTick(tickSpacing as number)

  const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)

  return getLiquidityByYPrice(y, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, roundingUp)
}

export const getLiquidityByYPrice = (
  y: BN,
  lowerSqrtPrice: BN,
  upperSqrtPrice: BN,
  currentSqrtPrice: BN,
  roundingUp: boolean
): { liquidity: BN; x: BN } => {
  if (currentSqrtPrice.lt(lowerSqrtPrice)) {
    throw new Error('liquidity cannot be determined')
  }

  if (upperSqrtPrice.lte(currentSqrtPrice)) {
    const priceDiff = upperSqrtPrice.sub(lowerSqrtPrice)
    const liquidity = y.mul(LIQUIDITY_DENOMINATOR).mul(PRICE_DENOMINATOR).div(priceDiff)

    return {
      liquidity: liquidity,
      x: new BN(0)
    }
  }

  const priceDiff = currentSqrtPrice.sub(lowerSqrtPrice)
  const liquidity = y.mul(LIQUIDITY_DENOMINATOR).mul(PRICE_DENOMINATOR).div(priceDiff)
  const denominator = currentSqrtPrice.mul(upperSqrtPrice).div(PRICE_DENOMINATOR)
  const nominator = upperSqrtPrice.sub(currentSqrtPrice)
  const x = calculateX(nominator, denominator, liquidity, roundingUp)

  return {
    liquidity,
    x
  }
}

export const getMaxLiquidity = (
  x: BN,
  y: BN,
  tickLower: number,
  tickUpper: number,
  currentSqrtPrice: BN
) => {
  assert(tickLower < tickUpper)
  const lowerSqrtPrice = calculatePriceSqrt(tickLower)
  const upperSqrtPrice = calculatePriceSqrt(tickUpper)

  if (upperSqrtPrice.lte(currentSqrtPrice)) {
    return { ...getLiquidityByYPrice(y, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, true), y }
  }
  if (currentSqrtPrice.lte(lowerSqrtPrice)) {
    return { ...getLiquidityByXPrice(x, lowerSqrtPrice, upperSqrtPrice, currentSqrtPrice, true), x }
  }

  const liquidityByY = getLiquidityByYPrice(
    y,
    lowerSqrtPrice,
    upperSqrtPrice,
    currentSqrtPrice,
    true
  )
  const liquidityByX = getLiquidityByXPrice(
    x,
    lowerSqrtPrice,
    upperSqrtPrice,
    currentSqrtPrice,
    true
  )

  if (liquidityByX.liquidity.gt(liquidityByY.liquidity)) {
    if (liquidityByX.y.lte(y)) {
      return {
        ...liquidityByX,
        x
      }
    } else {
      return {
        ...liquidityByY,
        y
      }
    }
  } else {
    if (liquidityByY.x.lte(x)) {
      return {
        ...liquidityByY,
        y
      }
    } else {
      return {
        ...liquidityByX,
        x
      }
    }
  }
}

export const getMaxLiquidityWithPercentage = (
  x: BN,
  y: BN,
  tickLower: number,
  tickUpper: number,
  currentSqrtPrice: BN,
  maxLiquidityPercentage: BN
) => {
  const { x: xMax, y: yMax } = getMaxLiquidity(x, y, tickLower, tickUpper, currentSqrtPrice)

  const xPercentage = xMax.mul(maxLiquidityPercentage).div(DENOMINATOR)
  const yPercentage = yMax.mul(maxLiquidityPercentage).div(DENOMINATOR)

  return getMaxLiquidity(xPercentage, yPercentage, tickLower, tickUpper, currentSqrtPrice)
}

export const calculateFeeGrowthInside = (
  lowerTick: Tick,
  upperTick: Tick,
  currentTick: number,
  feeGrowthGlobalX: BN,
  feeGrowthGlobalY: BN
): [BN, BN] => {
  const currentAboveLower = currentTick >= lowerTick.index
  const currentBelowUpper = currentTick < upperTick.index

  let feeGrowthBelowX: BN
  let feeGrowthBelowY: BN
  if (currentAboveLower) {
    feeGrowthBelowX = lowerTick.feeGrowthOutsideX
    feeGrowthBelowY = lowerTick.feeGrowthOutsideY
  } else {
    feeGrowthBelowX = feeGrowthGlobalX.sub(lowerTick.feeGrowthOutsideX)
    feeGrowthBelowY = feeGrowthGlobalY.sub(lowerTick.feeGrowthOutsideY)
  }

  let feeGrowthAboveX: BN
  let feeGrowthAboveY: BN
  if (currentBelowUpper) {
    feeGrowthAboveX = upperTick.feeGrowthOutsideX
    feeGrowthAboveY = upperTick.feeGrowthOutsideY
  } else {
    feeGrowthAboveX = feeGrowthGlobalX.sub(upperTick.feeGrowthOutsideX)
    feeGrowthAboveY = feeGrowthGlobalY.sub(upperTick.feeGrowthOutsideY)
  }

  const feeGrowthInsideX: BN = feeGrowthGlobalX.sub(feeGrowthBelowX).sub(feeGrowthAboveX)

  const feeGrowthInsideY: BN = feeGrowthGlobalY.sub(feeGrowthBelowY).sub(feeGrowthAboveY)

  return [feeGrowthInsideX, feeGrowthInsideY]
}

export const isEnoughAmountToPushPrice = (
  amount: BN,
  currentPriceSqrt: BN,
  liquidity: BN,
  fee: BN,
  byAmountIn: boolean,
  aToB: boolean
) => {
  if (liquidity.eqn(0)) {
    return true
  }

  let nextSqrtPrice: BN

  if (byAmountIn) {
    const amountAfterFee: BN = fromInteger(1).sub(fee).mul(amount).div(DENOMINATOR)
    nextSqrtPrice = getNextPriceFromInput(currentPriceSqrt, liquidity, amountAfterFee, aToB)
  } else {
    nextSqrtPrice = getNextPriceFromOutput(currentPriceSqrt, liquidity, amount, aToB)
  }

  return !currentPriceSqrt.eq(nextSqrtPrice)
}

export const calculatePriceImpact = (startingSqrtPrice: BN, endingSqrtPrice: BN): BN => {
  const startingPrice = startingSqrtPrice.mul(startingSqrtPrice)
  const endingPrice = endingSqrtPrice.mul(endingSqrtPrice)
  let priceQuotient
  if (endingPrice.gte(startingPrice)) {
    priceQuotient = DENOMINATOR.mul(startingPrice).div(endingPrice)
  } else {
    priceQuotient = DENOMINATOR.mul(endingPrice).div(startingPrice)
  }
  return DENOMINATOR.sub(priceQuotient)
}

export const calculateMinReceivedTokensByAmountIn = (
  targetSqrtPrice: BN,
  xToY: boolean,
  amountIn: BN,
  fee: BN
) => {
  const targetPrice = targetSqrtPrice.mul(targetSqrtPrice)
  let amountOut: BN
  if (xToY) {
    amountOut = amountIn.mul(targetPrice).div(PRICE_DENOMINATOR).div(PRICE_DENOMINATOR)
  } else {
    amountOut = amountIn.mul(PRICE_DENOMINATOR).mul(PRICE_DENOMINATOR).div(targetPrice)
  }
  return DENOMINATOR.sub(fee).mul(amountOut).div(DENOMINATOR)
}
