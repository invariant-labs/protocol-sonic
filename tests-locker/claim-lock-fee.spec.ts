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

describe('claim', () => {
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

    const liquidityDelta = new BN(1000000).mul(LIQUIDITY_DENOMINATOR)

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

    assert.ok((await market.getPool(pair)).liquidity.eq(liquidityDelta))

    const lockPositionVars: ILockPosition = {
      index: 0,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

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

    // Unauthorized user tries to claim fee
    {
      await createAssociatedTokenAccount(
        connection,
        unauthorizedUser,
        pair.tokenX,
        unauthorizedUser.publicKey
      )

      await createAssociatedTokenAccount(
        connection,
        unauthorizedUser,
        pair.tokenY,
        unauthorizedUser.publicKey
      )

      const positionId = new BN(0)
      const authorityMarketIndex = 0

      const [locks] = locker.getUserLocksAddress(positionOwner.publicKey)

      const pool = pair.getAddress(market.program.programId)

      const { tickAddress: lowerTickAddress } = market.getTickAddress(pair, lowerTick)
      const { tickAddress: upperTickAddress } = market.getTickAddress(pair, upperTick)

      const { positionListAddress: authorityList } = market.getPositionListAddress(locks)

      const { positionAddress: position } = market.getPositionAddress(locks, positionId.toNumber())

      const { positionListAddress: positionList } = market.getPositionListAddress(
        positionOwner.publicKey
      )

      const authorityPositionList = await market.getPositionList(locks)
      const ownerPositionList = await market.getPositionList(positionOwner.publicKey)

      const authorityListHead = authorityPositionList?.head ?? 0
      const ownerListHead = ownerPositionList?.head ?? 0

      const { positionAddress: transferredPosition } = market.getPositionAddress(
        positionOwner.publicKey,
        ownerListHead
      )
      const { positionAddress: lastPosition } = market.getPositionAddress(
        locks,
        authorityListHead - 1
      )

      const { address: state } = market.getStateAddress()
      const poolState = await market.getPool(pair)

      const tokenXProgram = await getTokenProgramAddress(locker.connection, pair.tokenX)
      const tokenYProgram = await getTokenProgramAddress(locker.connection, pair.tokenY)
      const accountX = getAssociatedTokenAddressSync(
        pair.tokenX,
        unauthorizedUser.publicKey,
        false,
        tokenXProgram
      )
      const accountY = getAssociatedTokenAddressSync(
        pair.tokenY,
        unauthorizedUser.publicKey,
        false,
        tokenYProgram
      )

      const claimFeeIx = await locker.program.methods
        .claimFee(authorityMarketIndex, lowerTick, upperTick)
        .accounts({
          owner: positionOwner.publicKey,
          locks,
          authorityList,
          invProgram: market.program.programId,
          invState: state,
          invProgramAuthority: market.programAuthority.address,
          position,
          pool,
          lowerTick: lowerTickAddress,
          upperTick: upperTickAddress,
          accountX,
          accountY,
          lastPosition,
          transferredPosition,
          positionList,
          tokenX: pair.tokenX,
          tokenY: pair.tokenY,
          invReserveX: poolState.tokenXReserve,
          invReserveY: poolState.tokenYReserve,
          tokenXProgram,
          tokenYProgram,
          systemProgram: SystemProgram.programId
        })
        .instruction()

      await assertThrowsAsync(
        locker.sendTx([claimFeeIx], [unauthorizedUser]),
        'Missing signature for public key'
      )
    }

    const reservesBeforeClaim = await market.getReserveBalances(pair)
    const userTokenXAccountBeforeClaim = await getBalance(connection, userTokenXAccount)
    const userLocksBefore = await locker.getUserLocks(positionOwner.publicKey)
    const userTokenX = getAssociatedTokenAddressSync(pair.tokenX, positionOwner.publicKey)
    const userTokenY = getAssociatedTokenAddressSync(pair.tokenY, positionOwner.publicKey)
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

    const userTokenXAccountAfterClaim = await getBalance(connection, userTokenXAccount)
    const [locks] = locker.getUserLocksAddress(positionOwner.publicKey)
    const positionAfterClaim = await market.getPosition(locks, 0)
    const reservesAfterClaim = await market.getReserveBalances(pair)
    const userLocksAfter = await locker.getUserLocks(positionOwner.publicKey)
    const expectedTokensClaimed = 5

    assert.ok(userLocksBefore.positions[0].positionId.eq(userLocksAfter.positions[0].positionId))
    assert.ok(reservesBeforeClaim.x.subn(expectedTokensClaimed).eq(reservesAfterClaim.x))
    assert.ok(positionAfterClaim.tokensOwedX.eqn(0))
    assert.ok(positionAfterClaim.feeGrowthInsideX.eq(poolDataAfter.feeGrowthGlobalX))
    assert.ok(
      userTokenXAccountAfterClaim.sub(userTokenXAccountBeforeClaim).eqn(expectedTokensClaimed)
    )
  })
})
