import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import {
  createCommonLookupTable,
  createPoolLookupTable,
  createTickLookupTables,
  createToken,
  initMarket
} from './testUtils'
import { Market, Pair, Network, PRICE_DENOMINATOR, sleep } from '@invariant-labs/sdk'
import { SwapAndCreatePosition, FeeTier } from '@invariant-labs/sdk/lib/market'
import {
  createNativeAtaWithTransferInstructions,
  fetchAllLookupTables,
  fromFee,
  getBalance,
  getMaxTick,
  getMinTick
} from '@invariant-labs/sdk/lib/utils'
import { simulateSwapAndCreatePosition, toDecimal } from '@invariant-labs/sdk/src/utils'
import { CreatePosition } from '@invariant-labs/sdk/src/market'
import {
  createAssociatedTokenAccount,
  mintTo,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { signAndSend } from '@invariant-labs/locker-sonic-sdk'
import { calculatePriceSqrt } from '@invariant-labs/sdk'

describe('swap and create position', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)), // 0.6%
    tickSpacing: 10
  }
  const otherFeeTier: FeeTier = {
    fee: fromFee(new BN(500)),
    tickSpacing: 10
  }

  let market: Market
  let pair: Pair
  let otherPair: Pair

  const tokenX = Keypair.fromSecretKey(
    new Uint8Array([
      58, 183, 123, 246, 228, 160, 239, 163, 153, 176, 165, 248, 249, 244, 239, 104, 88, 110, 72,
      229, 223, 232, 130, 142, 242, 113, 243, 151, 53, 37, 160, 123, 246, 79, 222, 251, 68, 47, 98,
      217, 206, 254, 41, 250, 113, 165, 250, 241, 7, 228, 134, 157, 165, 90, 25, 95, 227, 80, 141,
      172, 207, 32, 9, 162
    ])
  )

  before(async () => {
    market = Market.build(
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

    await sleep(1000)

    // Create tokens
    const tokens = await Promise.all([
      createToken(connection, admin, mintAuthority, 9, null, false, tokenX)
    ])

    pair = new Pair(tokens[0], NATIVE_MINT, feeTier)
    otherPair = new Pair(tokens[0], NATIVE_MINT, otherFeeTier)
  })

  it('#init()', async () => {
    await initMarket(market, [pair, otherPair], admin)
  })

  it('#prepare pools', async () => {
    const positionOwner = Keypair.generate()
    await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    await sleep(400)

    const userTokenXAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenX,
      positionOwner.publicKey
    )
    const ethKeypair = Keypair.generate()

    const userTokenYAccount = ethKeypair.publicKey
    const mintAmount = new BN(10).pow(new BN(8))

    const mintX = async (amt: BN) => {
      await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, amt)
    }
    const mintY = async (amt: BN) => {
      const { createIx, transferIx, initIx, unwrapIx } = createNativeAtaWithTransferInstructions(
        ethKeypair.publicKey,
        positionOwner.publicKey,
        Network.LOCAL,
        amt.toNumber()
      )
      const tx = new Transaction().add(createIx, transferIx, initIx)
      await signAndSend(tx, [positionOwner, ethKeypair], connection)
    }

    await mintX(mintAmount.divn(2))
    await mintY(mintAmount)

    const liquidityDelta = new BN(10).pow(new BN(12))

    const initFirstPositionVars: CreatePosition = {
      liquidityDelta,
      pair: pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: -Infinity,
      upperTick: Infinity,
      knownPrice: PRICE_DENOMINATOR,
      slippage: new BN(0)
    }

    await market.createPosition(initFirstPositionVars, positionOwner)

    const initSecondPositionVars: CreatePosition = {
      liquidityDelta,
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: -Infinity,
      upperTick: Infinity,
      knownPrice: PRICE_DENOMINATOR,
      slippage: new BN(0)
    }
    await market.createPosition(initSecondPositionVars, positionOwner)

    for (let i = 0; i < 250; i += 10) {
      const initThirdPositionVars: CreatePosition = {
        liquidityDelta: new BN(10),
        pair: otherPair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: i,
        upperTick: i + 10,
        knownPrice: PRICE_DENOMINATOR,
        slippage: new BN(0)
      }
      await market.createPosition(initThirdPositionVars, positionOwner)
    }
  })
  it('create position on different pool', async () => {
    const positionOwner = Keypair.generate()
    await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    await sleep(400)

    await createCommonLookupTable(market, positionOwner)
    await createPoolLookupTable(market, otherPair, positionOwner)
    const minTick = -20
    const maxTick = 400
    await createTickLookupTables(market, otherPair, positionOwner, minTick, maxTick)

    const userTokenXAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenX,
      positionOwner.publicKey
    )
    const ethKeypair = Keypair.generate()

    const userTokenYAccount = ethKeypair.publicKey
    const secondMintAmount = new BN(10).pow(new BN(6))
    const { createIx, transferIx, initIx, unwrapIx } = createNativeAtaWithTransferInstructions(
      ethKeypair.publicKey,
      positionOwner.publicKey,
      Network.LOCAL,
      secondMintAmount.toNumber()
    )
    await mintTo(
      connection,
      mintAuthority,
      pair.tokenX,
      userTokenXAccount,
      mintAuthority,
      secondMintAmount.divn(2)
    )

    async function swapAndCreatePosition(
      createPosition: Pick<
        CreatePosition,
        'lowerTick' | 'upperTick' | 'owner' | 'pair' | 'slippage'
      >,
      expectedResult: {
        crosses: number
        xValue: BN
        yValue: BN
        positionLiquidity: BN
      },
      swapPair: Pair,
      minUtilizationPercentage: BN
    ) {
      await sleep(400)
      const lookupTables = await fetchAllLookupTables(connection, positionOwner.publicKey)

      const balanceBeforeX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)

      const positionPool = await market.getPool(createPosition.pair)
      const tickmap = await market.getTickmap(swapPair)
      const ticks = await market.getAllIndexedTicks(swapPair)
      const swapPool = await market.getPool(swapPair)

      await sleep(400)
      const sim = simulateSwapAndCreatePosition(
        balanceBeforeX,
        secondMintAmount,
        {
          tickmap: tickmap,
          ticks: ticks,
          pool: swapPool,
          slippage: toDecimal(1, 0),
          maxCrosses: expectedResult.crosses
        },
        { ...createPosition, knownPrice: positionPool.sqrtPrice }
      )
      const swapSimulation = sim.swapSimulation!
      console.log(swapSimulation.crossedTicks)
      const swapInput = sim.swapInput!
      const crossedTicksAddresses = swapSimulation.crossedTicks.map(t =>
        market.getTickAddressByPool(swapPair.getAddress(market.program.programId), t)
      )

      assert(
        crossedTicksAddresses.map(t =>
          lookupTables
            .map(l => l.state.addresses.find(a => a.equals(t.tickAddress)))
            .every(t => t !== undefined)
        )
      )

      const swapAndCreatePositionVars: SwapAndCreatePosition = {
        amountX: balanceBeforeX,
        amountY: secondMintAmount,
        swapPair,
        byAmountIn: swapInput.byAmountIn,
        xToY: swapInput.xToY,
        amount: swapInput.swapAmount,
        estimatedPriceAfterSwap: swapInput.xToY
          ? calculatePriceSqrt(getMinTick(createPosition.pair.tickSpacing))
          : calculatePriceSqrt(getMaxTick(createPosition.pair.tickSpacing)),
        swapAndCreateOnDifferentPools: {
          positionPair: createPosition.pair,
          positionPoolPrice: positionPool.sqrtPrice,
          positionSlippage: toDecimal(1, 0)
        },
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: createPosition.lowerTick,
        upperTick: createPosition.upperTick,
        slippage: createPosition.slippage,
        minUtilizationPercentage: minUtilizationPercentage,
        liquidityDelta: sim.position.liquidity
      }

      await sleep(400)

      const tx = await market.versionedSwapAndCreatePositionTx(
        swapAndCreatePositionVars,
        {
          tickIndexes: swapSimulation.crossedTicks
        },
        {},
        [createIx, transferIx, initIx],
        [unwrapIx],
        lookupTables
      )

      tx.sign([positionOwner, ethKeypair])
      const txHash = await connection.sendTransaction(tx)
      await connection.confirmTransaction(txHash)

      await sleep(400)

      const pos = await market.getPosition(
        positionOwner.publicKey,
        (await market.getPositionList(positionOwner.publicKey)).head - 1
      )

      const balanceX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      const balanceY = new BN(await connection.getBalance(positionOwner.publicKey))

      assert.equal(swapSimulation.crossedTicks.length, expectedResult.crosses)

      assert(
        expectedResult.xValue.eq(balanceX),
        `Got balance X: ${balanceX}, Expected: ${expectedResult.xValue}`
      )
      assert(
        expectedResult.yValue.eq(balanceY),
        `Got balance Y: ${balanceY}, Expected: ${expectedResult.yValue}`
      )
      assert(
        expectedResult.positionLiquidity.eq(pos.liquidity),
        `Got liquidity: ${pos.liquidity}, Expected: ${expectedResult.positionLiquidity}`
      )
    }
    // create position tick in the middle, more X tokens
    await swapAndCreatePosition(
      {
        lowerTick: -10000,
        upperTick: 10000,
        slippage: toDecimal(0, 0),
        pair: pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(926446724),
        positionLiquidity: new BN('1826451568298'),
        crosses: 25
      },
      otherPair,
      toDecimal(99, 2)
    )
  })
})
