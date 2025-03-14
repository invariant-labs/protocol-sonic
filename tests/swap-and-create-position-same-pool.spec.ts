import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { assert } from 'chai'
import { createToken, initMarket } from './testUtils'
import { Market, Pair, Network, sleep, calculatePriceSqrt } from '@invariant-labs/sdk'
import { SwapAndCreatePosition, FeeTier } from '@invariant-labs/sdk/lib/market'
import { fromFee, getBalance } from '@invariant-labs/sdk/lib/utils'
import {
  simulateSwapAndCreatePositionOnTheSamePool,
  toDecimal
} from '@invariant-labs/sdk/src/utils'
import { CreatePosition } from '@invariant-labs/sdk/src/market'
import { burn, createAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token'

describe('swap and create position', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)), // 0.6%
    tickSpacing: 10
  }
  const lowPriceFeeTier: FeeTier = {
    fee: fromFee(new BN(601)), // 0.6%
    tickSpacing: 10
  }
  const otherFeeTier: FeeTier = {
    fee: fromFee(new BN(500)),
    tickSpacing: 10
  }
  const invalidFeeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 5
  }
  let market: Market
  let pair: Pair
  let lowPricePair: Pair
  let otherPair: Pair
  let invalidPair: Pair

  const tokenX = Keypair.fromSecretKey(
    new Uint8Array([
      58, 183, 123, 246, 228, 160, 239, 163, 153, 176, 165, 248, 249, 244, 239, 104, 88, 110, 72,
      229, 223, 232, 130, 142, 242, 113, 243, 151, 53, 37, 160, 123, 246, 79, 222, 251, 68, 47, 98,
      217, 206, 254, 41, 250, 113, 165, 250, 241, 7, 228, 134, 157, 165, 90, 25, 95, 227, 80, 141,
      172, 207, 32, 9, 162
    ])
  )
  const tokenY = Keypair.fromSecretKey(
    new Uint8Array([
      208, 40, 147, 74, 216, 168, 205, 135, 93, 237, 243, 109, 121, 32, 29, 191, 77, 61, 158, 38,
      201, 144, 70, 71, 95, 30, 193, 97, 217, 158, 80, 36, 237, 121, 45, 38, 76, 192, 166, 88, 254,
      95, 135, 145, 106, 134, 174, 147, 189, 202, 57, 157, 48, 78, 234, 191, 167, 243, 55, 99, 93,
      103, 13, 114
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
      createToken(connection, admin, mintAuthority, 9, null, false, tokenX),
      createToken(connection, admin, mintAuthority, 9, null, false, tokenY)
    ])

    pair = new Pair(tokens[0], tokens[1], feeTier)
    lowPricePair = new Pair(tokens[0], tokens[1], lowPriceFeeTier)
    otherPair = new Pair(tokens[0], tokens[1], otherFeeTier)
    invalidPair = new Pair(tokens[0], tokens[1], invalidFeeTier)
  })

  it('#init()', async () => {
    await initMarket(market, [pair, otherPair, invalidPair], admin, 10000)
  })

  it('create position on the same pool as swap', async () => {
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
    const mintAmount = new BN(10).pow(new BN(7))
    const secondMintAmount = new BN(10).pow(new BN(6))

    const mintY = async (amt: BN) => {
      await mintTo(connection, mintAuthority, pair.tokenY, userTokenYAccount, mintAuthority, amt)
    }
    const mintX = async (amt: BN) => {
      await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, amt)
    }

    await mintX(mintAmount.divn(2))
    await mintY(mintAmount)

    const liquidityDelta = new BN(10).pow(new BN(12))

    const price = calculatePriceSqrt(10000)
    const initFirstPositionVars: CreatePosition = {
      liquidityDelta: liquidityDelta.muln(2),
      pair: pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: -Infinity,
      upperTick: Infinity,
      knownPrice: price,
      slippage: new BN(0)
    }

    await market.createPosition(initFirstPositionVars, positionOwner)

    const initSecondPositionVars: CreatePosition = {
      liquidityDelta: new BN(10),
      pair: pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: 0,
      upperTick: 10,
      knownPrice: price,
      slippage: new BN(0)
    }
    const initThirdPositionVars: CreatePosition = {
      liquidityDelta: new BN(10),
      pair: pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: 10,
      upperTick: 20,
      knownPrice: price,
      slippage: new BN(0)
    }

    await market.createPosition(initFirstPositionVars, positionOwner)
    await market.createPosition(initSecondPositionVars, positionOwner)
    await market.createPosition(initThirdPositionVars, positionOwner)

    await sleep(400)

    {
      const balanceBeforeX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      const balanceBeforeY = await getBalance(connection, userTokenYAccount, TOKEN_PROGRAM_ID)

      await burn(
        connection,
        mintAuthority,
        userTokenXAccount,
        pair.tokenX,
        positionOwner,
        balanceBeforeX
      )
      await burn(
        connection,
        mintAuthority,
        userTokenYAccount,
        pair.tokenY,
        positionOwner,
        balanceBeforeY
      )
    }

    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))
    async function swapAndCreatePosition(
      createPosition: Pick<
        CreatePosition,
        'lowerTick' | 'upperTick' | 'owner' | 'pair' | 'slippage'
      >,
      expectedResult: {
        xValue: BN
        yValue: BN
        positionLiquidity: BN
      },
      minUtilizationPercentage: BN,
      swapPair?: Pair
    ) {
      await sleep(400)
      const amountX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      const amountY = await getBalance(connection, userTokenYAccount, TOKEN_PROGRAM_ID)
      // -9 l,u tick, x,y res, pool, pos, pos list, tickmap payer
      swapPair ??= createPosition.pair
      console.log(swapPair.getAddress(market.program.programId).toString())
      const sim = simulateSwapAndCreatePositionOnTheSamePool(
        amountX,
        amountY,
        toDecimal(1, 0),
        {
          tickmap: await market.getTickmap(swapPair),
          ticks: await market.getAllIndexedTicks(swapPair),
          pool: await market.getPool(swapPair),
          maxCrosses: 4
        },
        { ...createPosition }
      )
      const swapSimulation = sim.swapSimulation!
      const swapInput = sim.swapInput!

      const swapAndCreatePositionVars: SwapAndCreatePosition = {
        amountX,
        amountY,
        swapPair,
        byAmountIn: swapInput.byAmountIn,
        xToY: swapInput.xToY,
        amount: swapInput.swapAmount,
        estimatedPriceAfterSwap: swapSimulation.priceAfterSwap,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: createPosition.lowerTick,
        upperTick: createPosition.upperTick,
        slippage: createPosition.slippage,
        minUtilizationPercentage: minUtilizationPercentage,
        liquidityDelta: sim.position.liquidity
      }

      await market.swapAndCreatePosition(swapAndCreatePositionVars, positionOwner)

      await sleep(400)
      const pos = await market.getPosition(
        positionOwner.publicKey,
        (await market.getPositionList(positionOwner.publicKey)).head - 1
      )

      const balanceX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      const balanceY = await getBalance(connection, userTokenYAccount, TOKEN_PROGRAM_ID)

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
    console.info('More X tokens in the middle')
    await swapAndCreatePosition(
      {
        lowerTick: -100000,
        upperTick: 100000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(1),
        positionLiquidity: new BN('935491883433')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount.divn(2))
    await mintY(secondMintAmount)

    console.info('More Y tokens in the middle')
    // create position tick in the middle, more Y tokens
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(4),
        positionLiquidity: new BN('1159539354633')
      },
      toDecimal(99, 2)
    )
    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))

    // only X one sided
    console.info('Only X tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: -10000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(0),
        yValue: new BN(1),
        positionLiquidity: new BN('8733796666609')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))

    // only Y one sideded
    console.info('Only Y tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: 20000,
        upperTick: 40000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(0),
        positionLiquidity: new BN('5837027446712')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount)

    // only X middle
    console.info('Only X tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -10000,
        upperTick: 20000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(2),
        yValue: new BN(1),
        positionLiquidity: new BN('1110643031368')
      },
      toDecimal(99, 2)
    )

    await burn(connection, mintAuthority, userTokenXAccount, pair.tokenX, positionOwner, new BN(1))

    await mintY(secondMintAmount)

    // only Y middle
    console.info('Only Y tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -10000,
        upperTick: 20000,
        slippage: toDecimal(1, 0),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(1),
        positionLiquidity: new BN('816535368022')
      },
      toDecimal(99, 2)
    )

    await mintX(mintAmount)
    await mintY(mintAmount)

    console.info('Pool with low price')

    await market.createFeeTier(
      {
        feeTier: lowPriceFeeTier,
        admin: admin.publicKey
      },
      admin
    )

    await market.createPool({
      pair: lowPricePair,
      initTick: -10000,
      payer: positionOwner
    })

    await market.createPosition(
      { ...initFirstPositionVars, pair: lowPricePair, knownPrice: calculatePriceSqrt(-10000) },
      positionOwner
    )

    {
      await sleep(400)
      const balanceBeforeX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      if (balanceBeforeX.gtn(0)) {
        await burn(
          connection,
          mintAuthority,
          userTokenXAccount,
          pair.tokenX,
          positionOwner,
          balanceBeforeX
        )
      }
      const balanceBeforeY = await getBalance(connection, userTokenYAccount, TOKEN_PROGRAM_ID)
      if (balanceBeforeY.gtn(0)) {
        await burn(
          connection,
          mintAuthority,
          userTokenYAccount,
          pair.tokenY,
          positionOwner,
          balanceBeforeY
        )
      }
    }
    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))
    // create position tick in the middle, more X tokens
    console.info('More X tokens in the middle')
    await swapAndCreatePosition(
      {
        lowerTick: -100000,
        upperTick: 100000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(3),
        yValue: new BN(1),
        positionLiquidity: new BN('718375126333')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount.divn(2))
    await mintY(secondMintAmount)

    console.info('More Y tokens in the middle')
    // create position tick in the middle, more Y tokens
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(4),
        yValue: new BN(1),
        positionLiquidity: new BN('1441933385583')
      },
      toDecimal(99, 2)
    )
    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))

    // only X one sided
    console.info('Only X tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: -40000,
        upperTick: -20000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(0),
        yValue: new BN(1),
        positionLiquidity: new BN('4342929543453')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))

    // only Y one sideded
    console.info('Only Y tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: 20000,
        upperTick: 40000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(1),
        yValue: new BN(0),
        positionLiquidity: new BN('8482843824014')
      },
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount)

    // only X middle
    console.info('Only X tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 10000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(2),
        yValue: new BN(1),
        positionLiquidity: new BN('705318618096')
      },
      toDecimal(99, 2)
    )

    await burn(connection, mintAuthority, userTokenXAccount, pair.tokenX, positionOwner, new BN(2))

    await mintY(secondMintAmount)

    // only Y middle
    console.info('Only Y tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 10000,
        slippage: toDecimal(1, 0),
        pair: lowPricePair
      },
      {
        xValue: new BN(1),
        yValue: new BN(1),
        positionLiquidity: new BN('1235129978110')
      },
      toDecimal(99, 2)
    )
  })
})
