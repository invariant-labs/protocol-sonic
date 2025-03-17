import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { assert } from 'chai'
import { assertThrowsAsync, createToken, initMarket } from './testUtils'
import { Market, Pair, Network, sleep } from '@invariant-labs/sdk'
import { SwapAndCreatePosition, FeeTier } from '@invariant-labs/sdk/lib/market'
import { fromFee, getBalance, getMaxTick, getMinTick } from '@invariant-labs/sdk/lib/utils'
import {
  INVARIANT_AUTOSWAP_ERRORS,
  simulateSwapAndCreatePosition,
  toDecimal
} from '@invariant-labs/sdk/src/utils'
import { CreatePosition } from '@invariant-labs/sdk/src/market'
import { burn, createAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from '@solana/spl-token'
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
  const invalidFeeTier: FeeTier = {
    fee: fromFee(new BN(160)),
    tickSpacing: 5
  }
  let market: Market
  let pair: Pair
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
    otherPair = new Pair(tokens[0], tokens[1], otherFeeTier)
    invalidPair = new Pair(tokens[0], tokens[1], invalidFeeTier)
  })

  it('#init()', async () => {
    await initMarket(market, [pair, otherPair, invalidPair], admin, 10000)
  })

  it('create position on different pool', async () => {
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
    const mintAmount = new BN(10).pow(new BN(9))
    const secondMintAmount = new BN(10).pow(new BN(5))

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
      liquidityDelta,
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
      liquidityDelta,
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: -Infinity,
      upperTick: Infinity,
      knownPrice: price,
      slippage: new BN(0)
    }

    const initThirdPositionVars: CreatePosition = {
      liquidityDelta: new BN(10),
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: 0,
      upperTick: 10,
      knownPrice: price,
      slippage: new BN(0)
    }
    const initFourthPositionVars: CreatePosition = {
      liquidityDelta: new BN(10),
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: 20,
      upperTick: 30,
      knownPrice: price,
      slippage: new BN(0)
    }
    const initFifthPositionVars: CreatePosition = {
      liquidityDelta: new BN(10),
      pair: otherPair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick: 40,
      upperTick: 50,
      knownPrice: price,
      slippage: new BN(0)
    }

    await market.createPosition(initFirstPositionVars, positionOwner)
    await market.createPosition(initSecondPositionVars, positionOwner)
    await market.createPosition(initThirdPositionVars, positionOwner)
    await market.createPosition(initFourthPositionVars, positionOwner)
    await market.createPosition(initFifthPositionVars, positionOwner)

    await sleep(400)

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

    await mintX(secondMintAmount.divn(2))
    await mintY(secondMintAmount)

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
      swapPair: Pair,
      minUtilizationPercentage: BN,
      simulationPrecisionPercentage = toDecimal(1, 2)
    ) {
      await sleep(400)
      const amountX = await getBalance(connection, userTokenXAccount, TOKEN_PROGRAM_ID)
      const amountY = await getBalance(connection, userTokenYAccount, TOKEN_PROGRAM_ID)
      const positionPool = await market.getPool(createPosition.pair)
      const tickmap = await market.getTickmap(swapPair)
      const ticks = await market.getAllIndexedTicks(swapPair)
      // -9 l,u tick, x,y res, pool, pos, pos list, tickmap payer
      const maxCrosses = 3
      const sim = simulateSwapAndCreatePosition(
        amountX,
        amountY,
        {
          tickmap: tickmap,
          ticks: ticks,
          pool: await market.getPool(swapPair),
          slippage: toDecimal(1, 0),
          maxCrosses
        },
        { ...createPosition, knownPrice: positionPool.sqrtPrice },
        simulationPrecisionPercentage
      )
      const swapInput = sim.swapInput!

      const swapAndCreatePositionVars: SwapAndCreatePosition = {
        amountX,
        amountY,
        swapPair,
        byAmountIn: swapInput.byAmountIn,
        xToY: swapInput.xToY,
        amount: swapInput.swapAmount,
        estimatedPriceAfterSwap: swapInput.xToY
          ? calculatePriceSqrt(getMinTick(createPosition.pair.tickSpacing))
          : calculatePriceSqrt(getMaxTick(createPosition.pair.tickSpacing)),
        swapAndCreateOnDifferentPools: {
          positionPair: createPosition.pair,
          positionSlippage: toDecimal(1, 0),
          positionPoolPrice: positionPool.sqrtPrice
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

      const tx = await market.swapAndCreatePositionTx(swapAndCreatePositionVars, {
        tickCrosses: maxCrosses
      })
      await signAndSend(tx, [positionOwner], connection, { commitment: 'max' })

      await sleep(1000)
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
    console.info('More Y tokens in the middle')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 3),
        pair: otherPair
      },
      {
        xValue: new BN(1),
        yValue: new BN(1),
        positionLiquidity: new BN('121589124937')
      },
      pair,
      toDecimal(99, 2),
      toDecimal(1, 4)
    )

    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))

    console.info('More X tokens in the middle')
    // create position tick in the middle, more Y tokens
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 3),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(1701),
        positionLiquidity: new BN('158545993754')
      },
      otherPair,
      toDecimal(99, 2)
    )
    await mintX(secondMintAmount.divn(2))
    await mintY(secondMintAmount)

    // only X one sided
    console.info('Only X tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: -40000,
        upperTick: -20000,
        slippage: toDecimal(1, 3),
        pair
      },
      {
        xValue: new BN(0),
        yValue: new BN(1),
        positionLiquidity: new BN('897212991535')
      },
      otherPair,
      toDecimal(99, 2)
    )

    await mintX(secondMintAmount)
    await mintY(secondMintAmount.divn(2))
    await sleep(1000)

    // only Y one sideded
    console.info('Only Y tokens on the side')
    await swapAndCreatePosition(
      {
        lowerTick: 20000,
        upperTick: 40000,
        slippage: toDecimal(1, 3),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(0),
        positionLiquidity: new BN('532997305843')
      },
      otherPair,
      toDecimal(95, 2)
    )

    await mintX(secondMintAmount)

    // only X middle
    console.info('Only X tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 3),
        pair
      },
      {
        xValue: new BN(268),
        yValue: new BN(1),
        positionLiquidity: new BN('111839059298')
      },
      otherPair,
      toDecimal(99, 2)
    )
    await burn(
      connection,
      mintAuthority,
      userTokenXAccount,
      pair.tokenX,
      positionOwner,
      new BN(268)
    )

    await mintY(secondMintAmount)

    // only Y middle
    console.info('Only Y tokens middle')
    await swapAndCreatePosition(
      {
        lowerTick: -20000,
        upperTick: 20000,
        slippage: toDecimal(1, 3),
        pair
      },
      {
        xValue: new BN(1),
        yValue: new BN(538),
        positionLiquidity: new BN('58183047391')
      },
      otherPair,
      toDecimal(95, 2)
    )

    await assertThrowsAsync(
      swapAndCreatePosition(
        {
          lowerTick: 20000,
          upperTick: 50000,
          slippage: toDecimal(1, 3),
          pair: otherPair
        },
        {
          xValue: new BN('-1'),
          yValue: new BN('-1'),
          positionLiquidity: new BN('-1')
        },
        invalidPair,
        toDecimal(95, 2)
      ),
      INVARIANT_AUTOSWAP_ERRORS.SWAP_DISABLED
    )

    await assertThrowsAsync(
      swapAndCreatePosition(
        {
          lowerTick: 0,
          upperTick: 20000,
          slippage: toDecimal(1, 3),
          pair: invalidPair
        },
        {
          xValue: new BN('-1'),
          yValue: new BN('-1'),
          positionLiquidity: new BN('-1')
        },
        otherPair,
        toDecimal(95, 2)
      ),
      INVARIANT_AUTOSWAP_ERRORS.CREATE_POSITION_DISABLED
    )
  })
})
