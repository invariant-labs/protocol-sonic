import { AnchorProvider, BN, utils, web3 } from '@coral-xyz/anchor'
import * as anchor from '@coral-xyz/anchor'
import {
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  getAccount,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { TokenInfo, TokenListContainer, TokenListProvider } from '@solana/spl-token-registry'
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  BlockheightBasedTransactionConfirmationStrategy,
  ComputeBudgetProgram,
  ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionSignature
} from '@solana/web3.js'
import { calculatePriceSqrt, Market, MAX_TICK, Pair, TICK_LIMIT } from '.'
import {
  Errors,
  TICK_CROSSES_PER_IX,
  TICK_VIRTUAL_CROSSES_PER_IX,
  FEE_TIER,
  FeeTier,
  PoolData,
  PoolStructure,
  PositionInitData,
  Tick,
  Tickmap,
  RemovePositionEvent,
  CreatePositionEvent,
  SwapEvent,
  CreatePosition
} from './market'
import {
  calculateMinReceivedTokensByAmountIn,
  calculatePriceAfterSlippage,
  calculatePriceImpact,
  calculateSwapStep,
  getLiquidityByX,
  getLiquidityByY,
  getMaxLiquidity,
  getXfromLiquidity,
  isEnoughAmountToPushPrice,
  MIN_TICK
} from './math'
import { alignTickToSpacing, getTickFromPrice } from './tick'
import { getNextTick, getPreviousTick, getSearchLimit } from './tickmap'
import { Network } from './network'
import { IdlEvent } from '@coral-xyz/anchor/dist/cjs/idl'
import rawTestnetCommonLookupTable from './data/testnet/commonLookupTable.json'
import rawTestnetPoolLookuTables from './data/testnet/poolsLookupTables.json'

export const SEED = 'Invariant'
export const DECIMAL = 12
export const LIQUIDITY_SCALE = 6
export const GROWTH_SCALE = 24
export const PRICE_SCALE = 24
export const FEE_DECIMAL = 5
export const DENOMINATOR = new BN(10).pow(new BN(DECIMAL))
export const LIQUIDITY_DENOMINATOR = new BN(10).pow(new BN(LIQUIDITY_SCALE))
export const PRICE_DENOMINATOR = new BN(10).pow(new BN(PRICE_SCALE))
export const GROWTH_DENOMINATOR = new BN(10).pow(new BN(GROWTH_SCALE))
export const FEE_OFFSET = new BN(10).pow(new BN(DECIMAL - FEE_DECIMAL))
export const FEE_DENOMINATOR = 10 ** FEE_DECIMAL
export const U128MAX = new BN('340282366920938463463374607431768211455')
export const CONCENTRATION_FACTOR = 1.00001526069123
export const PROTOCOL_FEE: number = 0.01
export const MIN_BALANCE_FOR_RENT_EXEMPT = {
  [Network.LOCAL]: 2039280, // AnchorProvider defaults to solana's minimum amount
  [Network.DEV]: 2039280,
  [Network.TEST]: 2039280,
  [Network.MAIN]: 2039280
}
export const MIN_BALANCE_FOR_TICKMAP_RENT_EXEMPT = {
  [Network.LOCAL]: 78139920, // AnchorProvider defaults to solana's minimum amount
  [Network.DEV]: 78139920,
  [Network.TEST]: 78139920,
  [Network.MAIN]: 78139920
}

export enum ERRORS {
  SIGNATURE = 'Error: Signature verification failed',
  SIGNER = 'Error: unknown signer',
  PANICKED = 'Program failed to complete',
  SERIALIZATION = '0xbbc',
  ALLOWANCE = 'custom program error: 0x1',
  NO_SIGNERS = 'Error: No signers',
  CONSTRAINT_RAW = '0x7d3',
  CONSTRAINT_SEEDS = '0x7d6',
  ACCOUNT_OWNED_BY_WRONG_PROGRAM = '0xbbf'
}

export enum INVARIANT_AUTOSWAP_ERRORS {
  SWAP_DISABLED = '0x1776',
  CREATE_POSITION_DISABLED = '0x1778'
}

export enum INVARIANT_ERRORS {
  ZERO_AMOUNT = '0x1770',
  ZERO_OUTPUT = '0x1771',
  WRONG_TICK = '0x1772',
  WRONG_LIMIT = '0x1773',
  INVALID_TICK_INDEX = '0x1774',
  INVALID_TICK_INTERVAL = '0x1775',
  NO_MORE_TICKS = '0x1776',
  TICK_NOT_FOUND = '0x1777',
  PRICE_LIMIT_REACHED = '0x1778',
  INVALID_TICK_LIQUIDITY = '0x1779',
  EMPTY_POSITION_POKES = '0x177a',
  INVALID_POSITION_LIQUIDITY = '0x177b',
  INVALID_POOL_LIQUIDITY = '0x177c',
  INVALID_POSITION_INDEX = '0x177d',
  POSITION_WITHOUT_LIQUIDITY = '0x177e',
  INVALID_POOL_TOKEN_ADDRESSES = '0x1780',
  NO_GAIN_SWAP = '0x1785',
  INVALID_TOKEN_ACCOUNT = '0x1786',
  INVALID_ADMIN = '0x1787',
  INVALID_AUTHORITY = '0x1788',
  INVALID_OWNER = '0x1789',
  INVALID_MINT = '0x178a',
  INVALID_TICKMAP = '0x178b',
  INVALID_TICKMAP_OWNER = '0x178c',
  INVALID_LIST_OWNER = '0x178d',
  INVALID_TICK_SPACING = '0x178e',
  DISABLED_POOL = '0x1791',
  UNSUPPORTED_EXTENSION = '0x1792'
}

export interface SimulateSwapPrice {
  xToY: boolean
  byAmountIn: boolean
  swapAmount: BN
  currentPrice: BN
  slippage: BN
  tickmap: Tickmap
  pool: PoolStructure
  market: Market
  pair: Pair
}

export interface SimulateSwapInterface {
  xToY: boolean
  byAmountIn: boolean
  swapAmount: BN
  priceLimit?: BN
  slippage: BN
  ticks: Map<number, Tick>
  tickmap: Tickmap
  pool: PoolData
  maxVirtualCrosses?: number
  maxCrosses?: number
}

export interface Simulation {
  xToY: boolean
  byAmountIn: boolean
  swapAmount: BN
  priceLimit: BN
  slippage: BN
  pool: PoolData
}

export interface SimulationResult {
  status: SimulationStatus
  amountPerTick: BN[]
  crossedTicks: number[]
  accumulatedAmountIn: BN
  accumulatedAmountOut: BN
  accumulatedFee: BN
  minReceived: BN
  priceImpact: BN
  priceAfterSwap: BN
}

export interface FeeGrowthInside {
  tickLower: Tick
  tickUpper: Tick
  tickCurrent: number
  feeGrowthGlobalX: BN
  feeGrowthGlobalY: BN
}

export interface TokensOwed {
  position: PositionClaimData
  feeGrowthInsideX: BN
  feeGrowthInsideY: BN
}

export interface SimulateClaim {
  position: PositionClaimData
  tickLower: Tick
  tickUpper: Tick
  tickCurrent: number
  feeGrowthGlobalX: BN
  feeGrowthGlobalY: BN
}
export interface PositionClaimData {
  liquidity: BN
  feeGrowthInsideX: BN
  feeGrowthInsideY: BN
  tokensOwedX: BN
  tokensOwedY: BN
}

export interface CloserLimit {
  sqrtPriceLimit: BN
  xToY: boolean
  currentTick: number
  tickSpacing: number
  tickmap: Tickmap
}

export interface TickState {
  index: number
  initialized: boolean
}
export interface CloserLimitResult {
  swapLimit: BN
  limitingTick: TickState | null
}

export const computeUnitsInstruction = (
  units: number,
  _wallet: PublicKey
): TransactionInstruction => {
  return ComputeBudgetProgram.setComputeUnitLimit({ units })
}
export async function assertThrowsAsync(fn: Promise<any>, word?: string) {
  try {
    await fn
  } catch (e: any) {
    let err
    if (e.code) {
      err = '0x' + e.code.toString(16)
    } else {
      err = e.toString()
    }
    if (word) {
      const regex = new RegExp(`${word}$`)
      if (!regex.test(err)) {
        console.log(err)
        throw new Error('Invalid Error message')
      }
    }
    return
  }
  throw new Error('Function did not throw error')
}

export const getBalance = async (
  connection: Connection,
  ata: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<BN> => {
  const acc = await getAccount(connection, ata, 'confirmed', programId)
  return new BN(acc.amount.toString())
}

export const getTokenProgramAddress = async (
  connection: Connection,
  tokenPubkey: PublicKey
): Promise<PublicKey> => {
  const info = await connection.getAccountInfo(tokenPubkey)
  if (!info) {
    return TOKEN_PROGRAM_ID
  }
  return info.owner
}

export const signAndSend = async (
  tx: Transaction,
  signers: Keypair[],
  connection: Connection,
  opts?: ConfirmOptions
): Promise<TransactionSignature> => {
  tx.feePayer ??= signers[0].publicKey

  const latestBlockhash = await connection.getLatestBlockhash(
    opts?.commitment ?? AnchorProvider.defaultOptions().commitment
  )
  tx.recentBlockhash = latestBlockhash.blockhash
  tx.partialSign(...signers)
  const signature = await connection.sendRawTransaction(
    tx.serialize(),
    opts ?? AnchorProvider.defaultOptions()
  )

  const confirmStrategy: BlockheightBasedTransactionConfirmationStrategy = {
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    signature
  }

  await connection.confirmTransaction(confirmStrategy)

  return signature
}

export const sleep = async (ms: number) => {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

export const arithmeticalAvg = <T extends BN>(...args: T[]): T => {
  if (args.length === 0) {
    throw new Error('requires at least one argument')
  }

  const sum = args.reduce((acc, val) => acc.add(val), new BN(0))
  return sum.divn(args.length) as T
}

export const weightedArithmeticAvg = <T extends BN>(...args: Array<{ val: T; weight: BN }>): T => {
  if (args.length === 0) {
    throw new Error('requires at least one argument')
  }
  const sumOfWeights = args.reduce((acc, { weight }) => acc.add(weight), new BN(0))
  const sum = args.reduce((acc, { val, weight }) => acc.add(val.mul(weight)), new BN(0))

  return sum.div(sumOfWeights) as T
}

export const tou64 = (amount: BN) => {
  return amount.toString()
}

export const fromFee = (fee: BN): BN => {
  // e.g fee - BN(1) -> 0.001%
  return fee.mul(FEE_OFFSET)
}

export const feeToTickSpacing = (fee: BN): number => {
  // linear relationship between fee and tickSpacing
  // tickSpacing = fee * 10^4
  if (fee.lte(fromFee(new BN(10)))) {
    return 1
  }

  const FEE_TO_SPACING_OFFSET = new BN(10).pow(new BN(DECIMAL - 4))
  return fee.div(FEE_TO_SPACING_OFFSET).toNumber()
}

export const FEE_TIERS: FeeTier[] = [
  { fee: fromFee(new BN(10)), tickSpacing: 1 },
  { fee: fromFee(new BN(20)), tickSpacing: 5 },
  { fee: fromFee(new BN(50)), tickSpacing: 5 },
  { fee: fromFee(new BN(100)), tickSpacing: 10 },
  { fee: fromFee(new BN(300)), tickSpacing: 30 },
  { fee: fromFee(new BN(1000)), tickSpacing: 100 }
]

export const generateTicksArray = (start: number, stop: number, step: number) => {
  const validDir = (start > stop && step < 0) || (start < stop && step > 0)
  const validMod = start % step === 0 && stop % step === 0

  if (!validDir || !validMod) {
    throw new Error('Invalid parameters')
  }

  const ticks: number[] = []
  for (let i = start; i <= stop; i += step) {
    ticks.push(i)
  }
  return ticks
}

export const getFeeTierAddress = ({ fee, tickSpacing }: FeeTier, programId: PublicKey) => {
  const ts = tickSpacing ?? feeToTickSpacing(fee)

  const [address, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from(utils.bytes.utf8.encode(FEE_TIER)),
      programId.toBuffer(),
      bigNumberToBuffer(fee, 128),
      bigNumberToBuffer(new BN(ts), 16)
    ],
    programId
  )

  return {
    address,
    bump
  }
}

export const toDecimal = (x: number, decimals: number = 0): BN => {
  return DENOMINATOR.muln(x).div(new BN(10).pow(new BN(decimals)))
}

export const toDecimalWithDenominator = (x: number, denominator: BN, decimals: number = 0) => {
  return denominator.muln(x).div(new BN(10).pow(new BN(decimals)))
}

export const calculateConcentration = (tickSpacing: number, minimumRange: number, n: number) => {
  const concentration = 1 / (1 - Math.pow(1.0001, (-tickSpacing * (minimumRange + 2 * n)) / 4))
  return concentration / CONCENTRATION_FACTOR
}

export const calculateTickDelta = (
  tickSpacing: number,
  minimumRange: number,
  concentration: number
) => {
  const base = Math.pow(1.0001, -(tickSpacing / 4))
  const logArg =
    (1 - 1 / (concentration * CONCENTRATION_FACTOR)) /
    Math.pow(1.0001, (-tickSpacing * minimumRange) / 4)

  return Math.ceil(Math.log(logArg) / Math.log(base) / 2)
}

export const getConcentrationArray = (
  tickSpacing: number,
  minimumRange: number,
  currentTick: number
): number[] => {
  const concentrations: number[] = []
  let counter = 0
  let concentration = 0
  let lastConcentration = calculateConcentration(tickSpacing, minimumRange, counter) + 1
  let concentrationDelta = 1

  while (concentrationDelta >= 1) {
    concentration = calculateConcentration(tickSpacing, minimumRange, counter)
    concentrations.push(concentration)
    concentrationDelta = lastConcentration - concentration
    lastConcentration = concentration
    counter++
  }
  concentration = Math.ceil(concentrations[concentrations.length - 1])

  while (concentration > 1) {
    concentrations.push(concentration)
    concentration--
  }
  const maxTick = alignTickToSpacing(MAX_TICK, tickSpacing)
  if ((minimumRange / 2) * tickSpacing > maxTick - Math.abs(currentTick)) {
    throw new Error(Errors.RangeLimitReached)
  }
  const limitIndex =
    (maxTick - Math.abs(currentTick) - (minimumRange / 2) * tickSpacing) / tickSpacing

  return concentrations.slice(0, limitIndex)
}

export const getPositionInitData = (
  tokenAmount: BN,
  tickSpacing: number,
  concentration: number,
  minimumRange: number,
  currentTick: number,
  currentPriceSqrt: BN,
  roundingUp: boolean,
  byAmountX: boolean
): PositionInitData => {
  let liquidity: BN
  let amountX: BN
  let amountY: BN
  const tickDelta = calculateTickDelta(tickSpacing, minimumRange, concentration)
  const lowerTick = currentTick - (tickDelta + minimumRange / 2) * tickSpacing
  const upperTick = currentTick + (tickDelta + minimumRange / 2) * tickSpacing

  if (byAmountX) {
    const result = getLiquidityByX(tokenAmount, lowerTick, upperTick, currentPriceSqrt, roundingUp)
    liquidity = result.liquidity
    amountX = tokenAmount
    amountY = result.y
  } else {
    const result = getLiquidityByY(tokenAmount, lowerTick, upperTick, currentPriceSqrt, roundingUp)

    liquidity = result.liquidity
    amountX = result.x
    amountY = tokenAmount
  }
  const positionData: PositionInitData = {
    lowerTick,
    upperTick,
    liquidity,
    amountX: amountX,
    amountY: amountY
  }

  return positionData
}

export const toPrice = (x: number, decimals: number = 0): BN => {
  return toDecimalWithDenominator(x, PRICE_DENOMINATOR, decimals)
}

export const toPercent = (x: number, decimals: number = 0): BN => {
  return toDecimalWithDenominator(x, DENOMINATOR, decimals)
}

export const getCloserLimit = (closerLimit: CloserLimit): CloserLimitResult => {
  const { sqrtPriceLimit, xToY, currentTick, tickSpacing, tickmap } = closerLimit

  let index: number | null = xToY
    ? getPreviousTick(tickmap, currentTick, tickSpacing)
    : getNextTick(tickmap, currentTick, tickSpacing)
  let sqrtPrice: BN
  let init: boolean

  if (index !== null) {
    sqrtPrice = calculatePriceSqrt(index)
    init = true
  } else {
    index = getSearchLimit(new BN(currentTick), new BN(tickSpacing), !xToY).toNumber()
    sqrtPrice = calculatePriceSqrt(index as number)
    init = false
  }
  if (xToY && sqrtPrice.gt(sqrtPriceLimit) && index !== null) {
    return { swapLimit: sqrtPrice, limitingTick: { index, initialized: init } }
  } else if (!xToY && sqrtPrice.lt(sqrtPriceLimit) && index !== null) {
    return { swapLimit: sqrtPrice, limitingTick: { index, initialized: init } }
  } else {
    return { swapLimit: sqrtPriceLimit, limitingTick: null }
  }
}

export enum SimulationStatus {
  Ok,
  WrongLimit = 'Price limit is on the wrong side of price',
  PriceLimitReached = 'Price would cross swap limit',
  TickNotFound = 'tick crossed but not passed to simulation',
  NoGainSwap = 'Amount out is zero',
  TooLargeGap = 'Too large liquidity gap',
  LimitReached = 'At the end of price range',
  SwapStepLimitReached = 'Swap step limit reached'
}

export const swapSimulation = async (
  xToY: boolean,
  byAmountIn: boolean,
  swapAmount: BN,
  priceLimit: BN | undefined,
  slippage: BN = new BN(0),
  market: Market,
  poolAddress: PublicKey,
  maxCrosses?: number,
  maxVirtualCrosses?: number
): Promise<SimulationResult> => {
  const { currentTickIndex, fee, tickSpacing, tokenX, tokenY, liquidity, sqrtPrice } =
    await market.getPoolByAddress(poolAddress)

  const feeTier: FeeTier = { fee: fee, tickSpacing }
  const pair: Pair = new Pair(tokenX, tokenY, feeTier)
  const tickmap = await market.getTickmap(pair)
  const allTicks = await market.getAllTicks(pair)

  const ticks: Map<number, Tick> = new Map()
  allTicks.forEach(tick => {
    ticks.set(tick.index, tick)
  })

  const poolData: PoolData = {
    currentTickIndex,
    tickSpacing,
    liquidity,
    fee,
    sqrtPrice
  }

  const swapParameters: SimulateSwapInterface = {
    xToY,
    byAmountIn,
    swapAmount,
    priceLimit,
    slippage,
    ticks,
    tickmap,
    pool: poolData,
    maxCrosses,
    maxVirtualCrosses
  }

  return simulateSwap(swapParameters)
}

export const simulateSwap = (swapParameters: SimulateSwapInterface): SimulationResult => {
  const {
    xToY,
    byAmountIn,
    swapAmount,
    slippage,
    ticks,
    tickmap,
    priceLimit: optionalPriceLimit,
    pool
  } = swapParameters
  let maxCrosses = swapParameters.maxCrosses ?? TICK_CROSSES_PER_IX
  let maxVirtualCrosses = swapParameters.maxVirtualCrosses ?? TICK_VIRTUAL_CROSSES_PER_IX

  let { currentTickIndex, tickSpacing, liquidity, sqrtPrice, fee } = pool
  const startingSqrtPrice = sqrtPrice
  let previousTickIndex = MAX_TICK + 1
  const amountPerTick: BN[] = []
  const crossedTicks: number[] = []
  let swapSteps = 0
  let priceLimitAfterSlippage

  if (!optionalPriceLimit) {
    priceLimitAfterSlippage = xToY ? calculatePriceSqrt(MIN_TICK) : calculatePriceSqrt(MAX_TICK)
  } else {
    priceLimitAfterSlippage = calculatePriceAfterSlippage(optionalPriceLimit, slippage, !xToY)
  }

  let accumulatedAmount: BN = new BN(0)
  let accumulatedAmountOut: BN = new BN(0)
  let accumulatedAmountIn: BN = new BN(0)
  let accumulatedFee: BN = new BN(0)

  // Sanity check, should never throw
  if (xToY) {
    if (sqrtPrice.lt(priceLimitAfterSlippage)) {
      throw new Error(SimulationStatus.WrongLimit)
    }
  } else {
    if (sqrtPrice.gt(priceLimitAfterSlippage)) {
      throw new Error(SimulationStatus.WrongLimit)
    }
  }

  let remainingAmount: BN = swapAmount
  let status = SimulationStatus.Ok

  while (!remainingAmount.lte(new BN(0))) {
    // find closest initialized tick
    const closerLimit: CloserLimit = {
      sqrtPriceLimit: priceLimitAfterSlippage,
      xToY: xToY,
      currentTick: currentTickIndex,
      tickSpacing: tickSpacing,
      tickmap: tickmap
    }

    const { swapLimit, limitingTick } = getCloserLimit(closerLimit)
    const result = calculateSwapStep(
      sqrtPrice,
      swapLimit,
      liquidity,
      remainingAmount,
      byAmountIn,
      fee
    )
    swapSteps++

    accumulatedAmountIn = accumulatedAmountIn.add(result.amountIn)
    accumulatedAmountOut = accumulatedAmountOut.add(result.amountOut)
    accumulatedFee = accumulatedFee.add(result.feeAmount)

    let amountDiff: BN

    if (byAmountIn) {
      amountDiff = result.amountIn.add(result.feeAmount)
    } else {
      amountDiff = result.amountOut
    }

    remainingAmount = remainingAmount.sub(amountDiff)
    sqrtPrice = result.nextPrice

    if (sqrtPrice.eq(priceLimitAfterSlippage) && remainingAmount.gt(new BN(0))) {
      // throw new Error(SimulationErrors.PriceLimitReached)
      status = SimulationStatus.PriceLimitReached
      break
    }

    // crossing tick
    if (result.nextPrice.eq(swapLimit) && limitingTick != null) {
      const tickIndex: number = limitingTick.index
      const initialized: boolean = limitingTick.initialized

      const isEnoughAmountToCross = isEnoughAmountToPushPrice(
        remainingAmount,
        result.nextPrice,
        pool.liquidity,
        pool.fee,
        byAmountIn,
        xToY
      )

      // cross
      if (initialized) {
        const tick = ticks.get(tickIndex)

        if (tick === undefined) {
          throw new Error(SimulationStatus.TickNotFound)
        }

        crossedTicks.push(tickIndex)

        if (!xToY || isEnoughAmountToCross) {
          // trunk-ignore(eslint/no-mixed-operators)
          if (currentTickIndex >= tick.index !== tick.sign) {
            liquidity = liquidity.add(tick.liquidityChange)
          } else {
            liquidity = liquidity.sub(tick.liquidityChange)
          }
        } else if (!remainingAmount.eqn(0)) {
          if (byAmountIn) {
            accumulatedAmountIn = accumulatedAmountIn.add(remainingAmount)
          }
          remainingAmount = new BN(0)
        }
      }
      if (xToY && isEnoughAmountToCross) {
        currentTickIndex = tickIndex - tickSpacing
      } else {
        currentTickIndex = tickIndex
      }
    } else {
      currentTickIndex = getTickFromPrice(currentTickIndex, tickSpacing, result.nextPrice, xToY)
    }

    // add amount to array if tick was initialized otherwise accumulate amount for next iteration
    accumulatedAmount = accumulatedAmount.add(amountDiff)
    // trunk-ignore(eslint/@typescript-eslint/prefer-optional-chain)
    const isTickInitialized = limitingTick !== null && limitingTick.initialized

    if (isTickInitialized || remainingAmount.eqn(0)) {
      amountPerTick.push(accumulatedAmount)
      accumulatedAmount = new BN(0)
    }

    if (swapSteps > maxCrosses + maxVirtualCrosses || crossedTicks.length > maxCrosses) {
      status = SimulationStatus.SwapStepLimitReached
      break
    }

    if (currentTickIndex === previousTickIndex && !remainingAmount.eqn(0)) {
      // throw new Error(SimulationErrors.LimitReached)
      status = SimulationStatus.LimitReached
      break
    } else {
      previousTickIndex = currentTickIndex
    }
  }

  if (accumulatedAmountOut.isZero() && status === SimulationStatus.Ok) {
    // throw new Error(SimulationErrors.NoGainSwap)
    status = SimulationStatus.NoGainSwap
  }

  const priceAfterSwap: BN = sqrtPrice
  const priceImpact = calculatePriceImpact(startingSqrtPrice, priceAfterSwap)

  let minReceived: BN
  if (byAmountIn) {
    const endingPriceAfterSlippage = calculatePriceAfterSlippage(priceAfterSwap, slippage, !xToY)
    minReceived = calculateMinReceivedTokensByAmountIn(
      endingPriceAfterSlippage,
      xToY,
      accumulatedAmountIn,
      pool.fee
    )
  } else {
    minReceived = accumulatedAmountOut
  }

  return {
    status,
    amountPerTick,
    crossedTicks,
    accumulatedAmountIn,
    accumulatedAmountOut,
    accumulatedFee,
    priceAfterSwap,
    priceImpact,
    minReceived
  }
}

export const parseLiquidityOnTicks = (ticks: Tick[]) => {
  let currentLiquidity = new BN(0)

  return ticks.map(tick => {
    currentLiquidity = currentLiquidity.add(tick.liquidityChange.muln(tick.sign ? 1 : -1))
    return {
      liquidity: currentLiquidity,
      index: tick.index
    }
  })
}

export const calculateFeeGrowthInside = ({
  tickLower,
  tickUpper,
  tickCurrent,
  feeGrowthGlobalX,
  feeGrowthGlobalY
}: FeeGrowthInside) => {
  // determine position relative to current tick
  const currentAboveLower = tickCurrent >= tickLower.index
  const currentBelowUpper = tickCurrent < tickUpper.index
  let feeGrowthBelowX: BN
  let feeGrowthBelowY: BN
  let feeGrowthAboveX: BN
  let feeGrowthAboveY: BN

  // calculate fee growth below
  if (currentAboveLower) {
    feeGrowthBelowX = tickLower.feeGrowthOutsideX
    feeGrowthBelowY = tickLower.feeGrowthOutsideY
  } else {
    feeGrowthBelowX = feeGrowthGlobalX.sub(tickLower.feeGrowthOutsideX)
    feeGrowthBelowY = feeGrowthGlobalY.sub(tickLower.feeGrowthOutsideY)
  }

  // calculate fee growth above
  if (currentBelowUpper) {
    feeGrowthAboveX = tickUpper.feeGrowthOutsideX
    feeGrowthAboveY = tickUpper.feeGrowthOutsideY
  } else {
    feeGrowthAboveX = feeGrowthGlobalX.sub(tickUpper.feeGrowthOutsideX)
    feeGrowthAboveY = feeGrowthGlobalY.sub(tickUpper.feeGrowthOutsideY)
  }

  // calculate fee growth inside
  let feeGrowthInsideX = feeGrowthGlobalX.sub(feeGrowthBelowX).sub(feeGrowthAboveX)
  let feeGrowthInsideY = feeGrowthGlobalY.sub(feeGrowthBelowY).sub(feeGrowthAboveY)

  if (feeGrowthInsideX.lt(new BN(0))) {
    feeGrowthInsideX = U128MAX.sub(feeGrowthInsideX.abs()).addn(1)
  }
  if (feeGrowthInsideY.lt(new BN(0))) {
    feeGrowthInsideY = U128MAX.sub(feeGrowthInsideY.abs()).addn(1)
  }

  return [feeGrowthInsideX, feeGrowthInsideY]
}

export const calculateTokensOwed = ({
  position,
  feeGrowthInsideX,
  feeGrowthInsideY
}: TokensOwed) => {
  let tokensOwedX
  let tokensOwedY
  if (feeGrowthInsideX.lt(position.feeGrowthInsideX)) {
    tokensOwedX = position.liquidity
      .mul(feeGrowthInsideX.add(U128MAX.sub(position.feeGrowthInsideX)))
      .div(new BN(10).pow(new BN(DECIMAL + LIQUIDITY_SCALE)))
  } else {
    tokensOwedX = position.liquidity
      .mul(feeGrowthInsideX.sub(position.feeGrowthInsideX))
      .div(new BN(10).pow(new BN(DECIMAL + LIQUIDITY_SCALE)))
  }
  if (feeGrowthInsideY.lt(position.feeGrowthInsideY)) {
    tokensOwedY = position.liquidity
      .mul(feeGrowthInsideY.add(U128MAX.sub(position.feeGrowthInsideY)))
      .div(new BN(10).pow(new BN(DECIMAL + LIQUIDITY_SCALE)))
  } else {
    tokensOwedY = position.liquidity
      .mul(feeGrowthInsideY.sub(position.feeGrowthInsideY))
      .div(new BN(10).pow(new BN(DECIMAL + LIQUIDITY_SCALE)))
  }
  const tokensOwedXTotal = position.tokensOwedX.add(tokensOwedX).div(DENOMINATOR)
  const tokensOwedYTotal = position.tokensOwedY.add(tokensOwedY).div(DENOMINATOR)
  return [tokensOwedXTotal, tokensOwedYTotal]
}

export const calculateClaimAmount = ({
  position,
  tickLower,
  tickUpper,
  tickCurrent,
  feeGrowthGlobalX,
  feeGrowthGlobalY
}: SimulateClaim) => {
  // determine position relative to current tick
  const feeGrowthParams: FeeGrowthInside = {
    tickLower: tickLower,
    tickUpper: tickUpper,
    tickCurrent: tickCurrent,
    feeGrowthGlobalX: feeGrowthGlobalX,
    feeGrowthGlobalY: feeGrowthGlobalY
  }
  const [feeGrowthInsideX, feeGrowthInsideY] = calculateFeeGrowthInside(feeGrowthParams)

  const tokensOwedParams: TokensOwed = {
    position: position,
    feeGrowthInsideX: feeGrowthInsideX,
    feeGrowthInsideY: feeGrowthInsideY
  }

  const [tokensOwedXTotal, tokensOwedYTotal] = calculateTokensOwed(tokensOwedParams)

  return [tokensOwedXTotal, tokensOwedYTotal]
}

export const bigNumberToBuffer = (n: BN, size: 16 | 32 | 64 | 128 | 256) => {
  const chunk = new BN(2).pow(new BN(16))

  const buffer = Buffer.alloc(size / 8)
  let offset = 0

  while (n.gt(new BN(0))) {
    buffer.writeUInt16LE(n.mod(chunk).toNumber(), offset)
    n = n.div(chunk)
    offset += 2
  }

  return buffer
}

export const getMaxTick = (tickSpacing: number) => {
  const limitedByPrice = MAX_TICK - (MAX_TICK % tickSpacing)
  const limitedByTickmap = TICK_LIMIT * tickSpacing - tickSpacing
  return Math.min(limitedByPrice, limitedByTickmap)
}

export const getMinTick = (tickSpacing: number) => {
  const limitedByPrice = -MAX_TICK + (MAX_TICK % tickSpacing)
  const limitedByTickmap = -TICK_LIMIT * tickSpacing
  return Math.max(limitedByPrice, limitedByTickmap)
}

export const getVolume = (
  volumeX: number,
  volumeY: number,
  previousSqrtPrice: BN,
  currentSqrtPrice: BN
): number => {
  const price = previousSqrtPrice.mul(currentSqrtPrice).div(PRICE_DENOMINATOR)
  const denominatedVolumeY = new BN(volumeY).mul(PRICE_DENOMINATOR).div(price).toNumber()
  return volumeX + denominatedVolumeY
}

export const getTokensInRange = (ticks: ParsedTick[], lowerTick: number, upperTick: number): BN => {
  let tokenXamount: BN = new BN(0)
  let currentIndex: number | null
  let nextIndex: number | null

  for (let i = 0; i < ticks.length - 1; i++) {
    currentIndex = ticks[i].index
    nextIndex = ticks[i + 1].index

    if (currentIndex >= lowerTick && currentIndex < upperTick) {
      const lowerSqrtPrice = calculatePriceSqrt(currentIndex)
      const upperSqrtPrice = calculatePriceSqrt(nextIndex)
      tokenXamount = tokenXamount.add(
        getXfromLiquidity(ticks[i].liquidity, upperSqrtPrice, lowerSqrtPrice)
      )
    }
  }

  return tokenXamount
}
export const getTokens = (liquidity: BN, lowerTickIndex: number, upperTickIndex: number): BN => {
  const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)
  return getXfromLiquidity(liquidity, upperSqrtPrice, lowerSqrtPrice)
}

export const getTokensAndLiquidity = (
  ticks: ParsedTick[],
  currentTickIndex: number
): { tokens: BN; liquidity: BN; nextInitializedTick: number } => {
  let tokens: BN = new BN(0)
  let liquidity: BN = new BN(0)
  let currentIndex: number | null
  let nextIndex: number | null
  let nextInitializedTick: number = 0

  for (let i = 0; i < ticks.length - 1; i++) {
    currentIndex = ticks[i].index
    nextIndex = ticks[i + 1].index
    if (currentIndex == currentTickIndex) {
      nextInitializedTick = nextIndex
    }

    tokens = getTokens(ticks[i].liquidity, currentIndex, nextIndex)
    liquidity = liquidity.add(ticks[i].liquidity)
  }
  return { tokens, liquidity, nextInitializedTick }
}

export const getTokensAndLiquidityOnSingleTick = (
  ticks: Map<number, ParsedTick>,
  currentTickIndex: number,
  nextInitialized: number
): { singleTickTokens: BN; singleTickLiquidity: BN } => {
  const singleTickLiquidity = ticks.get(currentTickIndex)?.liquidity as BN
  const singleTickTokens = getTokens(singleTickLiquidity, currentTickIndex, nextInitialized)

  return { singleTickTokens, singleTickLiquidity }
}

export const getRangeBasedOnFeeGrowth = (
  tickArrayPrevious: ParsedTick[],
  tickMapCurrent: Map<number, ParsedTick>
): { tickLower: number | null; tickUpper: number | null } => {
  let tickLower: number | null = null
  let tickUpper: number | null = null
  let tickLowerIndex: number = -1
  let tickUpperIndex: number = -1
  let tickLowerIndexSaved = false

  let currentSnapTick: ParsedTick | undefined
  const MIN_INDEX = 0
  const MAX_INDEX = tickArrayPrevious.length - 1

  for (let i = 0; i < tickArrayPrevious.length - 1; i++) {
    currentSnapTick = tickMapCurrent.get(tickArrayPrevious[i].index)
    if (currentSnapTick === undefined) continue

    if (
      !(
        tickArrayPrevious[i].feeGrowthOutsideX.eq(currentSnapTick.feeGrowthOutsideX) &&
        tickArrayPrevious[i].feeGrowthOutsideY.eq(currentSnapTick.feeGrowthOutsideY)
      )
    ) {
      if (!tickLowerIndexSaved) {
        tickLowerIndex = i
        tickLowerIndexSaved = true
      }
      tickUpperIndex = i
    }
  }
  if (tickLowerIndex !== -1) {
    tickLower =
      tickLowerIndex > MIN_INDEX
        ? tickArrayPrevious[tickLowerIndex - 1].index
        : tickArrayPrevious[tickLowerIndex].index
  }
  if (tickUpperIndex !== -1) {
    tickUpper =
      tickUpperIndex < MAX_INDEX
        ? tickArrayPrevious[tickUpperIndex + 1].index
        : tickArrayPrevious[tickUpperIndex].index
  }
  return {
    tickLower,
    tickUpper
  }
}
export const parseFeeGrowthAndLiquidityOnTicksArray = (ticks: Tick[]): ParsedTick[] => {
  const sortedTicks = ticks.sort((a, b) => a.index - b.index)

  let currentLiquidity = new BN(0)
  return sortedTicks.map(tick => {
    currentLiquidity = currentLiquidity.add(tick.liquidityChange.muln(tick.sign ? 1 : -1))
    return {
      liquidity: currentLiquidity,
      index: tick.index,
      feeGrowthOutsideX: tick.feeGrowthOutsideX,
      feeGrowthOutsideY: tick.feeGrowthOutsideY
    }
  })
}

export const parseFeeGrowthAndLiquidityOnTicksMap = (ticks: Tick[]): Map<number, ParsedTick> => {
  const sortedTicks = ticks.sort((a, b) => a.index - b.index)
  let currentLiquidity = new BN(0)
  const ticksMap = new Map<number, ParsedTick>()
  sortedTicks.map(tick => {
    currentLiquidity = currentLiquidity.add(tick.liquidityChange.muln(tick.sign ? 1 : -1))
    ticksMap.set(tick.index, {
      liquidity: currentLiquidity,
      index: tick.index,
      feeGrowthOutsideX: tick.feeGrowthOutsideX,
      feeGrowthOutsideY: tick.feeGrowthOutsideY
    })
  })

  return ticksMap
}
export const calculateTokensRange = (
  ticksPreviousSnapshot: Tick[],
  ticksCurrentSnapshot: Tick[],
  currentTickIndex: number
): RangeData => {
  const tickArrayPrevious = parseFeeGrowthAndLiquidityOnTicksArray(ticksPreviousSnapshot)
  const tickArrayCurrent = parseFeeGrowthAndLiquidityOnTicksArray(ticksCurrentSnapshot)
  const tickMapCurrent = parseFeeGrowthAndLiquidityOnTicksMap(ticksCurrentSnapshot)
  if (!(tickArrayPrevious.length || tickArrayCurrent.length)) {
    throw new Error(Errors.TickArrayIsEmpty)
  }
  if (!(tickArrayPrevious.length && tickArrayCurrent.length)) {
    const notEmptyArray = tickArrayPrevious.length ? tickArrayPrevious : tickArrayCurrent
    const tickLower = notEmptyArray[0].index
    const tickUpper = notEmptyArray[notEmptyArray.length - 1].index
    const tokens = getTokensInRange(notEmptyArray, tickLower, tickUpper)

    return {
      tokens,
      tickLower,
      tickUpper
    }
  }

  let { tickLower, tickUpper } = getRangeBasedOnFeeGrowth(tickArrayPrevious, tickMapCurrent)

  if (tickLower == null || tickUpper == null) {
    const { lower, upper } = getTicksFromSwapRange(tickArrayCurrent, currentTickIndex)
    tickLower = lower
    tickUpper = upper
  }
  if (tickLower == null || tickUpper == null) {
    throw new Error(Errors.TickNotFound)
  }

  const tokensPrevious = getTokensInRange(tickArrayPrevious, tickLower, tickUpper)
  const tokensCurrent = getTokensInRange(tickArrayCurrent, tickLower, tickUpper)

  // arithmetic mean of tokensPrevious and tokensCurrent
  const tokens = arithmeticalAvg(tokensPrevious, tokensCurrent)

  return {
    tokens,
    tickLower,
    tickUpper
  }
}

export const calculateTokensAndLiquidity = (
  ticksCurrentSnapshot: Tick[],
  currentTickIndex: number
): RewardData => {
  const tickArrayCurrent = parseFeeGrowthAndLiquidityOnTicksArray(ticksCurrentSnapshot)
  const tickMapCurrent = parseFeeGrowthAndLiquidityOnTicksMap(ticksCurrentSnapshot)
  if (tickArrayCurrent.length === 0) {
    throw new Error(Errors.TickArrayIsEmpty)
  }

  const { tokens, liquidity, nextInitializedTick } = getTokensAndLiquidity(
    tickArrayCurrent,
    currentTickIndex
  )

  const { singleTickTokens, singleTickLiquidity } = getTokensAndLiquidityOnSingleTick(
    tickMapCurrent,
    currentTickIndex,
    nextInitializedTick
  )
  return {
    tokens,
    liquidity,
    singleTickTokens,
    singleTickLiquidity
  }
}

export const calculatePoolLiquidityFromSnapshot = (
  ticksCurrentSnapshot: Tick[],
  currentTickIndex: number
): { poolLiquidity: BN } => {
  const tickArrayCurrent = parseFeeGrowthAndLiquidityOnTicksArray(ticksCurrentSnapshot)
  if (tickArrayCurrent.length === 0) {
    throw new Error(Errors.TickArrayIsEmpty)
  }

  const { liquidity } = getTokensAndLiquidity(tickArrayCurrent, currentTickIndex)

  return { poolLiquidity: liquidity }
}

export const dailyFactorPool = (tokenXamount: BN, volume: number, feeTier: FeeTier): number => {
  const fee: number = (feeTier.fee.toNumber() / DENOMINATOR.toNumber()) * (1 - PROTOCOL_FEE)
  return (volume * fee) / tokenXamount.toNumber()
}

export const getTicksFromSwapRange = (
  ticks: ParsedTick[],
  currentTickIndex: number
): { lower: number | null; upper: number | null } => {
  for (let i = 0; i < ticks.length - 1; i++) {
    const lower = ticks[i].index
    const upper = ticks[i + 1].index

    if (lower <= currentTickIndex && upper >= currentTickIndex) {
      return { lower, upper }
    }
  }
  return { lower: null, upper: null }
}

export const poolAPY = (params: ApyPoolParams): WeeklyData => {
  const {
    feeTier,
    currentTickIndex,
    activeTokens,
    ticksPreviousSnapshot,
    ticksCurrentSnapshot,
    weeklyData,
    volumeX,
    volumeY
  } = params
  const { weeklyFactor, weeklyRange } = weeklyData
  let dailyFactor: number | null
  let dailyRange: Range
  let dailyTokens: BN = new BN(0)
  let dailyVolumeX: number = 0
  try {
    const {
      tickLower,
      tickUpper,
      tokens: avgTokensFromRange
    } = calculateTokensRange(ticksPreviousSnapshot, ticksCurrentSnapshot, currentTickIndex)

    const previousSqrtPrice = calculatePriceSqrt(tickLower)
    const currentSqrtPrice = calculatePriceSqrt(tickUpper)
    const volume = getVolume(volumeX, volumeY, previousSqrtPrice, currentSqrtPrice)
    const tokenAvgFactor = weightedArithmeticAvg(
      { val: activeTokens, weight: new BN(1) },
      { val: avgTokensFromRange, weight: new BN(4) }
    )
    dailyFactor = dailyFactorPool(tokenAvgFactor, volume, feeTier)
    dailyRange = { tickLower, tickUpper }
    dailyTokens = tokenAvgFactor
    dailyVolumeX = volumeX
  } catch (e: any) {
    dailyFactor = 0
    dailyRange = { tickLower: null, tickUpper: null }
  }

  const newWeeklyFactor = updateWeeklyFactor(weeklyFactor, dailyFactor)
  const newWeeklyRange = updateWeeklyRange(weeklyRange, dailyRange)

  const apy = (Math.pow(average(newWeeklyFactor) + 1, 365) - 1) * 100

  return {
    weeklyFactor: newWeeklyFactor,
    weeklyRange: newWeeklyRange,
    tokenXamount: dailyTokens,
    volumeX: dailyVolumeX,
    apy
  }
}

export const dailyFactorRewards = (
  rewardInUSD: number,
  tokenXamount: BN,
  tokenXprice: number,
  tokenBN: number,
  duration: number
): number => {
  return (
    rewardInUSD /
    (tokenXamount.div(new BN(10).pow(new BN(tokenBN))).toNumber() * tokenXprice * duration)
  )
}

export const rewardsAPY = (params: ApyRewardsParams): { apy: number; apySingleTick: number } => {
  const {
    currentTickIndex,
    currentLiquidity,
    allLiquidityInTokens,
    tickSpacing,
    rewardInUsd,
    tokenPrice,
    tokenBN,
    duration
  } = params

  if (currentLiquidity.eqn(0)) {
    return { apy: Infinity, apySingleTick: Infinity }
  }
  const decimal: BN = new BN(10).pow(new BN(tokenBN))
  const dailyRewards = rewardInUsd / duration
  const lowerSqrtPrice = calculatePriceSqrt(currentTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(currentTickIndex + tickSpacing)

  const dailyFactor = (dailyRewards / allLiquidityInTokens.div(decimal).toNumber()) * tokenPrice

  const priceFactor = lowerSqrtPrice
    .mul(upperSqrtPrice)
    .div(upperSqrtPrice.sub(lowerSqrtPrice))
    .div(PRICE_DENOMINATOR)
    .toNumber()

  const rewardsFactor = (dailyRewards / tokenPrice) * decimal.toNumber()

  // dailyFactorSingleTick =  lowerSqrtPrice * upperSqrtPrice/ (upperSqrtPrice - lowerSqrtPrice) * 1/liquidity * dailyRewards/price / decimal
  const dailyFactorSingleTick =
    (priceFactor / currentLiquidity.div(LIQUIDITY_DENOMINATOR).toNumber()) * rewardsFactor

  const apy = Math.pow(dailyFactor + 1, 365) - 1
  const apySingleTick = Math.pow(dailyFactorSingleTick + 1, 365) - 1

  return { apy, apySingleTick }
}

export const positionsRewardAPY = (params: ApyPositionRewardsParams): number => {
  const {
    poolLiquidity,
    currentTickIndex,
    rewardInUsd,
    tokenPrice,
    tokenBN,
    duration,
    positionLiquidity,
    lowerTickIndex,
    upperTickIndex
  } = params

  // check if position is active
  if (!isActive(lowerTickIndex, upperTickIndex, currentTickIndex)) {
    return 0
  }
  if (poolLiquidity.eqn(0)) {
    return Infinity
  }
  const decimal: BN = new BN(10).pow(new BN(tokenBN))
  const dailyRewards = rewardInUsd / duration
  const liquidityRatio =
    positionLiquidity.mul(LIQUIDITY_DENOMINATOR).div(poolLiquidity).toNumber() /
    LIQUIDITY_DENOMINATOR.toNumber()
  const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
  const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)
  const positionTokens = getXfromLiquidity(positionLiquidity, upperSqrtPrice, lowerSqrtPrice)
  const dailyFactor =
    (dailyRewards * liquidityRatio) / (positionTokens.div(decimal).toNumber() * tokenPrice)

  const positionApy = Math.pow(dailyFactor + 1, 365) - 1

  return positionApy
}

export const calculateUserDailyRewards = (params: UserDailyRewardsParams): number => {
  const {
    poolLiquidity,
    currentTickIndex,
    rewardInTokens,
    userLiquidity,
    duration,
    lowerTickIndex,
    upperTickIndex
  } = params
  // check if position is active
  if (!isActive(lowerTickIndex, upperTickIndex, currentTickIndex)) {
    return 0
  }
  if (poolLiquidity.eqn(0)) {
    return Infinity
  }

  const dailyRewards = rewardInTokens / duration

  const liquidityRatio =
    userLiquidity.mul(LIQUIDITY_DENOMINATOR).div(poolLiquidity).toNumber() /
    LIQUIDITY_DENOMINATOR.toNumber()

  return dailyRewards * liquidityRatio
}

export const average = (array: number[]) =>
  array.reduce((prev: number, curr: number) => prev + curr) / array.length

export const updateWeeklyFactor = (weeklyFactor: number[], dailyFactor: number): number[] => {
  weeklyFactor.shift()
  weeklyFactor.push(dailyFactor)
  return weeklyFactor
}

export const updateWeeklyRange = (weeklyRange: Range[], dailyRange: Range): Range[] => {
  weeklyRange.shift()
  weeklyRange.push(dailyRange)
  return weeklyRange
}

export const isActive = (lowerIndex: number, upperIndex: number, currentIndex: number): boolean => {
  return lowerIndex <= currentIndex && upperIndex > currentIndex
}

const coingeckoIdOverwrites = {
  '9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i': 'terrausd',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj': 'lido-staked-sol',
  NRVwhjBQiUPYtfDT5zRBVJajzFQHaBUNtC7SNVvqRFa: 'nirvana-nirv'
}

export const getTokensData = async (): Promise<Record<string, TokenData>> => {
  const tokens: TokenListContainer = await new TokenListProvider().resolve()

  const tokenList = tokens
    .filterByClusterSlug('mainnet-beta')
    .getList()
    .filter(token => token.chainId === 101)

  const tokensObj: Record<string, TokenData> = {}

  tokenList.forEach((token: TokenInfo) => {
    tokensObj[token.address.toString()] = {
      // @ts-ignore
      id: coingeckoIdOverwrites?.[token.address.toString()] ?? token.extensions?.coingeckoId,
      decimals: token.decimals,
      ticker: token.symbol
    }
  })

  return tokensObj
}

export const getPrice = (sqrtPrice: BN, decimalDiff: number): BN => {
  const price = sqrtPrice.pow(new BN(2)) // sqrtPrice^2
  const priceWithCorrectPrecision = price.div(new BN(10).pow(new BN(40))) // price / 10^40, becouse now is 48 we need 8
  if (decimalDiff > 0) {
    return priceWithCorrectPrecision.mul(new BN(10).pow(new BN(decimalDiff)))
  }
  if (decimalDiff < 0) {
    return priceWithCorrectPrecision.div(new BN(10).pow(new BN(Math.abs(decimalDiff))))
  }
  return priceWithCorrectPrecision
}

export const getPositionIndex = (
  expectedAddress: PublicKey,
  invariantAddress: PublicKey,
  owner: PublicKey
): number => {
  let index: number = -1
  let counter: number = 0
  let found: Boolean = false

  while (!found) {
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(counter)

    const [positionAddress, _positionBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode('positionv1')), owner.toBuffer(), indexBuffer],
      invariantAddress
    )

    if (positionAddress.toString() == expectedAddress.toString()) {
      found = true
      index = counter
    }
    counter++
  }

  return index
}

export const printBN = (amount: BN, decimals: number): string => {
  const amountString = amount.toString()
  const isNegative = amountString.length > 0 && amountString[0] === '-'

  const balanceString = isNegative ? amountString.slice(1) : amountString

  if (balanceString.length <= decimals) {
    return (
      (isNegative ? '-' : '') + '0.' + '0'.repeat(decimals - balanceString.length) + balanceString
    )
  } else {
    return (
      (isNegative ? '-' : '') +
      trimZeros(
        balanceString.substring(0, balanceString.length - decimals) +
          '.' +
          balanceString.substring(balanceString.length - decimals)
      )
    )
  }
}

export const trimZeros = (numStr: string): string => {
  return numStr
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/^0+(\d)|(\d)0+$/gm, '$1$2')
    .replace(/\.$/, '')
}

export const createNativeAtaInstructions = (
  nativeAccount: PublicKey,
  owner: PublicKey,
  network: Network
) => {
  return _createNativeAtaInstructions(nativeAccount, owner, network) as WrappedEthInstructions
}

export const createNativeAtaWithTransferInstructions = (
  nativeAccount: PublicKey,
  owner: PublicKey,
  network: Network,
  nativeAmount: number
) => {
  return _createNativeAtaInstructions(
    nativeAccount,
    owner,
    network,
    nativeAmount
  ) as WrappedEthTransferInstructions
}

const _createNativeAtaInstructions = (
  nativeAccount: PublicKey,
  owner: PublicKey,
  network: Network,
  nativeAmount?: number
): WrappedEthTransferInstructions | WrappedEthInstructions => {
  const createIx = SystemProgram.createAccount({
    fromPubkey: owner,
    newAccountPubkey: nativeAccount,
    lamports: MIN_BALANCE_FOR_RENT_EXEMPT[network],
    space: 165,
    programId: TOKEN_PROGRAM_ID
  })

  const initIx = createInitializeAccountInstruction(
    nativeAccount,
    NATIVE_MINT,
    owner,
    TOKEN_PROGRAM_ID
  )
  const unwrapIx = createCloseAccountInstruction(nativeAccount, owner, owner, [], TOKEN_PROGRAM_ID)
  if (!nativeAmount) {
    return {
      createIx,
      initIx,
      unwrapIx
    }
  }

  const transferIx = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: nativeAccount,
    lamports: nativeAmount
  })
  return {
    createIx,
    transferIx,
    initIx,
    unwrapIx
  }
}
export const computeTokenAmountsFromPrice = (amountX: BN, amountY: BN, swapPoolPrice: BN) => {
  const currentPrice = swapPoolPrice.mul(swapPoolPrice)

  const totalAmount = amountX.add(amountY.mul(currentPrice).div(PRICE_DENOMINATOR.pow(new BN(2))))

  const x = totalAmount
    .mul(PRICE_DENOMINATOR.pow(new BN(2)))
    .div(currentPrice)
    .divn(2)
  const y = totalAmount
    .mul(currentPrice)
    .div(PRICE_DENOMINATOR.pow(new BN(2)))
    .divn(2)

  return { x, y }
}

export const computeTokenRatioDiff = (
  amountX: BN,
  amountY: BN,
  position: Pick<CreatePosition, 'knownPrice' | 'lowerTick' | 'upperTick'>
) => {
  const currentRatio = getMaxLiquidity(
    amountX,
    amountY,
    position.lowerTick,
    position.upperTick,
    position.knownPrice
  )

  const amountXDiff = amountX.sub(currentRatio.x)
  const amountYDiff = amountY.sub(currentRatio.y)

  return { x: currentRatio.x, y: currentRatio.y, amountXDiff, amountYDiff }
}
export const simulateSwapAndCreatePositionOnTheSamePool = (
  amountX: BN,
  amountY: BN,
  slippage: BN,
  swap: Pick<
    SimulateSwapInterface,
    'ticks' | 'tickmap' | 'pool' | 'maxVirtualCrosses' | 'maxCrosses'
  >,
  position: Pick<CreatePosition, 'lowerTick' | 'upperTick'>
): SimulateSwapAndCreatePositionSimulation => {
  const lowerSqrtPrice = calculatePriceSqrt(position.lowerTick)
  const upperSqrtPrice = calculatePriceSqrt(position.upperTick)

  const knownPrice = swap.pool.sqrtPrice

  if (upperSqrtPrice.lt(knownPrice)) {
    if (amountX.eqn(0)) {
      return {
        swapInput: undefined,
        swapSimulation: undefined,
        position: getMaxLiquidity(
          new BN(0),
          amountY,
          position.lowerTick,
          position.upperTick,
          knownPrice
        )
      }
    }

    const sim = simulateSwap({
      xToY: true,
      byAmountIn: true,
      swapAmount: amountX,
      priceLimit: swap.pool.sqrtPrice,
      slippage,
      ...swap
    })

    if (upperSqrtPrice.lt(sim.priceAfterSwap)) {
      const yAmount = sim.accumulatedAmountOut.add(amountY)
      return {
        swapInput: { xToY: true, byAmountIn: true, swapAmount: amountX },
        swapSimulation: sim,
        position: getMaxLiquidity(
          new BN(0),
          yAmount,
          position.lowerTick,
          position.upperTick,
          sim.priceAfterSwap
        )
      }
    }
  }

  if (lowerSqrtPrice.gt(knownPrice)) {
    if (amountY.eqn(0)) {
      return {
        swapInput: undefined,
        swapSimulation: undefined,
        position: getMaxLiquidity(
          amountX,
          new BN(0),
          position.lowerTick,
          position.upperTick,
          knownPrice
        )
      }
    }

    const sim = simulateSwap({
      xToY: false,
      byAmountIn: true,
      swapAmount: amountY,
      priceLimit: swap.pool.sqrtPrice,
      slippage,
      ...swap
    })

    if (lowerSqrtPrice.gt(sim.priceAfterSwap)) {
      const xAmount = amountX.add(sim.accumulatedAmountOut)
      return {
        swapInput: { xToY: false, byAmountIn: true, swapAmount: amountY },
        swapSimulation: sim,
        position: getMaxLiquidity(
          xAmount,
          new BN(0),
          position.lowerTick,
          position.upperTick,
          sim.priceAfterSwap
        )
      }
    }
  }

  const { x, y, amountXDiff, amountYDiff } = computeTokenRatioDiff(amountX, amountY, {
    ...position,
    knownPrice
  })

  const tokenXUtilization = amountX.eqn(0) ? DENOMINATOR : x.mul(DENOMINATOR).div(amountX)
  const tokenYUtilization = amountY.eqn(0) ? DENOMINATOR : y.mul(DENOMINATOR).div(amountY)

  const lowestUtilization = tokenXUtilization.lt(tokenYUtilization)
    ? tokenXUtilization
    : tokenYUtilization

  if (lowestUtilization.eq(DENOMINATOR)) {
    const xAmount = x.gtn(1) ? x.subn(1) : x
    const yAmount = y.gtn(1) ? y.subn(1) : y
    return {
      swapInput: undefined,
      swapSimulation: undefined,
      position: getMaxLiquidity(
        xAmount,
        yAmount,
        position.lowerTick,
        position.upperTick,
        knownPrice
      )
    }
  }

  let xToY: boolean
  let amount: BN
  const byAmountIn: boolean = true

  if (tokenXUtilization.gt(tokenYUtilization)) {
    xToY = false
    amount = amountYDiff
  } else {
    xToY = true
    amount = amountXDiff
  }

  let low = new BN(0)
  let high = amount
  let mid = new BN(0)
  let precision = new BN(1)
  let bestSim: SimulationResult | undefined
  let bestUtilization: BN | undefined
  let bestAmountXAfterSwap: BN | undefined
  let bestAmountYAfterSwap: BN | undefined
  let bestAmount: BN | undefined

  while (low.add(precision).lt(high)) {
    mid = low.add(high).addn(1).divn(2)

    const sim = simulateSwap({
      xToY,
      byAmountIn,
      swapAmount: mid,
      priceLimit: swap.pool.sqrtPrice,
      slippage,
      ...swap
    })

    switch (sim.status) {
      case SimulationStatus.Ok:
        break
      case SimulationStatus.NoGainSwap:
        low = mid
        continue
      default:
        high = byAmountIn ? sim.accumulatedAmountIn : sim.accumulatedAmountOut
        continue
    }

    let amountXAfterSwap: BN
    let amountYAfterSwap: BN
    if (xToY) {
      amountXAfterSwap = amountX.sub(sim.accumulatedAmountIn).sub(sim.accumulatedFee)
      amountYAfterSwap = amountY.add(sim.accumulatedAmountOut)
    } else {
      amountYAfterSwap = amountY.sub(sim.accumulatedAmountIn).sub(sim.accumulatedFee)
      amountXAfterSwap = amountX.add(sim.accumulatedAmountOut)
    }

    const { x, y, amountXDiff, amountYDiff } = computeTokenRatioDiff(
      amountXAfterSwap,
      amountYAfterSwap,
      { ...position, knownPrice: sim.priceAfterSwap }
    )

    // break early if the perfect case was found
    if (amountXDiff.lten(0) && amountYDiff.lten(0)) {
      const xAmount = x.gtn(1) ? x.subn(1) : x
      const yAmount = y.gtn(1) ? y.subn(1) : y

      return {
        swapInput: {
          xToY,
          byAmountIn,
          swapAmount: mid
        },
        swapSimulation: sim,
        position: getMaxLiquidity(
          xAmount,
          yAmount,
          position.lowerTick,
          position.upperTick,
          sim.priceAfterSwap
        )
      }
    }

    const tokenXUtilization = amountXAfterSwap.eqn(0)
      ? DENOMINATOR
      : x.mul(DENOMINATOR).div(amountXAfterSwap)
    const tokenYUtilization = amountYAfterSwap.eqn(0)
      ? DENOMINATOR
      : y.mul(DENOMINATOR).div(amountYAfterSwap)

    const lowestUtilization = tokenXUtilization.lt(tokenYUtilization)
      ? tokenXUtilization
      : tokenYUtilization

    if (xToY) {
      if (tokenXUtilization.lte(tokenYUtilization)) {
        low = mid
      } else {
        high = mid
      }
    } else {
      if (tokenYUtilization.lte(tokenXUtilization)) {
        low = mid
      } else {
        high = mid
      }
    }

    if (bestUtilization) {
      if (lowestUtilization.gt(bestUtilization)) {
        bestUtilization = lowestUtilization
        bestSim = sim
        bestAmountXAfterSwap = x
        bestAmountYAfterSwap = y
        bestAmount = mid
      }
    } else {
      bestUtilization = lowestUtilization
      bestSim = sim
      bestAmountXAfterSwap = x
      bestAmountYAfterSwap = y
      bestAmount = mid
    }
  }

  bestAmountXAfterSwap = bestAmountXAfterSwap
    ? bestAmountXAfterSwap.gtn(1)
      ? bestAmountXAfterSwap.subn(1)
      : bestAmountXAfterSwap
    : undefined
  bestAmountYAfterSwap = bestAmountYAfterSwap
    ? bestAmountYAfterSwap.gtn(1)
      ? bestAmountYAfterSwap.subn(1)
      : bestAmountYAfterSwap
    : undefined

  return {
    swapInput: bestAmount
      ? {
          byAmountIn,
          xToY,
          swapAmount: bestAmount
        }
      : undefined,
    swapSimulation: bestSim,
    position:
      bestSim && bestAmountXAfterSwap && bestAmountYAfterSwap
        ? getMaxLiquidity(
            bestAmountXAfterSwap,
            bestAmountYAfterSwap,
            position.lowerTick,
            position.upperTick,
            bestSim.priceAfterSwap
          )
        : { x: new BN(0), y: new BN(0), liquidity: new BN(0) }
  }
}

export const simulateSwapAndCreatePosition = (
  amountX: BN,
  amountY: BN,
  swap: Pick<
    SimulateSwapInterface,
    'ticks' | 'tickmap' | 'pool' | 'maxVirtualCrosses' | 'maxCrosses' | 'slippage'
  >,
  position: Pick<CreatePosition, 'lowerTick' | 'knownPrice' | 'slippage' | 'upperTick'>,
  minPrecision: BN = toDecimal(1, 2)
): SimulateSwapAndCreatePositionSimulation => {
  const lowerSqrtPrice = calculatePriceSqrt(position.lowerTick)
  const upperSqrtPrice = calculatePriceSqrt(position.upperTick)

  if (upperSqrtPrice.lt(position.knownPrice)) {
    if (amountX.eqn(0)) {
      return {
        swapInput: undefined,
        swapSimulation: undefined,
        position: getMaxLiquidity(
          new BN(0),
          amountY,
          position.lowerTick,
          position.upperTick,
          position.knownPrice
        )
      }
    }

    const swapAmount = amountX
    const sim = simulateSwap({
      xToY: true,
      byAmountIn: true,
      swapAmount,
      priceLimit: swap.pool.sqrtPrice,
      ...swap
    })

    return {
      swapInput: {
        xToY: true,
        swapAmount,
        byAmountIn: true
      },
      swapSimulation: sim,
      position: getMaxLiquidity(
        new BN(0),
        amountY.add(sim.accumulatedAmountOut),
        position.lowerTick,
        position.upperTick,
        position.knownPrice
      )
    }
  }

  if (lowerSqrtPrice.gt(position.knownPrice)) {
    if (amountY.eqn(0)) {
      return {
        swapInput: undefined,
        swapSimulation: undefined,
        position: getMaxLiquidity(
          amountX,
          new BN(0),
          position.lowerTick,
          position.upperTick,
          position.knownPrice
        )
      }
    }

    const swapAmount = amountY
    const sim = simulateSwap({
      xToY: false,
      byAmountIn: true,
      swapAmount,
      priceLimit: swap.pool.sqrtPrice,
      ...swap
    })
    return {
      swapInput: { xToY: false, swapAmount, byAmountIn: true },
      swapSimulation: sim,
      position: getMaxLiquidity(
        amountX.add(sim.accumulatedAmountOut),
        new BN(0),
        position.lowerTick,
        position.upperTick,
        position.knownPrice
      )
    }
  }

  const { x, y, amountXDiff, amountYDiff } = computeTokenRatioDiff(amountX, amountY, position)

  const tokenXUtilization = amountX.eqn(0) ? DENOMINATOR : x.mul(DENOMINATOR).div(amountX)
  const tokenYUtilization = amountY.eqn(0) ? DENOMINATOR : y.mul(DENOMINATOR).div(amountY)

  const lowestUtilization = tokenXUtilization.lt(tokenYUtilization)
    ? tokenXUtilization
    : tokenYUtilization

  if (lowestUtilization.eq(DENOMINATOR)) {
    const xAmount = x.gtn(1) ? x.subn(1) : x
    const yAmount = y.gtn(1) ? y.subn(1) : y
    return {
      swapInput: undefined,
      swapSimulation: undefined,
      position: getMaxLiquidity(
        xAmount,
        yAmount,
        position.lowerTick,
        position.upperTick,
        position.knownPrice
      )
    }
  }

  let xToY: boolean
  let amount: BN
  const byAmountIn: boolean = true

  if (tokenXUtilization.gt(tokenYUtilization)) {
    xToY = false
    amount = amountYDiff
  } else {
    xToY = true
    amount = amountXDiff
  }

  let low = new BN(0)
  let high = amount
  let mid = new BN(0)
  let precision = amount.mul(minPrecision).div(DENOMINATOR)
  precision = precision.gtn(0) ? precision : new BN(1)

  let bestSim: SimulationResult | undefined
  let bestUtilization: BN | undefined
  let bestAmountXAfterSwap: BN | undefined
  let bestAmountYAfterSwap: BN | undefined
  let bestAmount: BN | undefined

  while (low.add(precision).lt(high)) {
    mid = low.add(high).addn(1).divn(2)

    const sim = simulateSwap({
      xToY,
      byAmountIn,
      swapAmount: mid,
      priceLimit: swap.pool.sqrtPrice,
      ...swap
    })

    switch (sim.status) {
      case SimulationStatus.Ok:
        break
      case SimulationStatus.NoGainSwap:
        low = mid
        continue
      default:
        high = byAmountIn
          ? sim.accumulatedAmountIn.add(sim.accumulatedFee)
          : sim.accumulatedAmountOut
        continue
    }

    let amountXAfterSwap: BN
    let amountYAfterSwap: BN
    if (xToY) {
      amountXAfterSwap = amountX.sub(sim.accumulatedAmountIn).sub(sim.accumulatedFee)
      amountYAfterSwap = amountY.add(sim.accumulatedAmountOut)
    } else {
      amountYAfterSwap = amountY.sub(sim.accumulatedAmountIn).sub(sim.accumulatedFee)
      amountXAfterSwap = amountX.add(sim.accumulatedAmountOut)
    }

    const { x, y, amountXDiff, amountYDiff } = computeTokenRatioDiff(
      amountXAfterSwap,
      amountYAfterSwap,
      position
    )

    // break early if the perfect case was found
    if (amountXDiff.lten(0) && amountYDiff.lten(0)) {
      const xAmount = x.gtn(1) ? x.subn(1) : x
      const yAmount = y.gtn(1) ? y.subn(1) : y

      return {
        swapInput: {
          xToY,
          byAmountIn,
          swapAmount: mid
        },
        swapSimulation: sim,
        position: getMaxLiquidity(
          xAmount,
          yAmount,
          position.lowerTick,
          position.upperTick,
          position.knownPrice
        )
      }
    }

    const tokenXUtilization = amountXAfterSwap.eqn(0)
      ? DENOMINATOR
      : x.mul(DENOMINATOR).div(amountXAfterSwap)
    const tokenYUtilization = amountYAfterSwap.eqn(0)
      ? DENOMINATOR
      : y.mul(DENOMINATOR).div(amountYAfterSwap)

    const lowestUtilization = tokenXUtilization.lt(tokenYUtilization)
      ? tokenXUtilization
      : tokenYUtilization

    if (xToY) {
      if (tokenXUtilization.lte(tokenYUtilization)) {
        low = mid
      } else {
        high = mid
      }
    } else {
      if (tokenYUtilization.lte(tokenXUtilization)) {
        low = mid
      } else {
        high = mid
      }
    }

    if (bestUtilization) {
      if (lowestUtilization.gt(bestUtilization)) {
        bestUtilization = lowestUtilization
        bestSim = sim
        bestAmountXAfterSwap = x
        bestAmountYAfterSwap = y
        bestAmount = mid
      }
    } else {
      bestUtilization = lowestUtilization
      bestSim = sim
      bestAmountXAfterSwap = x
      bestAmountYAfterSwap = y
      bestAmount = mid
    }
  }

  bestAmountXAfterSwap = bestAmountXAfterSwap
    ? bestAmountXAfterSwap.gtn(1)
      ? bestAmountXAfterSwap.subn(1)
      : bestAmountXAfterSwap
    : undefined
  bestAmountYAfterSwap = bestAmountYAfterSwap
    ? bestAmountYAfterSwap.gtn(1)
      ? bestAmountYAfterSwap.subn(1)
      : bestAmountYAfterSwap
    : undefined

  return {
    swapInput: bestAmount
      ? {
          byAmountIn,
          xToY,
          swapAmount: bestAmount
        }
      : undefined,
    swapSimulation: bestSim,
    position:
      bestSim && bestAmountXAfterSwap && bestAmountYAfterSwap
        ? getMaxLiquidity(
            bestAmountXAfterSwap,
            bestAmountYAfterSwap,
            position.lowerTick,
            position.upperTick,
            position.knownPrice
          )
        : { x: new BN(0), y: new BN(0), liquidity: new BN(0) }
  }
}
export const parseEvent = (
  event: anchor.Event<IdlEvent, Record<string, never>> | null
): InvariantEvent => {
  if (!event) {
    throw new Error('Event is null!')
  }

  const raw = event.data

  switch (event.name) {
    case InvariantEventNames.CreatePositionEvent:
      return {
        ...raw,
        liquidity: (raw.liquidity as any).v,
        secondsPerLiquidityInsideInitial: (raw.secondsPerLiquidityInsideInitial as any).v
      } as CreatePositionEvent
    case InvariantEventNames.RemovePositionEvent:
      return {
        ...raw,
        liquidity: (raw.liquidity as any).v,
        upperTickSecondsPerLiquidityOutside: (raw.upperTickSecondsPerLiquidityOutside as any).v,
        lowerTickSecondsPerLiquidityOutside: (raw.lowerTickSecondsPerLiquidityOutside as any).v,
        poolSecondsPerLiquidityGlobal: (raw.poolSecondsPerLiquidityGlobal as any).v
      } as RemovePositionEvent
    case InvariantEventNames.SwapEvent:
      return {
        ...raw,
        priceBeforeSwap: (raw.priceBeforeSwap as any).v,
        priceAfterSwap: (raw.priceAfterSwap as any).v
      } as SwapEvent
    default:
      throw new Error('Invalid event name')
  }
}

export const deserializePoolLookupTables = (rawTables: SerializedLookupTableData[]) => {
  const tableData = rawTables.map(t => deserializePoolLookupTable(t))

  const tables = new Map<
    PoolAddress,
    [AddressLookupTableAccount, Map<AdjustedTableLookupTick, AddressLookupTableAccount>]
  >()
  for (const table of tableData) {
    const key = table.poolAddrs.toString()
    const entry = tables.get(key)

    if (entry) {
      if (table.isMainTable) {
        entry[0] = table.table
      } else {
        entry[1].set(table.tickIndex!, table.table)
      }
    } else {
      if (!table.isMainTable) {
        tables.set(key, [table.table, new Map()])
      } else {
        const map = new Map()
        map.set(table.tickIndex, table.table)
        tables.set(key, [null as any, map])
      }
    }
  }

  return tables
}

export const deserializePoolLookupTable = (t: SerializedLookupTableData) => {
  if (t.isMainTable) {
    return {
      poolAddrs: new PublicKey(t.poolAddr),
      isMainTable: true,
      table: deserializeLookuptableData(t.data)
    }
  } else {
    return {
      poolAddrs: new PublicKey(t.poolAddr),
      tickIndex: Number(t.tickIndex),
      table: deserializeLookuptableData(t.data)
    }
  }
}

export const deserializeLookuptableData = (
  t: SerializedLookupTableData['data']
): AddressLookupTableAccount => {
  return new AddressLookupTableAccount({
    key: new PublicKey(t.key),
    state: {
      authority: t.state.authority ? new PublicKey(t.state.authority) : undefined,
      addresses: t.state.addresses.map(m => new PublicKey(m)),
      lastExtendedSlot: t.state.lastExtendedSlot,
      lastExtendedSlotStartIndex: t.state.lastExtendedSlotStartIndex,
      deactivationSlot: BigInt(t.state.deactivationSlot)
    }
  })
}

type PoolAddress = string
type AdjustedTableLookupTick = number

const testnetCommonLookupTable: AddressLookupTableAccount = deserializeLookuptableData(
  rawTestnetCommonLookupTable
)

// const mainnetCommonLookupTable: AddressLookupTableAccount = deserializeLookuptableData(
//   rawMainnetCommonLookupTable
// )

export const testnetLookupTables: Map<
  PoolAddress,
  [AddressLookupTableAccount, Map<AdjustedTableLookupTick, AddressLookupTableAccount>]
> = deserializePoolLookupTables(rawTestnetPoolLookuTables)

export const mainnetLookupTables: Map<
  PoolAddress,
  [AddressLookupTableAccount, Map<AdjustedTableLookupTick, AddressLookupTableAccount>]
> = new Map()

export const TICK_COUNT_PER_LOOKUP_TABLE = 254

export const getLookupTableAddresses = (
  market: Market,
  pair: Pair,
  ticks: number[],
  allTablesRequired: boolean = false
) => {
  ticks.sort()

  const lookupTables = market.network === Network.MAIN ? mainnetLookupTables : testnetLookupTables
  const commonLookupTable = market.network === Network.MAIN ? undefined : testnetCommonLookupTable

  if (!commonLookupTable) {
    throw new Error('Mainnet lookup table not created')
  }

  const ticksForPool = lookupTables.get(pair.getAddress(market.program.programId).toString())

  if (!ticksForPool) {
    if (allTablesRequired) {
      throw new Error('Tick lookup addresses not found')
    } else {
      return []
    }
  }
  const [poolLookupTable, tickLookupTables] = ticksForPool

  const tickLookupTablesInRange: web3.AddressLookupTableAccount[] = []
  tickLookupTablesInRange.push(commonLookupTable)
  tickLookupTablesInRange.push(poolLookupTable)

  if (!ticks.length) {
    return tickLookupTablesInRange
  }

  const lowestTick = ticks[0]
  const highestTick = ticks[ticks.length - 1]

  // ticks adjusted to match the starting one
  const low = getRealTickFromAdjustedLookupTableStartingTick(
    pair.tickSpacing,
    getAdjustedLookupTableStartingTick(pair.tickSpacing, lowestTick)
  )
  const high = getRealTickFromAdjustedLookupTableStartingTick(
    pair.tickSpacing,
    getAdjustedLookupTableStartingTick(pair.tickSpacing, highestTick)
  )

  for (let i = low; i <= high; i += TICK_COUNT_PER_LOOKUP_TABLE * pair.tickSpacing) {
    const table = tickLookupTables.get(i)
    if (!table) {
      if (allTablesRequired) {
        throw new Error('Tick lookup table not found')
      } else {
        continue
      }
    }

    tickLookupTablesInRange.push(table)
  }

  return tickLookupTablesInRange
}

export const fetchAllLookupTables = (connection: Connection, owner: PublicKey) => {
  return connection
    .getProgramAccounts(AddressLookupTableProgram.programId, {
      filters: [
        {
          memcmp: {
            bytes: owner.toBase58(),
            offset: 22
          }
        }
      ]
    })
    .then(l =>
      l.map(
        l =>
          new AddressLookupTableAccount({
            key: l.pubkey,
            state: AddressLookupTableAccount.deserialize(l.account.data)
          })
      )
    )
}

export const fetchAllLookupTablesByPool = (
  connection: Connection,
  owner: PublicKey,
  pool: PublicKey
) => {
  return connection
    .getProgramAccounts(AddressLookupTableProgram.programId, {
      filters: [
        {
          memcmp: {
            bytes: owner.toBase58(),
            offset: 22
          }
        },
        {
          memcmp: {
            bytes: pool.toBase58(),
            offset: 56
          }
        }
      ]
    })
    .then(l =>
      l.map(
        l =>
          new AddressLookupTableAccount({
            key: l.pubkey,
            state: AddressLookupTableAccount.deserialize(l.account.data)
          })
      )
    )
}

export const fetchLookupTableByPoolAndAdjustedTickIndex = (
  market: Market,
  owner: PublicKey,
  pair: Pair,
  tickIndex: number
) => {
  const poolAddress = pair.getAddress(market.program.programId)

  return market.connection
    .getProgramAccounts(AddressLookupTableProgram.programId, {
      filters: [
        {
          memcmp: {
            bytes: owner.toBase58(),
            offset: 22
          }
        },
        {
          memcmp: {
            bytes: poolAddress.toBase58(),
            offset: 56
          }
        },
        {
          memcmp: {
            bytes: new PublicKey(new BN(tickIndex)).toBase58(),
            offset: 88
          }
        }
      ]
    })
    .then(l =>
      l.map(
        l =>
          new AddressLookupTableAccount({
            key: l.pubkey,
            state: AddressLookupTableAccount.deserialize(l.account.data)
          })
      )
    )
}

export const fetchLookupTableByPoolAccount = async (
  market: Market,
  owner: PublicKey,
  pair: Pair
) => {
  const poolAddress = pair.getAddress(market.program.programId)
  const poolAccount = await market.getPool(pair)

  return market.connection
    .getProgramAccounts(AddressLookupTableProgram.programId, {
      filters: [
        {
          memcmp: {
            bytes: owner.toBase58(),
            offset: 22
          }
        },
        {
          memcmp: {
            bytes: poolAddress.toBase58(),
            offset: 56
          }
        },
        {
          memcmp: {
            bytes: poolAccount.tickmap.toBase58(),
            offset: 88
          }
        },
        {
          memcmp: {
            bytes: poolAccount.tokenXReserve.toBase58(),
            offset: 120
          }
        }
      ]
    })
    .then(l =>
      l.map(
        l =>
          new AddressLookupTableAccount({
            key: l.pubkey,
            state: AddressLookupTableAccount.deserialize(l.account.data)
          })
      )
    )
}

export const getAdjustedLookupTableStartingTick = (tickSpacing: number, tick: number) => {
  const minTick = getMinTick(tickSpacing)
  const lookupTableOffset =
    tick - minTick - ((tick - minTick) % (TICK_COUNT_PER_LOOKUP_TABLE * tickSpacing))

  return lookupTableOffset
}

export const getRealTickFromAdjustedLookupTableStartingTick = (
  tickSpacing: number,
  tick: number
) => {
  const minTick = getMinTick(tickSpacing)
  const lookupTableOffset = tick + minTick

  return lookupTableOffset
}

const generateLookupTableForTicks = (market: Market, pair: Pair, adjustedStartingTick: number) => {
  const minTick = getMinTick(pair.tickSpacing)
  const maxTick = getMaxTick(pair.tickSpacing)

  const addresses: PublicKey[] = []

  const poolAddress = pair.getAddress(market.program.programId)
  const adjustedStartingTickKey = new PublicKey(new BN(adjustedStartingTick))
  const realStartingTick = getRealTickFromAdjustedLookupTableStartingTick(
    pair.tickSpacing,
    adjustedStartingTick
  )

  addresses.push(poolAddress)
  addresses.push(adjustedStartingTickKey)

  for (let i = 0; i < TICK_COUNT_PER_LOOKUP_TABLE * pair.tickSpacing; i += pair.tickSpacing) {
    const tick = realStartingTick + i

    if (tick < minTick) {
      continue
    } else if (tick > maxTick) {
      break
    }

    addresses.push(market.getTickAddressByPool(poolAddress, tick).tickAddress)
  }

  return { addresses, startingTickForLookupTable: adjustedStartingTick }
}

export const generateLookupTableRangeForTicks = (
  market: Market,
  pair: Pair,
  startingTick: number,
  finalTick: number
) => {
  const adjustedStartingTick = getAdjustedLookupTableStartingTick(pair.tickSpacing, startingTick)
  const adjustedFinalTick =
    getAdjustedLookupTableStartingTick(pair.tickSpacing, finalTick) +
    TICK_COUNT_PER_LOOKUP_TABLE * pair.tickSpacing

  const lookupTables: { addresses: PublicKey[]; startingTickForLookupTable: number }[] = []
  for (
    let i = adjustedStartingTick;
    i < adjustedFinalTick;
    i += TICK_COUNT_PER_LOOKUP_TABLE * pair.tickSpacing
  ) {
    lookupTables.push(generateLookupTableForTicks(market, pair, i))
  }

  return lookupTables
}

export const generateLookupTableForPool = (market: Market, pair: Pair, pool: PoolStructure) => {
  const addresses: PublicKey[] = []
  addresses.push(pair.getAddress(market.program.programId))
  addresses.push(pool.tickmap)
  addresses.push(pool.tokenXReserve)
  addresses.push(pool.tokenYReserve)
  return addresses
}

export const generateLookupTableForCommonAccounts = (market: Market) => {
  const addresses: PublicKey[] = []
  addresses.push(TOKEN_2022_PROGRAM_ID)
  addresses.push(TOKEN_PROGRAM_ID)
  addresses.push(SystemProgram.programId)
  addresses.push(SYSVAR_RENT_PUBKEY)
  addresses.push(market.stateAddress.address)
  addresses.push(market.programAuthority.address)
  addresses.push(market.program.programId)

  return addresses
}

export const createAndExtendAddressLookupTableTxs = async (
  owner: PublicKey,
  slot: number,
  addresses: PublicKey[],
  payer?: PublicKey
) => {
  const txBatchSize = 256
  if (addresses.length > txBatchSize) {
    throw new Error('Addresses too long for single address lookup table')
  }

  const payerPubkey = payer ?? owner
  const [lookupTableInst, lookupTableAddress] = web3.AddressLookupTableProgram.createLookupTable({
    authority: owner,
    payer: payerPubkey,
    recentSlot: slot
  })
  const ixBatchSize = 30
  const ixCount = Math.ceil(addresses.length / ixBatchSize)
  const extendIxs: TransactionInstruction[] = []

  for (let i = 0; i < ixCount; i++) {
    extendIxs.push(
      web3.AddressLookupTableProgram.extendLookupTable({
        payer: payerPubkey,
        authority: owner,
        lookupTable: lookupTableAddress,
        addresses: addresses.slice(i * ixBatchSize, (i + 1) * ixBatchSize)
      })
    )
  }

  const initTx = new Transaction().add(lookupTableInst, extendIxs[0])
  const remainingTxs = extendIxs.slice(1).map(ix => new Transaction().add(ix))

  return { lookupTableAddress, txs: [initTx, ...remainingTxs] }
}

export const serializePoolLookupTable = (t: AddressLookupTableAccount, poolData: PoolStructure) => {
  const addrs = t.state.addresses

  if (addrs[2].equals(poolData.tokenXReserve) && addrs[3].equals(poolData.tokenYReserve)) {
    const data = serializeLookupTableData(t)

    const pooladdr = addrs[0].toString()
    const isMainTable = true
    return { poolAddr: pooladdr, isMainTable, data }
  } else {
    const data = serializeLookupTableData(t)

    const poolAddr = addrs[0].toString()
    const tickIndex = getRealTickFromAdjustedLookupTableStartingTick(
      poolData.tickSpacing,
      new BN(addrs[1].toBytes()).toNumber()
    )

    return { poolAddr: poolAddr, tickIndex: tickIndex.toString(), data }
  }
}

export const serializeLookupTableData = (
  t: AddressLookupTableAccount
): SerializedLookupTableData['data'] => {
  return {
    key: t.key.toString(),
    state: {
      lastExtendedSlot: t.state.lastExtendedSlot,
      lastExtendedSlotStartIndex: t.state.lastExtendedSlotStartIndex,
      deactivationSlot: t.state.deactivationSlot.toString(),
      authority: t.state.authority?.toString(),
      addresses: t.state.addresses.map(a => a.toString())
    }
  }
}

export type SerializedLookupTableData = {
  poolAddr: string
  data: {
    key: string
    state: {
      deactivationSlot: string
      lastExtendedSlot: number
      lastExtendedSlotStartIndex: number
      authority: string | undefined
      addresses: string[]
    }
  }
} & NonNullable<
  | {
      isMainTable: undefined
      tickIndex: string
    }
  | {
      tickIndex: undefined
      isMainTable: boolean
    }
>

export type SimulateSwapAndCreatePositionSimulation = {
  swapInput?: { xToY: boolean; swapAmount: BN; byAmountIn: boolean }
  swapSimulation?: SimulationResult
  position: {
    x: BN
    y: BN
    liquidity: BN
  }
}

export enum InvariantEventNames {
  CreatePositionEvent = 'CreatePositionEvent',
  RemovePositionEvent = 'RemovePositionEvent',
  SwapEvent = 'SwapEvent'
}
export type InvariantEvent = NonNullable<RemovePositionEvent | CreatePositionEvent | SwapEvent>

export interface WrappedEthInstructions {
  createIx: TransactionInstruction
  initIx: TransactionInstruction
  unwrapIx: TransactionInstruction
}
export interface WrappedEthTransferInstructions extends WrappedEthInstructions {
  transferIx: TransactionInstruction
}

export interface TokenData {
  id: string
  decimals: number
  ticker: string
}
export interface ParsedTick {
  liquidity: BN
  index: number
  feeGrowthOutsideX: BN
  feeGrowthOutsideY: BN
}

export interface LiquidityRange {
  tickLower: number
  tickUpper: number
}

export interface RangeData {
  tokens: BN
  tickLower: number
  tickUpper: number
}
export interface RewardData {
  tokens: BN
  liquidity: BN
  singleTickTokens: BN
  singleTickLiquidity: BN
}
export interface ApyPoolParams {
  feeTier: FeeTier
  currentTickIndex: number
  activeTokens: BN
  ticksPreviousSnapshot: Tick[]
  ticksCurrentSnapshot: Tick[]
  weeklyData: WeeklyData
  volumeX: number
  volumeY: number
}
export interface ApyRewardsParams {
  currentTickIndex: number
  currentLiquidity: BN
  allLiquidityInTokens: BN
  tickSpacing: number
  rewardInUsd: number
  tokenPrice: number
  tokenBN: number
  duration: number
}
export interface UserDailyRewardsParams {
  poolLiquidity: BN
  currentTickIndex: number
  rewardInTokens: number
  userLiquidity: BN
  duration: number
  lowerTickIndex: number
  upperTickIndex: number
}

export interface ApyPositionRewardsParams {
  poolLiquidity: BN
  currentTickIndex: number
  rewardInUsd: number
  tokenPrice: number
  tokenBN: number
  duration: number
  positionLiquidity: BN
  lowerTickIndex: number
  upperTickIndex: number
}

export interface WeeklyData {
  weeklyFactor: number[]
  weeklyRange: Range[]
  tokenXamount: BN
  volumeX: number
  apy: number
}

export interface Range {
  tickLower: number | null
  tickUpper: number | null
}
