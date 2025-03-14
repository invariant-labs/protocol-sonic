import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, SystemProgram } from '@solana/web3.js'
import {
  Network,
  Market,
  Pair,
  LIQUIDITY_DENOMINATOR,
  PRICE_DENOMINATOR,
  sleep
} from '@invariant-labs/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { assertThrowsAsync, createToken, initMarket } from './testUtils'
import { assert } from 'chai'
import { fromFee, getBalance } from '@invariant-labs/sdk/lib/utils'
import { FeeTier } from '@invariant-labs/sdk/lib/market'
import { toDecimal } from '@invariant-labs/sdk/src/utils'
import { CreatePosition, Swap } from '@invariant-labs/sdk/src/market'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { ILockPosition } from '@invariant-labs/locker-sonic-sdk'
import { Locker } from '@invariant-labs/locker-sonic-sdk'
import { getMaxLockDuration } from '@invariant-labs/locker-sonic-sdk/src/utils'
import { Network as LockerNetwork } from '@invariant-labs/locker-sonic-sdk'
import { IClaimFee } from '@invariant-labs/locker-sonic-sdk/src'
import { getTokenProgramAddress } from '@invariant-labs/sdk'

describe('claim multiple locks', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const unauthorizedUser = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)), // 0.6%
    tickSpacing: 10
  }
  let market: Market
  let locker: Locker
  let pair: Pair

  before(async () => {
    market = await Market.build(
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

    await Promise.all([
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9),
      connection.requestAirdrop(unauthorizedUser.publicKey, 1e9)
    ])

    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])

    pair = new Pair(tokens[0], tokens[1], feeTier)
  })

  it('#init()', async () => {
    await initMarket(market, [pair], admin)
  })

  it('#claim', async () => {
    const upperTick = 10
    const lowerTick = -20

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

    const liquidityDelta = new BN(1000000).mul(LIQUIDITY_DENOMINATOR).divn(2)

    await market.createPositionList(positionOwner.publicKey, positionOwner)

    const initPositionVars: CreatePosition = {
      pair,
      owner: positionOwner.publicKey,
      userTokenX: userTokenXAccount,
      userTokenY: userTokenYAccount,
      lowerTick,
      upperTick,
      liquidityDelta: liquidityDelta,
      knownPrice: PRICE_DENOMINATOR,
      slippage: new BN(0)
    }

    await market.createPosition(initPositionVars, positionOwner)
    await market.createPosition(initPositionVars, positionOwner)

    assert.ok((await market.getPool(pair)).liquidity.eq(liquidityDelta.muln(2)))

    const lockPositionVars: ILockPosition = {
      index: 0,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

    await locker.lockPosition(lockPositionVars)
    await locker.lockPosition(lockPositionVars)

    const swapper = Keypair.generate()
    await connection.requestAirdrop(swapper.publicKey, 1e9)
    await sleep(1000)
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

    await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, amount)

    const poolDataBefore = await market.getPool(pair)
    const reservesBeforeSwap = await market.getReserveBalances(pair)

    const swapVars: Swap = {
      pair,
      owner: swapper.publicKey,
      xToY: true,
      amount,
      estimatedPriceAfterSwap: poolDataBefore.sqrtPrice, // ignore price impact using high slippage tolerance
      slippage: toDecimal(1, 2),
      accountX,
      accountY,
      byAmountIn: true
    }
    await market.swap(swapVars, swapper)

    await sleep(1000)

    const poolDataAfter = await market.getPool(pair)
    assert.ok(poolDataAfter.liquidity.eq(poolDataBefore.liquidity))
    assert.ok(poolDataAfter.currentTickIndex === lowerTick)
    assert.ok(poolDataAfter.sqrtPrice.lt(poolDataBefore.sqrtPrice))

    const amountX = await getBalance(connection, accountX)
    const amountY = await getBalance(connection, accountY)
    const reservesAfterSwap = await market.getReserveBalances(pair)
    const reserveXDelta = reservesAfterSwap.x.sub(reservesBeforeSwap.x)
    const reserveYDelta = reservesBeforeSwap.y.sub(reservesAfterSwap.y)

    // fee tokens           0.006 * 1000 = 6
    // protocol fee tokens  ceil(6 * 0.01) = cei(0.06) = 1
    // pool fee tokens      6 - 1 = 5
    // fee growth global    5/1000000 = 5 * 10^-6
    assert.ok(amountX.eqn(0))
    assert.ok(amountY.eq(amount.subn(7)))
    assert.ok(reserveXDelta.eq(amount))
    assert.ok(reserveYDelta.eq(amount.subn(7)))
    assert.ok(poolDataAfter.feeGrowthGlobalX.eq(new BN('5000000000000000000')))
    assert.ok(poolDataAfter.feeGrowthGlobalY.eqn(0))
    assert.ok(poolDataAfter.feeProtocolTokenX.eqn(1))
    assert.ok(poolDataAfter.feeProtocolTokenY.eqn(0))

    const reservesBeforeClaim = await market.getReserveBalances(pair)
    const userTokenX = getAssociatedTokenAddressSync(pair.tokenX, positionOwner.publicKey)
    const userTokenY = getAssociatedTokenAddressSync(pair.tokenY, positionOwner.publicKey)

    {
      const claimFeeVars: IClaimFee = {
        payer: positionOwner,
        pair,
        userTokenX,
        userTokenY,
        market,
        authorityListIndex: 0
      }

      await locker.claimFee(claimFeeVars)
      await sleep(400)
    }
    // Position were swapped, so the fee should be claimed from the second position with index 0
    {
      const claimFeeVars: IClaimFee = {
        payer: positionOwner,
        pair,
        userTokenX,
        userTokenY,
        market,
        authorityListIndex: 0
      }

      await locker.claimFee(claimFeeVars)
      await sleep(400)
    }

    const reservesAfterClaim = await market.getReserveBalances(pair)
    const expectedTokensClaimed = 4

    assert.ok(reservesBeforeClaim.x.subn(expectedTokensClaimed).eq(reservesAfterClaim.x))
  })
})
