import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { createToken, getTimestampInSeconds, initMarket } from './testUtils'
import { Market, Pair, Network } from '@invariant-labs/sdk'
import { Network as LockerNetwork } from '@invariant-labs/locker-sonic-sdk'
import { FeeTier, CreatePosition } from '@invariant-labs/sdk/lib/market'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import { Locker } from '@invariant-labs/locker-sonic-sdk'
import { assert } from 'chai'
import { CreateTick } from '@invariant-labs/sdk/src/market'
import { calculatePriceSqrt } from '@invariant-labs/sdk'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { LIQUIDITY_DENOMINATOR } from '@invariant-labs/sdk'
import { sleep } from '@invariant-labs/sdk'
import { getBalance } from '@invariant-labs/locker-sonic-sdk/lib/utils'
import { ILockPosition } from '@invariant-labs/locker-sonic-sdk/src'
import { IUnlockPosition } from '@invariant-labs/locker-sonic-sdk/lib/locker'

describe('Unlock', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const positionOwner = Keypair.generate()
  const feeTier: FeeTier = { fee: fromFee(new BN(20)), tickSpacing: 4 }
  const MAX_TICK = 177_450 // for tickSpacing 4
  const MIN_TICK = -MAX_TICK
  const lowerTick = MIN_TICK + 10
  const upperTick = MAX_TICK - 10
  const initTick = -23028
  const lockDuration = new BN(5) // 5 seconds

  let market: Market
  let locker: Locker
  let pair: Pair

  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey
  let xOwnerAmount: BN
  let yOwnerAmount: BN

  before(async () => {
    market = Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    locker = Locker.build(
      LockerNetwork.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Locker.programId
    )

    // Request airdrops
    await Promise.all([
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9)
    ])
    // Create tokens
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])

    pair = new Pair(tokens[0], tokens[1], feeTier)
  })

  it('#init()', async () => {
    await initMarket(market, [pair], admin, initTick)
  })
  it('#createPositionList()', async () => {
    await market.createPositionList(positionOwner.publicKey, positionOwner)

    const positionList = await market.getPositionList(positionOwner.publicKey)
    assert.equal(positionList.head, 0)
  })
  describe('#deposit() within current tick', () => {
    // min + 10
    // max - 10
    // x = 317
    // y = 32
    // liquidity = 100

    it('#createTick(lower)', async () => {
      const createTickVars: CreateTick = {
        index: lowerTick,
        pair,
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)

      const expectedZeroDecimal = new BN(0)
      const tick = await market.getTick(pair, lowerTick)
      const { tickBump } = market.getTickAddress(pair, lowerTick)
      assert.ok(tick.pool.equals(await pair.getAddress(market.program.programId)))
      assert.ok(tick.index === lowerTick)
      assert.ok(tick.liquidityChange.eq(expectedZeroDecimal))
      assert.ok(tick.liquidityGross.eq(expectedZeroDecimal))
      assert.ok(tick.sqrtPrice.eq(calculatePriceSqrt(lowerTick)))
      assert.ok(tick.feeGrowthOutsideX.eq(expectedZeroDecimal))
      assert.ok(tick.feeGrowthOutsideY.eq(expectedZeroDecimal))
      assert.ok(tick.bump === tickBump)
    })
    it('#createTick(upperTick)', async () => {
      const createTickVars: CreateTick = {
        index: upperTick,
        pair,
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)

      const expectedZeroDecimal = new BN(0)
      const tick = await market.getTick(pair, upperTick)
      const { tickBump } = await market.getTickAddress(pair, upperTick)
      assert.ok(tick.pool.equals(await pair.getAddress(market.program.programId)))
      assert.ok(tick.index === upperTick)
      assert.ok(tick.liquidityChange.eq(expectedZeroDecimal))
      assert.ok(tick.liquidityGross.eq(expectedZeroDecimal))
      assert.ok(tick.sqrtPrice.eq(calculatePriceSqrt(upperTick)))
      assert.ok(tick.feeGrowthOutsideX.eq(expectedZeroDecimal))
      assert.ok(tick.feeGrowthOutsideY.eq(expectedZeroDecimal))
      assert.ok(tick.bump === tickBump)
    })
    it('lock position', async () => {
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

      xOwnerAmount = new BN(1e10)
      yOwnerAmount = new BN(1e10)

      await mintTo(
        connection,
        mintAuthority,
        pair.tokenX,
        userTokenXAccount,
        mintAuthority,
        xOwnerAmount
      )
      await mintTo(
        connection,
        mintAuthority,
        pair.tokenY,
        userTokenYAccount,
        mintAuthority,
        yOwnerAmount
      )

      const liquidityDelta = LIQUIDITY_DENOMINATOR.muln(100)
      const reserveBalancesBefore = await market.getReserveBalances(pair)

      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick,
        upperTick,
        liquidityDelta: liquidityDelta,
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }

      await market.createPosition(initPositionVars, positionOwner)

      const lockPositionVars: ILockPosition = {
        index: 0,
        market,
        lockDuration,
        payer: positionOwner
      }

      await locker.lockPosition(lockPositionVars)
      // Validate Market State
      await sleep(400)
      // load state
      const positionIndex = 0
      const [authority] = locker.getUserLocksAddress(positionOwner.publicKey)
      const positionState = await market.getPosition(authority, positionIndex)
      const poolState = await market.getPool(pair)
      const lowerTickState = await market.getTick(pair, lowerTick)
      const upperTickState = await market.getTick(pair, upperTick)
      const reserveBalancesAfter = await market.getReserveBalances(pair)
      const userTokenXBalance = await getBalance(connection, userTokenXAccount)
      const userTokenYBalance = await getBalance(connection, userTokenYAccount)
      const { positionBump } = market.getPositionAddress(authority, positionIndex)
      const expectedZeroDecimal = new BN(0)
      const expectedXIncrease = new BN(317)
      const expectedYIncrease = new BN(32)

      // check ticks
      assert.ok(lowerTickState.index === lowerTick)
      assert.ok(lowerTickState.sign)
      assert.ok(lowerTickState.liquidityGross.eq(liquidityDelta))
      assert.ok(lowerTickState.liquidityChange.eq(liquidityDelta))

      assert.ok(upperTickState.index === upperTick)
      assert.ok(!upperTickState.sign)
      assert.ok(upperTickState.liquidityGross.eq(liquidityDelta))
      assert.ok(upperTickState.liquidityChange.eq(liquidityDelta))

      // check pool
      assert.ok(poolState.liquidity.eq(liquidityDelta))
      assert.ok(poolState.currentTickIndex === initTick)

      // check position
      const poolAddress = pair.getAddress(market.program.programId)
      assert.ok(positionState.owner.equals(authority))
      assert.ok(positionState.pool.equals(poolAddress))
      assert.ok(positionState.id.eqn(0))
      assert.ok(positionState.liquidity.eq(liquidityDelta))
      assert.ok(positionState.lowerTickIndex === lowerTick)
      assert.ok(positionState.upperTickIndex === upperTick)
      assert.ok(positionState.feeGrowthInsideX.eq(expectedZeroDecimal))
      assert.ok(positionState.feeGrowthInsideY.eq(expectedZeroDecimal))
      assert.ok(positionState.bump === positionBump)

      // checks position list
      const positionList = await market.getPositionList(authority)
      assert.equal(positionList.head, positionIndex + 1)
      const ownerPositionList = await market.getPositionList(positionOwner.publicKey)
      assert.equal(ownerPositionList.head, 0)

      // balance transfer
      assert.ok(reserveBalancesAfter.x.eq(reserveBalancesBefore.x.add(expectedXIncrease)))
      assert.ok(reserveBalancesAfter.y.eq(reserveBalancesBefore.y.add(expectedYIncrease)))
      assert.ok(userTokenXBalance.eq(xOwnerAmount.sub(expectedXIncrease)))
      assert.ok(userTokenYBalance.eq(yOwnerAmount.sub(expectedYIncrease)))

      xOwnerAmount = userTokenXBalance
      yOwnerAmount = userTokenYBalance

      // Validate locker state
      const locks = await locker.getUserLocks(positionOwner.publicKey)

      assert.ok(locks.positions.length === 1)
      assert.ok(locks.positions[0].positionId.eqn(0))
      // TODO: Find a better way to validate end timestamp
      assert.ok(locks.positions[0].endTimestamp.lt(getTimestampInSeconds().add(lockDuration)))
    })
  })
  describe('#unlock()', async () => {
    it('Ensure lock expires', async () => {
      await sleep(lockDuration.muln(1000).toNumber())
    })
    it('#unlock()', async () => {
      const withdrawParams: IUnlockPosition = {
        payer: positionOwner,
        market,
        authorityListIndex: 0
      }

      await locker.unlockPosition(withdrawParams)

      // Validate Market State
      await sleep(400)
      // load state
      const positionIndex = 0

      const positionState = await market.getPosition(positionOwner.publicKey, positionIndex)
      const poolState = await market.getPool(pair)
      const lowerTickState = await market.getTick(pair, lowerTick)
      const upperTickState = await market.getTick(pair, upperTick)
      const { positionBump } = market.getPositionAddress(positionOwner.publicKey, positionIndex)
      const expectedZeroDecimal = new BN(0)

      const liquidityDelta = LIQUIDITY_DENOMINATOR.muln(100)
      // check ticks
      assert.ok(lowerTickState.index === lowerTick)
      assert.ok(lowerTickState.sign)
      assert.ok(lowerTickState.liquidityGross.eq(liquidityDelta))
      assert.ok(lowerTickState.liquidityChange.eq(liquidityDelta))

      assert.ok(upperTickState.index === upperTick)
      assert.ok(!upperTickState.sign)
      assert.ok(upperTickState.liquidityGross.eq(liquidityDelta))
      assert.ok(upperTickState.liquidityChange.eq(liquidityDelta))

      // check pool
      assert.ok(poolState.liquidity.eq(liquidityDelta))
      assert.ok(poolState.currentTickIndex === initTick)

      // check position
      const poolAddress = pair.getAddress(market.program.programId)
      assert.ok(positionState.owner.equals(positionOwner.publicKey))
      assert.ok(positionState.pool.equals(poolAddress))
      assert.ok(positionState.id.eqn(0))
      assert.ok(positionState.liquidity.eq(liquidityDelta))
      assert.ok(positionState.lowerTickIndex === lowerTick)
      assert.ok(positionState.upperTickIndex === upperTick)
      assert.ok(positionState.feeGrowthInsideX.eq(expectedZeroDecimal))
      assert.ok(positionState.feeGrowthInsideY.eq(expectedZeroDecimal))
      assert.ok(positionState.bump === positionBump)

      // checks position list
      const [authority] = locker.getUserLocksAddress(positionOwner.publicKey)
      const positionList = await market.getPositionList(authority)
      assert.equal(positionList.head, 0)
      const ownerPositionList = await market.getPositionList(positionOwner.publicKey)
      assert.equal(ownerPositionList.head, positionIndex + 1)

      // Validate locker state
      const locks = await locker.getUserLocks(positionOwner.publicKey)

      assert.ok(locks.positions.length === 0)
    })
  })
})
