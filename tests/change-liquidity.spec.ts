import * as anchor from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { assert, expect } from 'chai'
import {
  Market,
  Pair,
  calculatePriceSqrt,
  LIQUIDITY_DENOMINATOR,
  Network
} from '@invariant-labs/sdk'
import { Provider, BN } from '@coral-xyz/anchor'
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createToken, initMarket } from './testUtils'
import { fromFee } from '@invariant-labs/sdk/src/utils'
import { FeeTier } from '@invariant-labs/sdk/lib/market'
import { INVARIANT_ERRORS } from '@invariant-labs/sdk'

describe('change liquidity', () => {
  const provider = Provider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = { fee: fromFee(new BN(0)), tickSpacing: 1 }
  const [lowerTickIndex, upperTickIndex] = [-10, 10]
  const initTick: number = 0
  const initSqrtPrice = calculatePriceSqrt(initTick)

  let market: Market
  let pair: Pair
  let tokenX: Token
  let tokenY: Token
  let positionCounter = -1

  beforeEach(async () => {
    positionCounter++

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
      connection.requestAirdrop(positionOwner.publicKey, 1e9)
    ])
    // Create pair
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])
    pair = new Pair(tokens[0].publicKey, tokens[1].publicKey, feeTier)
    tokenX = new Token(connection, pair.tokenX, TOKEN_PROGRAM_ID, wallet)
    tokenY = new Token(connection, pair.tokenY, TOKEN_PROGRAM_ID, wallet)

    const userTokenAccounts = await Promise.all([
      tokenX.createAssociatedTokenAccount(positionOwner.publicKey),
      tokenY.createAssociatedTokenAccount(positionOwner.publicKey)
    ])

    await Promise.all([
      tokenX.mintTo(userTokenAccounts[0], mintAuthority.publicKey, [mintAuthority], 500),
      tokenY.mintTo(userTokenAccounts[1], mintAuthority.publicKey, [mintAuthority], 500)
    ])

    await initMarket(market, [pair], admin, initTick)

    await Promise.all([
      market.createTick(
        {
          pair,
          index: lowerTickIndex,
          payer: admin.publicKey
        },
        admin
      ),
      market.createTick(
        {
          pair,
          index: upperTickIndex,
          payer: admin.publicKey
        },
        admin
      )
    ])

    const { positionListAddress } = await market.getPositionListAddress(positionOwner.publicKey)
    const positionListAccount = await connection.getAccountInfo(positionListAddress)

    if (positionListAccount === null) {
      await market.createPositionList(positionOwner.publicKey, positionOwner)
    }

    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(10_000) }
    await market.createPosition(
      {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenAccounts[0],
        userTokenY: userTokenAccounts[1],
        lowerTick: lowerTickIndex,
        upperTick: upperTickIndex,
        liquidityDelta,
        knownPrice: initSqrtPrice,
        slippage: { v: new BN(0) }
      },
      positionOwner
    )

    const position = await market.getPosition(positionOwner.publicKey, positionCounter)
    const pool = await market.getPool(pair)
    const lowerTick = await market.getTick(pair, lowerTickIndex)
    const upperTick = await market.getTick(pair, upperTickIndex)

    assert(position.liquidity.v.eq(liquidityDelta.v))
    assert(pool.liquidity.v.eq(liquidityDelta.v))
    assert(lowerTick.liquidityChange.v.eq(liquidityDelta.v))
    expect(lowerTick.sign).to.be.true
    assert(upperTick.liquidityChange.v.eq(liquidityDelta.v))
    expect(upperTick.sign).to.be.false
  })

  it('increase', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    const pool = await market.getPool(pair)
    const dexBalanceXBefore = (await tokenX.getAccountInfo(pool.tokenXReserve)).amount
    const dexBalanceYBefore = (await tokenY.getAccountInfo(pool.tokenYReserve)).amount
    assert(dexBalanceXBefore.eq(new BN(5)))
    assert(dexBalanceYBefore.eq(new BN(5)))

    const userBalanceXBefore = (await tokenX.getAccountInfo(userTokenXAccount)).amount
    const userBalanceYBefore = (await tokenY.getAccountInfo(userTokenYAccount)).amount
    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(10_000) }
    await market.changeLiquidity(
      {
        owner: positionOwner.publicKey,
        pair,
        knownPrice: initSqrtPrice,
        slippage: { v: new BN(0) },
        index: positionCounter,
        lowerTickIndex,
        upperTickIndex,
        liquidityDelta,
        addLiquidity: true,
        accountX: userTokenXAccount,
        accountY: userTokenYAccount
      },
      positionOwner
    )

    const userBalanceXAfter = (await tokenX.getAccountInfo(userTokenXAccount)).amount
    const userBalanceYAfter = (await tokenY.getAccountInfo(userTokenYAccount)).amount

    assert(userBalanceXBefore.sub(userBalanceXAfter).eq(new BN(5)))
    assert(userBalanceYBefore.sub(userBalanceYAfter).eq(new BN(5)))
  })

  it('decrease', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    const userBalanceXBefore = (await tokenX.getAccountInfo(userTokenXAccount)).amount
    const userBalanceYBefore = (await tokenY.getAccountInfo(userTokenYAccount)).amount
    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(5_000) }
    await market.changeLiquidity(
      {
        owner: positionOwner.publicKey,
        pair,
        knownPrice: initSqrtPrice,
        slippage: { v: new BN(0) },
        index: positionCounter,
        lowerTickIndex,
        upperTickIndex,
        liquidityDelta,
        addLiquidity: false,
        accountX: userTokenXAccount,
        accountY: userTokenYAccount
      },
      positionOwner
    )

    const userBalanceXAfter = (await tokenX.getAccountInfo(userTokenXAccount)).amount
    const userBalanceYAfter = (await tokenY.getAccountInfo(userTokenYAccount)).amount

    assert(userBalanceXAfter.sub(userBalanceXBefore).eq(new BN(2)))
    assert(userBalanceYAfter.sub(userBalanceYBefore).eq(new BN(2)))
  })

  it('amount is zero', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    const liquidityDelta = { v: new BN(1) }

    try {
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta,
          addLiquidity: false,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
      // If the promise resolves, the test should fail
      expect.fail('Expected an error to be thrown')
    } catch (error: unknown) {
      // Type guard to check if error is of type InvariantError
      if (error instanceof Error) {
        const invariantError = error as Error
        expect(invariantError.message).to.contain(INVARIANT_ERRORS.ZERO_OUTPUT)
      } else {
        // If it's not the expected error type, fail the test
        expect.fail(`Expected Error, but got: ${error}`)
      }
    }
  })

  it('remove all but 1 liquidity and then position', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    {
      const position = await market.getPosition(positionOwner.publicKey, positionCounter)
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta: { v: position.liquidity.v.sub(new BN(1)) },
          addLiquidity: false,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
    }

    const position = await market.getPosition(positionOwner.publicKey, positionCounter)
    assert(position.liquidity.v.eq(new BN(1)))

    await market.removePosition(
      {
        pair,
        owner: positionOwner.publicKey,
        index: positionCounter,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      },
      positionOwner
    )
    positionCounter--
  })

  it('zero liquidity', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(10_000) }

    try {
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta,
          addLiquidity: false,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
      // If the promise resolves, the test should fail
      expect.fail('Expected an error to be thrown')
    } catch (error: unknown) {
      // Type guard to check if error is of type InvariantError
      if (error instanceof Error) {
        const invariantError = error as Error
        expect(invariantError.message).to.contain(INVARIANT_ERRORS.POSITION_WITHOUT_LIQUIDITY)
      } else {
        // If it's not the expected error type, fail the test
        expect.fail(`Expected Error, but got: ${error}`)
      }
    }
  })

  it('zero liquidity change', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    try {
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta: { v: new BN(0) },
          addLiquidity: true,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
      // If the promise resolves, the test should fail
      expect.fail('Expected an error to be thrown')
    } catch (error: unknown) {
      // Type guard to check if error is of type InvariantError
      if (error instanceof Error) {
        const invariantError = error as Error
        expect(invariantError.message).to.contain(INVARIANT_ERRORS.ZERO_AMOUNT)
      } else {
        // If it's not the expected error type, fail the test
        expect.fail(`Expected Error, but got: ${error}`)
      }
    }
  })

  it('insufficient balance', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(10_000_000) }

    try {
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta,
          addLiquidity: true,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
      // If the promise resolves, the test should fail
      expect.fail('Expected an error to be thrown')
    } catch (e: unknown) {
      // Type guard to check if error is of type InvariantError
      if (e instanceof Error) {
        const error = e as Error
        // 0x1 is Solana's error code for insufficient balance
        expect(error.message).to.contain('0x1')
      } else {
        // If it's not the expected error type, fail the test
        expect.fail(`Expected Error, but got: ${e}`)
      }
    }
  })

  it('no position', async () => {
    const userTokenXAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenX,
      positionOwner.publicKey
    )
    const userTokenYAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      pair.tokenY,
      positionOwner.publicKey
    )

    await market.removePosition(
      {
        pair,
        owner: positionOwner.publicKey,
        index: positionCounter,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      },
      positionOwner
    )

    const liquidityDelta = { v: LIQUIDITY_DENOMINATOR.muln(10_000) }

    try {
      await market.changeLiquidity(
        {
          owner: positionOwner.publicKey,
          pair,
          knownPrice: initSqrtPrice,
          slippage: { v: new BN(0) },
          index: positionCounter,
          lowerTickIndex,
          upperTickIndex,
          liquidityDelta,
          addLiquidity: true,
          accountX: userTokenXAccount,
          accountY: userTokenYAccount
        },
        positionOwner
      )
      // If the promise resolves, the test should fail
      expect.fail('Expected an error to be thrown')
    } catch (e: unknown) {
      // Type guard to check if error is of type InvariantError
      if (e instanceof Error) {
        const error = e as Error
        // 0xbbf is Solana's error code for `AccountOwnedByWrongProgram`
        // in this case system program owns the account because we didn't initialize it
        expect(error.message).to.contain('0xbbf')
      } else {
        // If it's not the expected error type, fail the test
        expect.fail(`Expected Error, but got: ${e}`)
      }
      positionCounter--
    }
  })
})
