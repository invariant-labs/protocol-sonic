import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { Network, Market, Pair } from '@invariant-labs/sdk'
import { assertThrowsAsync, createToken, initMarket } from './testUtils'
import { assert } from 'chai'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import { FeeTier } from '@invariant-labs/sdk/lib/market'

describe('create-pool', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const admin = Keypair.generate()
  const feeTiers: FeeTier[] = [
    {
      fee: fromFee(new BN(600)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(700)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(800)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(900)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(1000)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(1100)),
      tickSpacing: 10
    },
    {
      fee: fromFee(new BN(1200)),
      tickSpacing: 10
    }
  ]
  let market: Market
  let pairs: Pair[] = []

  before(async () => {
    market = await Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    await Promise.all([
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9)
    ])

    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])

    for (const feeTier of feeTiers) {
      pairs.push(new Pair(tokens[0], tokens[1], feeTier))
    }
  })

  it('#init()', async () => {
    await initMarket(market, [], admin)
    for (const feeTier of feeTiers) {
      await market.createFeeTier(
        {
          feeTier: feeTier,
          admin: admin.publicKey
        },
        admin
      )
    }
  })

  it('#create-with-tick-index', async () => {
    const pair = pairs[0]
    await market.createPool({
      payer: admin,
      pair: pair,
      initTick: 20
    })

    const pool = await market.getPool(pair)

    assert.ok(new BN('1001000450120000000000000').eq(pool.sqrtPrice))
  })

  it('#create-with-sqrt-price', async () => {
    const pair = pairs[1]
    const sqrtPrice = new BN('1001000450120000000000000').add(new BN('200'))

    await market.createPoolWithSqrtPrice({
      payer: admin,
      pair: pair,
      initSqrtPrice: sqrtPrice
    })

    const pool = await market.getPool(pair)

    assert.ok(sqrtPrice.eq(pool.sqrtPrice))
  })

  it('#create-at-max-sqrt-price', async () => {
    const pair = pairs[2]
    const sqrtPrice = new BN('65509176333123237000000000000')

    await assertThrowsAsync(
      market.createPoolWithSqrtPrice({
        payer: admin,
        pair: pair,
        initSqrtPrice: sqrtPrice
      })
    )
  })

  it('#create-below-max-sqrt-price', async () => {
    const pair = pairs[3]
    const sqrtPrice = new BN('65509176333123237000000000000').sub(new BN(1))

    await market.createPoolWithSqrtPrice({
      payer: admin,
      pair: pair,
      initSqrtPrice: sqrtPrice
    })
    const pool = await market.getPool(pair)

    assert.ok(sqrtPrice.eq(pool.sqrtPrice))
  })

  it('#create-below-min-sqrt-price', async () => {
    const pair = pairs[4]
    const sqrtPrice = new BN('15265036000000000000').sub(new BN(1))

    await assertThrowsAsync(
      market.createPoolWithSqrtPrice({
        payer: admin,
        pair: pair,
        initSqrtPrice: sqrtPrice
      })
    )
  })

  it('#create-with-min-sqrt-price', async () => {
    const pair = pairs[5]
    const sqrtPrice = new BN('15265036000000000000')

    await market.createPoolWithSqrtPrice({
      payer: admin,
      pair: pair,
      initSqrtPrice: sqrtPrice
    })
    const pool = await market.getPool(pair)

    assert.ok(sqrtPrice.eq(pool.sqrtPrice))
  })
})
