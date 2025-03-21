import * as anchor from '@coral-xyz/anchor'
import { Provider, BN } from '@coral-xyz/anchor'
import { createAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { assert } from 'chai'
import { createToken } from './testUtils'
import {
  Market,
  Pair,
  LIQUIDITY_DENOMINATOR,
  TICK_LIMIT,
  Network,
  calculatePriceSqrt,
  PRICE_DENOMINATOR
} from '@invariant-labs/sdk'
import { Decimal, FeeTier } from '@invariant-labs/sdk/lib/market'
import {
  assertThrowsAsync,
  fromFee,
  getBalance,
  simulateSwap,
  SimulationResult,
  SimulationStatus
} from '@invariant-labs/sdk/lib/utils'
import { toDecimal, tou64 } from '@invariant-labs/sdk/src/utils'
import {
  CreateFeeTier,
  CreatePool,
  CreateTick,
  CreatePosition,
  Swap
} from '@invariant-labs/sdk/src/market'
import { swapParameters } from './liquidity-gap-swap'
import { getSearchLimit } from '@invariant-labs/sdk/src/tickmap'
import { sleep } from '@invariant-labs/sdk'

describe('Liquidity gap', () => {
  const provider = anchor.AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const positionOwner = Keypair.generate()
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey
  let market: Market
  let owner: Keypair
  let assumedTargetPrice: Decimal
  let accountX: PublicKey
  let accountY: PublicKey
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 10
  }
  let pair: Pair

  before(async () => {
    market = await Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    // Request airdrops
    await Promise.all([
      await connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      await connection.requestAirdrop(admin.publicKey, 1e9)
    ])
    // Create tokens
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])

    pair = new Pair(tokens[0], tokens[1], feeTier)

    await market.createState(admin.publicKey, admin)

    const createFeeTierVars: CreateFeeTier = {
      feeTier,
      admin: admin.publicKey
    }
    await market.createFeeTier(createFeeTierVars, admin)
  })
  it('#create()', async () => {
    const createPoolVars: CreatePool = {
      pair,
      payer: admin
    }
    await market.createPool(createPoolVars)

    const createdPool = await market.getPool(pair)
    assert.ok(createdPool.tokenX.equals(pair.tokenX))
    assert.ok(createdPool.tokenY.equals(pair.tokenY))
    assert.ok(createdPool.fee.eq(feeTier.fee))
    assert.equal(createdPool.tickSpacing, feeTier.tickSpacing)
    assert.ok(createdPool.liquidity.eqn(0))
    assert.ok(createdPool.sqrtPrice.eq(PRICE_DENOMINATOR))
    assert.ok(createdPool.currentTickIndex === 0)
    assert.ok(createdPool.feeGrowthGlobalX.eqn(0))
    assert.ok(createdPool.feeGrowthGlobalY.eqn(0))
    assert.ok(createdPool.feeProtocolTokenX.eqn(0))
    assert.ok(createdPool.feeProtocolTokenY.eqn(0))

    const tickmapData = await market.getTickmap(pair)
    assert.ok(tickmapData.bitmap.length === TICK_LIMIT / 4)
    assert.ok(tickmapData.bitmap.every(v => v === 0))
  })
  it('swap to limit without crossing', async () => {
    // Deposit
    const upperTick = 10
    const createTickVars: CreateTick = {
      pair,
      index: upperTick,
      payer: admin.publicKey
    }
    await market.createTick(createTickVars, admin)

    const lowerTick = -10
    const createTickVars2: CreateTick = {
      pair,
      index: lowerTick,
      payer: admin.publicKey
    }
    await market.createTick(createTickVars2, admin)

    await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    await sleep(1000)
    userTokenXAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenX,
      positionOwner.publicKey
    )
    userTokenYAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenY,
      positionOwner.publicKey
    )
    const mintAmount = new BN(10).pow(new BN(10))

    await mintTo(
      connection,
      mintAuthority,
      pair.tokenX,
      userTokenXAccount,
      mintAuthority,
      mintAmount
    )
    await mintTo(
      connection,
      mintAuthority,
      pair.tokenY,
      userTokenYAccount,
      mintAuthority,
      mintAmount
    )
    const liquidityDelta = new BN(20006000).mul(LIQUIDITY_DENOMINATOR)

    await market.createPositionList(positionOwner.publicKey, positionOwner)

    const initPositionVars: CreatePosition = {
      pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick,
      upperTick,
      liquidityDelta,
      knownPrice: PRICE_DENOMINATOR,
      slippage: new BN(0)
    }
    await market.createPosition(initPositionVars, positionOwner)

    assert.ok((await market.getPool(pair)).liquidity.eq(liquidityDelta))

    // Create owner
    owner = Keypair.generate()
    await connection.requestAirdrop(owner.publicKey, 1e9)
    await sleep(1000)

    const amount = new BN(10067)
    accountX = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenX,
      owner.publicKey
    )
    accountY = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenY,
      owner.publicKey
    )
    await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, amount)

    // Swap
    const poolDataBefore = await market.getPool(pair)
    const reserveXBefore = await getBalance(connection, poolDataBefore.tokenXReserve)
    const reserveYBefore = await getBalance(connection, poolDataBefore.tokenYReserve)

    const swapVars: Swap = {
      pair,
      xToY: true,
      amount,
      estimatedPriceAfterSwap: poolDataBefore.sqrtPrice, // ignore price impact using high slippage tolerance
      slippage: toDecimal(1, 0),
      accountX,
      accountY,
      byAmountIn: true,
      owner: owner.publicKey
    }
    await market.swap(swapVars, owner)
    await sleep(1000)

    // Check pool
    const poolData = await market.getPool(pair)
    assumedTargetPrice = poolData.sqrtPrice
    const sqrtPriceAtTick = calculatePriceSqrt(lowerTick)

    assert.ok(poolData.liquidity.eq(poolDataBefore.liquidity))
    assert.ok(poolData.currentTickIndex === lowerTick)
    assert.ok(poolData.sqrtPrice.eq(sqrtPriceAtTick))

    // Check amounts and fees
    const amountX = await getBalance(connection, accountX)
    const amountY = await getBalance(connection, accountY)
    const reserveXAfter = await getBalance(connection, poolDataBefore.tokenXReserve)
    const reserveYAfter = await getBalance(connection, poolDataBefore.tokenYReserve)
    const reserveXDelta = reserveXAfter.sub(reserveXBefore)
    const reserveYDelta = reserveYBefore.sub(reserveYAfter)
    const expectedYAmountOut = new BN(9999)

    // fee tokens           0.006 * 10067 = ceil(60.402) = 61
    // protocol fee tokens  ceil(61 * 0.01) = cei(0.61) = 1
    // pool fee tokens      61 - 1 = 60
    // fee growth global    60/20006000 = 2.9991002699190242927 * 10^-6
    assert.ok(amountX.eqn(0))
    assert.ok(amountY.eq(expectedYAmountOut))
    assert.ok(reserveXDelta.eq(amount))
    assert.ok(reserveYDelta.eq(expectedYAmountOut))
    assert.equal(poolData.feeGrowthGlobalX.toString(), '2999100269919024292')
    assert.ok(poolData.feeGrowthGlobalY.eqn(0))
    assert.ok(poolData.feeProtocolTokenX.eqn(1))
    assert.ok(poolData.feeProtocolTokenY.eqn(0))
  })
  it('no liquidity swap should fail', async () => {
    // no liquidity swap
    const swapVars2: Swap = {
      pair,
      xToY: true,
      amount: new BN(1),
      estimatedPriceAfterSwap: assumedTargetPrice, // ignore price impact using high slippage tolerance
      slippage: toDecimal(1, 0),
      accountX,
      accountY,
      byAmountIn: true,
      owner: owner.publicKey
    }
    await assertThrowsAsync(market.swap(swapVars2, owner))
  })
  it('should skip gap then swap', async () => {
    // Add liquidity
    const upperTickAfterSwap = -50
    const createTickVars: CreateTick = {
      pair,
      index: upperTickAfterSwap,
      payer: admin.publicKey
    }
    await market.createTick(createTickVars, admin)
    const lowerTickAfterSwap = -90
    const createTickVars2: CreateTick = {
      pair,
      index: lowerTickAfterSwap,
      payer: admin.publicKey
    }
    await market.createTick(createTickVars2, admin)

    const liquidityDelta = new BN(20008000).mul(LIQUIDITY_DENOMINATOR)
    const initPositionAfterSwapVars: CreatePosition = {
      pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: lowerTickAfterSwap,
      upperTick: upperTickAfterSwap,
      liquidityDelta,
      knownPrice: (await market.getPool(pair)).sqrtPrice,
      slippage: new BN(0)
    }
    await market.createPosition(initPositionAfterSwapVars, positionOwner)
    const nextSwapAmount = new BN(5000)
    await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, nextSwapAmount)

    // const poolDataBefore = await market.getPool(pair)
    // const reserveXBefore = (await tokenX.getAccountInfo(poolDataBefore.tokenXReserve)).amount
    // const reserveYBefore = (await tokenY.getAccountInfo(poolDataBefore.tokenYReserve)).amount

    const nextSwapVars: Swap = {
      pair,
      xToY: true,
      amount: nextSwapAmount,
      estimatedPriceAfterSwap: assumedTargetPrice, // ignore price impact using high slippage tolerance
      slippage: toDecimal(1, 0),
      accountX,
      accountY,
      byAmountIn: true,
      owner: owner.publicKey
    }
    await market.swap(nextSwapVars, owner)

    // Check pool
    // const poolData = await market.getPool(pair)

    // TODO: validate state
    // assert.ok(
    //   poolData.liquidity.sub(poolDataBefore.liquidity).eq(new BN(2000).mul(DENOMINATOR))
    // )
    // assert.equal(poolData.currentTickIndex, -70)
    // assert.ok(poolData.sqrtPrice.eq(new BN('996515578784')))

    // // Check amounts and fees
    // const amountX = (await tokenX.getAccountInfo(accountX)).amount
    // const amountY = (await tokenY.getAccountInfo(accountY)).amount
    // const reserveXAfter = (await tokenX.getAccountInfo(poolData.tokenXReserve)).amount
    // const reserveYAfter = (await tokenY.getAccountInfo(poolData.tokenYReserve)).amount
    // const reserveXDelta = reserveXAfter.sub(reserveXBefore)
    // const reserveYDelta = reserveYBefore.sub(reserveYAfter)

    // assert.ok(amountX.eqn(0))
    // assert.ok(amountY.eq(new BN(29760)))
    // assert.ok(reserveXDelta.eq(nextSwapAmount))
    // assert.ok(reserveYDelta.eq(new BN(19761)))
    // assert.ok(poolData.feeGrowthGlobalX.eq(new BN('7197360983628142266')))
    // assert.ok(poolData.feeGrowthGlobalY.eqn(0))
    // assert.ok(poolData.feeProtocolTokenX.eqn(37))
    // assert.ok(poolData.feeProtocolTokenY.eqn(0))
  })

  it('simulate swap with liquidity gap higher than search limit works', () => {
    const simulationResult: SimulationResult = simulateSwap(swapParameters)
    const searchLimit = getSearchLimit(
      new BN(swapParameters.pool.currentTickIndex),
      new BN(swapParameters.pool.tickSpacing),
      !swapParameters.xToY
    )

    assert.equal(simulationResult.status, SimulationStatus.Ok)
    assert.ok(
      swapParameters.xToY
        ? simulationResult.crossedTicks[1] < searchLimit
        : simulationResult.crossedTicks[1] > searchLimit
    )
    assert.equal(simulationResult.amountPerTick.length, 3)
    assert.ok(simulationResult.amountPerTick[1].eq(new BN(0)))
  })
})
