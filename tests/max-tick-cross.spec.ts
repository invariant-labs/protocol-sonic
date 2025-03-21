import {
  Market,
  Pair,
  Network,
  sleep,
  LIQUIDITY_DENOMINATOR,
  signAndSend
} from '@invariant-labs/sdk'
import { FeeTier, CreatePosition, Swap, TICK_CROSSES_PER_IX } from '@invariant-labs/sdk/lib/market'
import { fromFee, toDecimal } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { assert } from 'chai'
import { createToken, initMarket } from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'

describe('Max tick crosses', () => {
  //const provider = Provider.local(undefined, { skipPreflight: true })
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
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

  it('#swap() max crosses', async () => {
    const positionOwner = Keypair.generate()
    await connection.requestAirdrop(positionOwner.publicKey, 1e9)
    await sleep(1000)
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
    const liquidityDelta = new BN(10000000).mul(LIQUIDITY_DENOMINATOR)

    await market.createPositionList(positionOwner.publicKey, positionOwner)

    for (let i = -160; i < 20; i += 10) {
      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: i,
        upperTick: i + 10,
        liquidityDelta,
        knownPrice: (await market.getPool(pair)).sqrtPrice,
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars, positionOwner)
    }

    assert.ok((await market.getPool(pair)).liquidity.eq(liquidityDelta))

    // Create owner
    const owner = Keypair.generate()
    await connection.requestAirdrop(owner.publicKey, 1e9)
    await sleep(1000)
    const amount = new BN(80000)
    const accountX = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenX,
      owner.publicKey
    )
    const accountY = await createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenY,
      owner.publicKey
    )
    await mintTo(connection, mintAuthority, pair.tokenX, accountX, mintAuthority, amount)

    // Swap
    const poolDataBefore = await market.getPool(pair)

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

    const swapTx = await market.swapTx(swapVars)
    await signAndSend(swapTx, [owner], connection)

    // Check crosses
    const poolData = await market.getPool(pair)
    const crosses = Math.abs((poolData.currentTickIndex - poolDataBefore.currentTickIndex) / 10)
    assert.equal(crosses, TICK_CROSSES_PER_IX)
  })
})
