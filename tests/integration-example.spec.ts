import * as anchor from '@coral-xyz/anchor'
import { Provider, BN } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccount,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptAccount,
  getMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import { createToken, initMarket } from './testUtils'
import { Market, Pair, Network } from '@invariant-labs/sdk'
import {
  FeeTier,
  CreatePoolAndPosition,
  parseTick,
  RemovePosition,
  Tick
} from '@invariant-labs/sdk/lib/market'
import {
  createNativeAtaWithTransferInstructions,
  createNativeAtaInstructions,
  fromFee,
  getBalance,
  simulateSwap,
  SimulationStatus,
  swapSimulation,
  WrappedEthInstructions,
  WrappedEthTransferInstructions
} from '@invariant-labs/sdk/lib/utils'
import { toDecimal, tou64 } from '@invariant-labs/sdk/src/utils'
import { CreateTick, CreatePosition } from '@invariant-labs/sdk/src/market'
import {
  TICK_CROSSES_PER_IX,
  TICK_CROSSES_PER_IX_NATIVE_TOKEN
} from '@invariant-labs/sdk/lib/market'
import { findClosestTicks, getLiquidity, priceToTick } from '@invariant-labs/sdk/lib/math'
import { TICK_SEARCH_RANGE } from '@invariant-labs/sdk'
import { TICK_VIRTUAL_CROSSES_PER_IX } from '@invariant-labs/sdk/lib/market'
import { signAndSend } from '@invariant-labs/sdk'
import { getTokenProgramAddress } from '@invariant-labs/sdk'
import { calculatePriceSqrt } from '@invariant-labs/sdk'
import { alignTickToSpacing } from '@invariant-labs/sdk/src/tick'
import { sleep } from '@invariant-labs/sdk'

describe('sdk usage example', () => {
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
  let accountX: PublicKey
  let accountY: PublicKey
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 10
  }
  const otherFeeTier: FeeTier = {
    fee: fromFee(new BN(1000)),
    tickSpacing: 10
  }
  let pair: Pair
  let otherPair: Pair
  let wrappedEthPair: Pair

  const upperTick = 10
  const lowerTick = -10
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
    otherPair = new Pair(tokens[0], tokens[1], otherFeeTier)
    wrappedEthPair = new Pair(tokens[0], NATIVE_MINT, feeTier)

    await initMarket(market, [pair, wrappedEthPair], admin)

    // Create owner
    owner = Keypair.generate()
    await connection.requestAirdrop(owner.publicKey, 1e9)
    await sleep(400)

    // both atas must exist before the swap takes palce
    const ownerAccountX = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenX,
      owner.publicKey
    )
    const ownerAccountY = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenY,
      owner.publicKey
    )

    accountX = ownerAccountX
    accountY = ownerAccountY

    await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, new BN(10000000))
    await mintTo(connection, mintAuthority, pair.tokenY, accountY, mintAuthority, new BN(10000000))

    await market.createFeeTier(
      {
        feeTier: otherFeeTier,
        admin: admin.publicKey
      },
      admin
    )
  })
  it('create position', async () => {
    // first the ticks must be created if they don't exist already
    const createLowerTickVars: CreateTick = {
      pair,
      index: lowerTick,
      payer: admin.publicKey
    }

    const createUpperTickVars: CreateTick = {
      pair,
      index: upperTick,
      payer: admin.publicKey
    }

    const ticks = await market.getAllIndexedTicks(pair)
    if (!ticks.get(lowerTick)) {
      await market.createTick(createLowerTickVars, admin)
    }

    if (!ticks.get(upperTick)) {
      await market.createTick(createUpperTickVars, admin)
    }

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

    // create position list if it doesn't exist yet
    try {
      await market.getPositionList(positionOwner.publicKey)
    } catch (e) {
      await market.createPositionList(positionOwner.publicKey, positionOwner)
    }

    const positionList = await market.getPositionList(positionOwner.publicKey)

    // liquidity can be calculated using the getLiquidity function
    // it will return an amount of liquidity that can be payed for with both tokens
    const tokenXAmount = new BN(20000000)
    const tokenYAmount = new BN(20000000)
    const pool = await market.getPool(pair)
    const {
      x,
      y,
      liquidity: liquidityDelta
    } = getLiquidity(
      tokenXAmount,
      tokenYAmount,
      lowerTick,
      upperTick,
      pool.sqrtPrice,
      true,
      pool.tickSpacing
    )

    await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, x)
    await mintTo(connection, mintAuthority, pair.tokenY, userTokenYAccount, mintAuthority, y)
    // we're creating a position an pool in the same time so slippage can be 0
    const slippage = toDecimal(0, 0)

    const initPositionVars: CreatePosition = {
      pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick,
      upperTick,
      liquidityDelta,
      knownPrice: pool.sqrtPrice,
      slippage: slippage
    }

    await market.createPosition(initPositionVars, positionOwner, {
      positionList: { head: positionList.head, initialized: true },
      lowerTickExists: true,
      upperTickExists: true,
      pool,
      tokenXProgramAddress: TOKEN_PROGRAM_ID,
      tokenYProgramAddress: TOKEN_PROGRAM_ID
    })
  })

  it('create eth position', async () => {
    // first the ticks must be created if they don't exist already
    const createLowerTickVars: CreateTick = {
      pair: wrappedEthPair,
      index: lowerTick,
      payer: admin.publicKey
    }

    const createUpperTickVars: CreateTick = {
      pair: wrappedEthPair,
      index: upperTick,
      payer: admin.publicKey
    }

    const ticks = await market.getAllIndexedTicks(wrappedEthPair)
    if (!ticks.get(lowerTick)) {
      await market.createTick(createLowerTickVars, admin)
    }

    if (!ticks.get(upperTick)) {
      await market.createTick(createUpperTickVars, admin)
    }

    await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    await sleep(400)

    let token: PublicKey
    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      token = wrappedEthPair.tokenY
    } else {
      token = wrappedEthPair.tokenX
    }

    const userTokenAccount = getAssociatedTokenAddressSync(token, positionOwner.publicKey)

    const wrappedEthAccount = Keypair.generate()

    // create position list if it doesn't exist yet
    try {
      await market.getPositionList(positionOwner.publicKey)
    } catch (e) {
      await market.createPositionList(positionOwner.publicKey, positionOwner)
    }

    // liquidity can be calculated using the getLiquidity function
    // it will return an amount of liquidity that can be payed for with both tokens
    const tokenXAmount = new BN(20000000)
    const tokenYAmount = new BN(20000000)

    const pool = await market.getPool(wrappedEthPair)
    const {
      x,
      y,
      liquidity: liquidityDelta
    } = getLiquidity(
      tokenXAmount,
      tokenYAmount,
      lowerTick,
      upperTick,
      pool.sqrtPrice,
      true,
      pool.tickSpacing
    )

    let wethAmount: BN
    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      wethAmount = x
      await mintTo(
        connection,
        mintAuthority,
        wrappedEthPair.tokenY,
        userTokenAccount,
        mintAuthority,
        y
      )
    } else {
      wethAmount = y
      await mintTo(
        connection,
        mintAuthority,
        wrappedEthPair.tokenX,
        userTokenAccount,
        mintAuthority,
        x
      )
    }
    const { createIx, initIx, transferIx, unwrapIx } = createNativeAtaWithTransferInstructions(
      wrappedEthAccount.publicKey,
      positionOwner.publicKey,
      Network.LOCAL,
      wethAmount
    )

    // we're creating a position an pool in the same time so slippage can be 0
    const slippage = toDecimal(0, 0)

    let initPositionVars: CreatePosition

    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      initPositionVars = {
        pair: wrappedEthPair,
        owner: positionOwner.publicKey,
        userTokenX: wrappedEthAccount.publicKey,
        userTokenY: userTokenAccount,
        lowerTick,
        upperTick,
        liquidityDelta,
        knownPrice: pool.sqrtPrice,
        slippage: slippage
      }
    } else {
      initPositionVars = {
        pair: wrappedEthPair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenAccount,
        userTokenY: wrappedEthAccount.publicKey,
        lowerTick,
        upperTick,
        liquidityDelta,
        knownPrice: pool.sqrtPrice,
        slippage: slippage
      }
    }

    const initPositionIx = await market.createPositionTx(initPositionVars, {
      pool,
      lowerTickExists: true,
      upperTickExists: true,
      tokenXProgramAddress: TOKEN_PROGRAM_ID,
      tokenYProgramAddress: TOKEN_PROGRAM_ID
    })
    const tx = new Transaction()
      // first 3 ixs create a weth account
      // last one returns the funds to the wallet
      .add(createIx)
      .add(transferIx)
      .add(initIx)
      .add(initPositionIx)
      .add(unwrapIx)

    await signAndSend(tx, [positionOwner, wrappedEthAccount], connection)
  })

  it('create pool and position', async () => {
    const decimalsX = await getMint(connection, pair.tokenX).then(mint => mint.decimals)
    const decimalsY = await getMint(connection, pair.tokenY).then(mint => mint.decimals)

    const realPrice = 64000 // y to x token ratio
    const priceWithDecimals = (realPrice * Math.pow(10, decimalsX)) / Math.pow(10, decimalsY)
    const initTickPool = alignTickToSpacing(
      priceToTick(priceWithDecimals),
      otherFeeTier.tickSpacing!
    )
    const startingPrice = calculatePriceSqrt(initTickPool)

    await connection.requestAirdrop(positionOwner.publicKey, 1e9)

    userTokenXAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenX,
      positionOwner.publicKey
    ).then(ata => ata.address)
    userTokenYAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenY,
      positionOwner.publicKey
    ).then(ata => ata.address)

    // liquidity can be calculated using the getLiquidity function
    // it will return an amount of liquidity that can be payed for with both tokens
    const tokenXAmount = new BN(20000000)
    const tokenYAmount = new BN(20000000)
    const {
      x,
      y,
      liquidity: liquidityDelta
    } = getLiquidity(
      tokenXAmount,
      tokenYAmount,
      lowerTick,
      upperTick,
      startingPrice,
      true,
      otherPair.feeTier.tickSpacing
    )

    await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, x)
    await mintTo(connection, mintAuthority, pair.tokenY, userTokenYAccount, mintAuthority, y)
    // price impact slippage, position will fail if the price changes too far from the initial point
    // in this case slippage is 1% (1/10^2)
    const slippage = toDecimal(1, 2)

    const initPositionVars: CreatePoolAndPosition = {
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick,
      upperTick,
      liquidityDelta,
      knownPrice: startingPrice,
      slippage: slippage,
      initTick: initTickPool
    }
    console.log(positionOwner.publicKey.toString())
    await market.createPoolAndPosition(initPositionVars, positionOwner, {
      tokenXProgramAddress: TOKEN_PROGRAM_ID,
      tokenYProgramAddress: TOKEN_PROGRAM_ID
    })
  })

  it('queries', async () => {
    const fee = await market.getFeeTier(feeTier)
    console.log(fee)
    // querying pool
    const pool = await market.getPool(pair)
    console.log(pool)

    // querying position
    const positionIndex = 1
    const position = await market.getPosition(positionOwner.publicKey, positionIndex)
    console.log(position)
    // querying tickmap
    const tickmap = await market.getTickmap(pair)
    // querying tickmap using existing pool state to get the address
    // gets rid of one query
    const tickmapWithPool = await market.getTickmap(pair, pool)

    // querying tick
    const tick = await market.getTick(pair, lowerTick)
    console.log(tick)

    it('query positions with ids', async () => {
      const positions = await market.getAllUserPositionsWithIds(positionOwner.publicKey)
      assert.equal(positions.length, 3)
      assert.equal(positions[0][0], 0)
      assert.equal(positions[1][0], 1)
      assert.equal(positions[2][0], 2)
    })
  })

  it('batch queries', async () => {
    // all fee tiers
    const feeTiers = await market.program.account.feeTier.all()
    console.log(feeTiers)
    // all pools
    const pools = await market.getAllPools()
    console.log(pools)
    assert.equal(3, pools.length)

    // all tickmaps
    const tickmaps = await market.program.account.tickmap.all()
    assert.equal(3, tickmaps.length)

    // get all positions
    const positions = await market.getAllPositions()
    console.log(positions)
    assert.equal(3, positions.length)

    // all ticks
    const ticks = await market.program.account.tick.all()
    console.log(ticks)
    assert.equal(6, ticks.length)

    // all ticks for the pair returned as tickIndex => Tick map in a state that can be used in simulation
    const pairTicks = await market.getAllIndexedTicks(pair)
    console.log(pairTicks)
    assert.equal(2, pairTicks.size)
  })

  it('swap - quick setup', async () => {
    // swap params
    const xToY = false
    const byAmountIn = true
    const swapAmount = new BN(1000)
    const slippage = toDecimal(0, 0)

    let maxCrosses = TICK_CROSSES_PER_IX

    // if native token is involved the amount of accounts that can be used for ticks is lower
    const isTokenNative = pair.tokenX.equals(NATIVE_MINT) || pair.tokenY.equals(NATIVE_MINT)

    const referralAccount: PublicKey | undefined = undefined
    if (isTokenNative) {
      maxCrosses = TICK_CROSSES_PER_IX_NATIVE_TOKEN
    }

    if (referralAccount) {
      maxCrosses -= 1
    }

    const simulation = await swapSimulation(
      xToY,
      byAmountIn,
      swapAmount,
      undefined,
      slippage,
      market,
      pair.getAddress(market.program.programId),
      maxCrosses,
      TICK_VIRTUAL_CROSSES_PER_IX
    )

    if (simulation.status !== SimulationStatus.Ok) {
      throw new Error(simulation.status)
    }

    const swapSlippage = toDecimal(0, 0)

    const amountXBefore = await getBalance(connection, accountX)
    const amountYBefore = await getBalance(connection, accountY)

    const txHash = await market.swap(
      {
        xToY,
        estimatedPriceAfterSwap: simulation.priceAfterSwap,
        pair,
        amount: swapAmount,
        slippage: swapSlippage,
        byAmountIn,
        accountX,
        accountY,
        owner: owner.publicKey
      },
      owner
    )

    console.log(txHash)

    const amountXAfter = await getBalance(connection, accountX)
    const amountYAfter = await getBalance(connection, accountY)
    const deltaX = new BN(amountXAfter).sub(new BN(amountXBefore))
    const deltaY = new BN(amountYBefore).sub(new BN(amountYAfter))

    console.log(
      deltaX.toString(),
      deltaY.toString(),
      simulation.accumulatedAmountOut.toString(),
      simulation.accumulatedFee.add(simulation.accumulatedAmountIn).toString()
    )
  })

  it('swap with eth', async () => {
    // swap params
    const xToY = false
    const byAmountIn = true
    const swapAmount = new BN(10000)
    const slippage = toDecimal(0, 0)

    // lower max cross count
    let maxCrosses = TICK_CROSSES_PER_IX_NATIVE_TOKEN

    const referralAccount: PublicKey | undefined = undefined

    if (referralAccount) {
      maxCrosses -= 1
    }

    const simulation = await swapSimulation(
      xToY,
      byAmountIn,
      swapAmount,
      undefined,
      slippage,
      market,
      wrappedEthPair.getAddress(market.program.programId),
      maxCrosses,
      TICK_VIRTUAL_CROSSES_PER_IX
    )

    const isWrappedEthInput =
      (xToY && wrappedEthPair.tokenX.equals(NATIVE_MINT)) ||
      (!xToY && wrappedEthPair.tokenY.equals(NATIVE_MINT))

    if (simulation.status !== SimulationStatus.Ok) {
      throw new Error(simulation.status)
    }

    const swapSlippage = toDecimal(0, 0)

    const wrappedEthAccount = Keypair.generate()

    let wethTxs: WrappedEthInstructions | WrappedEthTransferInstructions
    if (isWrappedEthInput) {
      wethTxs = createNativeAtaWithTransferInstructions(
        wrappedEthAccount.publicKey,
        owner.publicKey,
        Network.LOCAL,
        swapAmount
      )
    } else {
      wethTxs = createNativeAtaInstructions(
        wrappedEthAccount.publicKey,
        owner.publicKey,
        Network.LOCAL
      )
    }

    const { createIx, initIx, unwrapIx } = wethTxs

    let token: PublicKey
    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      token = wrappedEthPair.tokenY
    } else {
      token = wrappedEthPair.tokenX
    }

    let accountX: PublicKey
    let accountY: PublicKey
    const userTokenAccount = getAssociatedTokenAddressSync(
      // connection,
      // owner,
      token,
      owner.publicKey
    )
    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      accountX = wrappedEthAccount.publicKey
      accountY = userTokenAccount
    } else {
      accountX = userTokenAccount
      accountY = wrappedEthAccount.publicKey
    }

    if (!isWrappedEthInput) {
      await mintTo(
        connection,
        owner,
        token,
        userTokenAccount,
        mintAuthority,
        simulation.accumulatedAmountIn,
        [mintAuthority]
      )
    }

    const swapIx = await market.swapIx(
      {
        xToY,
        estimatedPriceAfterSwap: simulation.priceAfterSwap,
        pair: wrappedEthPair,
        amount: simulation.accumulatedAmountIn,
        slippage: swapSlippage,
        byAmountIn,
        accountX,
        accountY,
        owner: owner.publicKey
      },
      undefined,
      {
        tickCrosses: maxCrosses
      }
    )

    const tx = new Transaction().add(createIx)

    if (isWrappedEthInput) {
      tx.add((wethTxs as WrappedEthTransferInstructions).transferIx)
    }

    tx.add(initIx).add(swapIx).add(unwrapIx)
    const txHash = await signAndSend(tx, [owner, wrappedEthAccount], connection)

    console.log(txHash)
  })

  it('swap - minimizing queried ticks amount for simulation', async () => {
    // fetch all accounts except for ticks
    const [pool, tokenXProgram, tokenYProgram] = await Promise.all([
      market.getPool(pair),
      getTokenProgramAddress(connection, pair.tokenX),
      getTokenProgramAddress(connection, pair.tokenY)
    ])
    const tickmap = await market.getTickmap(pair, pool)

    // optimally ticks should be queried in the direction of the swap
    // adding one tick in the opposite direction is recommended in case of a price change that could benefit the user
    const startTickIndex = pool.currentTickIndex
    const amountLimit = TICK_CROSSES_PER_IX
    const amountLimitBackward = 1
    const amountLimitForward = amountLimit - amountLimitBackward
    const xToY = true
    const priceDirection = xToY ? 'down' : 'up'
    const oppositePriceDirection = xToY ? 'up' : 'down'

    // minimum range for simulation to work
    const rangeLimitForward = TICK_SEARCH_RANGE * (TICK_VIRTUAL_CROSSES_PER_IX + amountLimitForward)
    // this can be an arbitrary number the current limit accounts for 2.5% - 30% price change in the opposite direction than the swap scaling up with tick spacing
    const rangeLimitBackward = TICK_SEARCH_RANGE * amountLimitBackward

    const tickIndexesForward = findClosestTicks(
      tickmap.bitmap,
      startTickIndex,
      pool.tickSpacing,
      amountLimitForward,
      rangeLimitForward,
      priceDirection
    )

    const tickIndexesBackwards = findClosestTicks(
      tickmap.bitmap,
      startTickIndex + (xToY ? pool.tickSpacing : -pool.tickSpacing),
      pool.tickSpacing,
      amountLimitBackward,
      rangeLimitBackward,
      oppositePriceDirection
    )

    const tickIndexes = tickIndexesForward.concat(tickIndexesBackwards)

    const tickAddresses = tickIndexes.map(t => market.getTickAddress(pair, t).tickAddress)

    const tickAccounts = await market.program.account.tick.fetchMultiple(tickAddresses)

    if (tickAccounts.find(v => v === null)) {
      throw new Error('Tick accounts need to be fetched again')
    }

    assert.equal(tickAccounts.length, 1)

    // preparing ticks for simulation
    const ticks = new Map<number, Tick>()
    tickAccounts.forEach(v => {
      if (v) {
        let tick = parseTick(v) as Tick
        ticks.set(tick.index, tick)
      }
    })

    assert.equal(ticks.size, 1)

    const byAmountIn = true
    const swapAmount = new BN(1000)

    const slippage = toDecimal(1, 0)

    const simulation = simulateSwap({
      tickmap,
      xToY,
      byAmountIn,
      swapAmount,
      slippage,
      ticks: ticks,
      pool,
      maxCrosses: amountLimitForward,
      maxVirtualCrosses: TICK_VIRTUAL_CROSSES_PER_IX
    })

    if (simulation.status != SimulationStatus.Ok) {
      throw new Error(simulation.status)
    }

    const amount = swapAmount
    const referralAccount = undefined

    // only the addresses that were crossed are necessary
    // one extra tick is added in the opposite direction
    const tickAddressesRequired = simulation.crossedTicks
      .concat(tickIndexesBackwards)
      .map(v => market.getTickAddress(pair, v).tickAddress)

    const ix = await market.swapIx(
      {
        pair,
        xToY,
        slippage,
        estimatedPriceAfterSwap: simulation.priceAfterSwap,
        amount,
        byAmountIn,
        owner: owner.publicKey,
        accountX,
        accountY,
        referralAccount
      },
      {
        pool,
        tokenXProgram,
        tokenYProgram
      },
      {
        tickAddresses: tickAddressesRequired
      }
    )

    const tx = new Transaction().add(ix)
    const txHash = await signAndSend(tx, [owner], connection)
    console.log(txHash)
  })

  it('remove eth position', async () => {
    const positionList = await market.getAllUserPositionsWithIds(positionOwner.publicKey)
    // Index can be picked based on the position list
    const positionToRemove = 1
    const removedPosition = positionList.find(p => p[0] == 1)

    console.log(removedPosition)

    const positionId = positionList[positionToRemove][0]

    const wrappedEthAccount = Keypair.generate()

    const { createIx, initIx, unwrapIx } = createNativeAtaInstructions(
      wrappedEthAccount.publicKey,
      positionOwner.publicKey,
      Network.LOCAL
    )

    let token: PublicKey
    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      token = wrappedEthPair.tokenY
    } else {
      token = wrappedEthPair.tokenX
    }

    let userTokenX: PublicKey
    let userTokenY: PublicKey
    const userTokenAccount = getAssociatedTokenAddressSync(token, positionOwner.publicKey)

    if (wrappedEthPair.tokenX === NATIVE_MINT) {
      userTokenX = wrappedEthAccount.publicKey
      userTokenY = userTokenAccount
    } else {
      userTokenX = userTokenAccount
      userTokenY = wrappedEthAccount.publicKey
    }

    const removePosition: RemovePosition = {
      pair: wrappedEthPair,
      owner: positionOwner.publicKey,
      index: positionId,
      userTokenX,
      userTokenY
    }

    const removePositionIx = await market.removePositionIx(removePosition)
    const tx = new Transaction()
    tx.add(createIx).add(initIx).add(removePositionIx).add(unwrapIx)

    await signAndSend(tx, [positionOwner, wrappedEthAccount], connection)
  })

  it('remove position', async () => {
    const positionList = await market.getAllUserPositionsWithIds(positionOwner.publicKey)
    // Index can be picked based on the position list
    const positionToRemove = 0
    const removedPosition = positionList.find(p => p[0] == positionToRemove)

    console.log(removedPosition)

    const positionId = positionList[positionToRemove][0]
    const removePosition: RemovePosition = {
      pair,
      owner: positionOwner.publicKey,
      index: positionId,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount
    }

    await market.removePosition(removePosition, positionOwner)
  })
})
