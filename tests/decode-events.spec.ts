import { Market, calculatePriceSqrt, Pair, Network, sleep, fromInteger } from '@invariant-labs/sdk'
import {
  CreateFeeTier,
  CreateTick,
  FeeTier,
  CreatePosition,
  RemovePosition,
  Swap
} from '@invariant-labs/sdk/lib/market'
import { fromFee, getBalance, toDecimal } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { assert } from 'chai'
import { createToken, initMarket } from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import {
  CreatePool,
  CreatePositionEvent,
  RemovePositionEvent,
  SwapEvent
} from '@invariant-labs/sdk/src/market'
import { parseEvent } from '@invariant-labs/sdk/src/utils'
import { LIQUIDITY_DENOMINATOR } from '@invariant-labs/sdk'

describe('Decode events', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const transferPositionPayer = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 3
  }
  let market: Market
  let pair: Pair
  let initTick: number
  let ticksIndexes: number[]
  let xOwnerAmount: BN
  let yOwnerAmount: BN
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey

  before(async () => {
    market = await Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    // Request airdrops
    await Promise.all([
      connection.requestAirdrop(wallet.publicKey, 1e9),
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9),
      connection.requestAirdrop(transferPositionPayer.publicKey, 1e9)
    ])
    // Create pair
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])
    pair = new Pair(tokens[0], tokens[1], feeTier)

    // user deposit
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

    await market.createState(admin.publicKey, admin)

    const createFeeTierVars: CreateFeeTier = {
      feeTier,
      admin: admin.publicKey
    }
    await market.createFeeTier(createFeeTierVars, admin)
  })
  describe('Settings', () => {
    it('Prepare pool', async () => {
      initTick = -23028

      const createPoolVars: CreatePool = {
        pair,
        payer: admin,
        initTick
      }
      await market.createPool(createPoolVars)
      await market.createPositionList(positionOwner.publicKey, positionOwner)

      ticksIndexes = [-9780, -42, 0, 9, 276, 32343, -50001]
      await Promise.all(
        ticksIndexes.map(async tickIndex => {
          const createTickVars: CreateTick = {
            index: tickIndex,
            pair,
            payer: admin.publicKey
          }
          await market.createTick(createTickVars, admin)
        })
      )
    })
  })
  describe('#Emit events()', () => {
    it('Create position event', async () => {
      xOwnerAmount = 1e10 as any
      yOwnerAmount = 1e10 as any

      await mintTo(
        connection,
        mintAuthority,
        pair.tokenX,
        userTokenXAccount,
        mintAuthority,
        xOwnerAmount as any
      )
      await mintTo(
        connection,
        mintAuthority,
        pair.tokenY,
        userTokenYAccount,
        mintAuthority,
        yOwnerAmount as any
      )

      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[1],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars, positionOwner)
    })
    it('Remove position event', async () => {
      const positionIndexToRemove = 0
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)

      const removePositionVars: RemovePosition = {
        pair,
        owner: positionOwner.publicKey,
        index: positionIndexToRemove,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      }
      await market.removePosition(removePositionVars, positionOwner)

      const positionListAfter = await market.getPositionList(positionOwner.publicKey)

      // check position list head
      assert.ok(positionListBefore.head - 1 === positionListAfter.head)
    })
  })
  describe('#Decode events()', () => {
    it('Decode all works', async () => {
      // ensure the transaction are confirmed
      await sleep(1200)

      const emptyPoolLogs = await connection.getSignaturesForAddress(
        market.getEventOptAccount(PublicKey.default).address,
        undefined,
        'confirmed'
      )

      assert.equal(emptyPoolLogs.length, 0)

      const logs = await connection.getSignaturesForAddress(
        market.getEventOptAccount(pair.getAddress(market.program.programId)).address,
        undefined,
        'confirmed'
      )

      const signatures = logs.map(log => log.signature)

      const messageLogs = await Promise.all(
        signatures.map(async signature => {
          const parsed = await connection.getParsedTransaction(signature, 'confirmed')
          if (parsed?.meta?.logMessages) {
            return parsed.meta.logMessages
          }
        })
      )

      const eventLogs = messageLogs.map(logs => logs!.find(log => log.startsWith('Program data:')))

      // All queried transactions should contain an event
      assert.equal(messageLogs.length, eventLogs.length)

      const events = eventLogs.map(log =>
        market.eventDecoder.decode((log as string).split('Program data: ')[1])
      )

      assert.equal(events.length, 2)
      assert.equal(events.length, messageLogs.length)

      const queriedRemovePositionEvent = events[0]
      const queriedCreatePositionEvent = events[1]

      // Check remove position event
      {
        const eventData = parseEvent(queriedRemovePositionEvent) as RemovePositionEvent

        assert.ok(positionOwner.publicKey.equals(eventData.owner))
        assert.equal(eventData.currentTick, initTick)
        assert.equal(eventData.lowerTick, ticksIndexes[0])
        assert.equal(eventData.upperTick, ticksIndexes[1])
        assert.ok(eventData.id.eqn(0))
        assert.ok(eventData.pool.equals(pair.getAddress(market.program.programId)))
        assert.ok(eventData.lowerTickSecondsPerLiquidityOutside.eqn(0))
        assert.ok(eventData.upperTickSecondsPerLiquidityOutside.eqn(0))
        assert.ok(eventData.poolSecondsPerLiquidityGlobal.eqn(0))
        assert.ok(eventData.liquidity.eq(fromInteger(1)))
      }

      // Check create position event
      {
        const eventData = parseEvent(queriedCreatePositionEvent) as CreatePositionEvent

        assert.ok(positionOwner.publicKey.equals(eventData.owner))
        assert.ok(eventData.liquidity.eq(fromInteger(1)))
        assert.ok(eventData.id.eqn(0))
        assert.ok(eventData.pool.equals(pair.getAddress(market.program.programId)))
        assert.ok(eventData.secondsPerLiquidityInsideInitial.eqn(0))
        assert.equal(eventData.lowerTick, ticksIndexes[0])
        assert.equal(eventData.upperTick, ticksIndexes[1])
      }
    })
  })
  describe('#Emit swap events()', () => {
    const provider = AnchorProvider.local()
    const connection = provider.connection
    // @ts-expect-error
    const wallet = provider.wallet.payer as Keypair
    const swapper = Keypair.generate()
    const mintAuthority = Keypair.generate()
    const feeTier: FeeTier = {
      fee: fromFee(new BN(600)),
      tickSpacing: 10
    }
    let market: Market
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
        connection.requestAirdrop(mintAuthority.publicKey, 1e9),
        connection.requestAirdrop(admin.publicKey, 1e9)
      ])

      // Create tokens
      const tokens = await Promise.all([
        createToken(connection, wallet, mintAuthority),
        createToken(connection, wallet, mintAuthority)
      ])

      pair = new Pair(tokens[0], tokens[1], feeTier)
    })

    it('#init()', async () => {
      await initMarket(market, [pair], admin)
    })

    it('#swap() within a tick', async () => {
      // Deposit
      const upperTick = 10
      const createTickVars: CreateTick = {
        pair,
        index: upperTick,
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)

      const lowerTick = -20
      const createTickVars2: CreateTick = {
        pair,
        index: lowerTick,
        payer: admin.publicKey
      }
      await market.createTick(createTickVars2, admin)

      const positionOwner = Keypair.generate()
      await connection.requestAirdrop(positionOwner.publicKey, 1e9)
      await sleep(400)
      const userTokenXAccount = await createAssociatedTokenAccount(
        connection,
        positionOwner,
        pair.tokenX,
        positionOwner.publicKey
      )
      const userTokenYAccount = await createAssociatedTokenAccount(
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
        BigInt(mintAmount.toString())
      )
      await mintTo(
        connection,
        mintAuthority,
        pair.tokenY,
        userTokenYAccount,
        mintAuthority,
        BigInt(mintAmount.toString())
      )
      const liquidityDelta = new BN(1000000).mul(LIQUIDITY_DENOMINATOR)

      await market.createPositionList(positionOwner.publicKey, positionOwner)

      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: -Infinity,
        upperTick: Infinity,
        liquidityDelta,
        knownPrice: (await market.getPool(pair)).sqrtPrice,
        slippage: new BN(0)
      }

      await market.createPosition(initPositionVars, positionOwner)

      assert.ok((await market.getPool(pair)).liquidity.eq(liquidityDelta))

      // Create owner
      await connection.requestAirdrop(swapper.publicKey, 1e9)

      const amount = new BN(1000)
      const accountX = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pair.tokenX,
        swapper.publicKey
      )
      const accountY = await createAssociatedTokenAccount(
        connection,
        mintAuthority,
        pair.tokenY,
        swapper.publicKey
      )
      await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, amount as any)

      // Swap
      const poolDataBefore = await market.getPool(pair)
      const reserveXBefore = await getBalance(connection, poolDataBefore.tokenXReserve)
      const reserveYBefore = await getBalance(connection, poolDataBefore.tokenYReserve)

      const swapVars: Swap = {
        pair,
        xToY: true,
        amount,
        estimatedPriceAfterSwap: poolDataBefore.sqrtPrice, // ignore price impact using high slippage tolerance
        slippage: toDecimal(1, 2),
        accountX,
        accountY,
        byAmountIn: true,
        owner: swapper.publicKey
      }
      await market.swap(swapVars, swapper)
      await sleep(400)

      // Check pool
      const poolData = await market.getPool(pair)
      assert.ok(poolData.liquidity.eq(poolDataBefore.liquidity))
      assert.equal(poolData.currentTickIndex, lowerTick)
      assert.ok(poolData.sqrtPrice.lt(poolDataBefore.sqrtPrice))

      // Check amounts and fees
      const amountX = await getBalance(connection, accountX)
      const amountY = await getBalance(connection, accountY)
      const reserveXAfter = await getBalance(connection, poolData.tokenXReserve)
      const reserveYAfter = await getBalance(connection, poolData.tokenYReserve)
      const reserveXDelta = reserveXAfter.sub(reserveXBefore)
      const reserveYDelta = reserveYBefore.sub(reserveYAfter)

      // fee tokens           0.006 * 1000 = 6
      // protocol fee tokens  ceil(6 * 0.01) = cei(0.06) = 1
      // pool fee tokens      6 - 1 = 5
      // fee growth global    5/1000000 = 5 * 10^-6
      assert.ok(amountX.eqn(0))
      assert.ok(amountY.eq(amount.subn(7)))
      assert.ok(reserveXDelta.eq(amount))
      assert.ok(reserveYDelta.eq(amount.subn(7)))
      assert.equal(poolData.feeGrowthGlobalX.toString(), '5000000000000000000')
      assert.ok(poolData.feeGrowthGlobalY.eqn(0))
      assert.ok(poolData.feeProtocolTokenX.eqn(1))
      assert.ok(poolData.feeProtocolTokenY.eqn(0))
      assert.equal(poolData.currentTickIndex, -20)
    })
    it('Get and decode swap event', async () => {
      // ensure the transaction are confirmed
      await sleep(1200)

      const logs = await connection.getSignaturesForAddress(
        pair.getAddress(market.program.programId),
        undefined,
        'confirmed'
      )

      const signatures = logs.map(log => log.signature)[0]

      const messageLogs = await Promise.all(
        [signatures].map(async signature => {
          const parsed = await connection.getParsedTransaction(signature, 'confirmed')
          if (parsed?.meta?.logMessages) {
            return parsed.meta.logMessages
          }
        })
      )

      const eventLogs = messageLogs.map(logs => logs!.find(log => log.startsWith('Program data:')))

      // All queried transactions should contain an event
      assert.equal(messageLogs.length, eventLogs.length)

      const events = eventLogs.map(log =>
        market.eventDecoder.decode((log as string).split('Program data: ')[1])
      )

      assert.equal(events.length, 1)
      assert.equal(events.length, messageLogs.length)

      const queriedSwapEvent = events[0]

      // Check swap event
      {
        const eventData = parseEvent(queriedSwapEvent) as SwapEvent
        assert.ok(swapper.publicKey.equals(eventData.swapper))
        assert.ok(eventData.fee.eqn(6))
        assert.ok(eventData.xToY)
        assert.ok(eventData.tokenX.equals(pair.tokenX))
        assert.ok(eventData.tokenY.equals(pair.tokenY))
        assert.ok(eventData.priceBeforeSwap.gt(eventData.priceAfterSwap))
      }
    })
  })
})
