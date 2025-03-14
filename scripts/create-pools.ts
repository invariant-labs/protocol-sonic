import { Provider } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { MOCK_TOKENS, Network } from '@invariant-labs/sdk/src/network'
import { Market, Pair } from '@invariant-labs/sdk/src'
import { FEE_TIERS } from '@invariant-labs/sdk/src/utils'
import { CreatePool } from '@invariant-labs/sdk/src/market'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = Provider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})

const connection = provider.connection
// @ts-expect-error
const wallet = provider.wallet.payer as Keypair

const main = async () => {
  const market = await Market.build(Network.TEST, provider.wallet, connection)

  await createWSOLS22(market)
  await createBtcRenDoge(market)
  await createUsdcBtc(market)
  await createUsdcRenDoge(market)
  await createUsdcUsdt(market)
  await createWsolUsdc(market)
}

const createWSOLS22 = async (market: Market) => {
  const s22 = new PublicKey(MOCK_TOKENS.S22)
  const usdc = new PublicKey(MOCK_TOKENS.WSOL)

  for (const i of [1, 2, 3]) {
    const pair = new Pair(s22, usdc, FEE_TIERS[i])

    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 0
    }
    await market.createPool(createPoolVars)
  }
}

const createUsdcBtc = async (market: Market) => {
  const btc = new PublicKey(MOCK_TOKENS.BTC)
  const usdc = new PublicKey(MOCK_TOKENS.USDC)

  for (const i of [1, 2, 3]) {
    const pair = new Pair(btc, usdc, FEE_TIERS[i])

    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 106800
    }
    await market.createPool(createPoolVars)
  }
}

const createUsdcRenDoge = async (market: Market) => {
  const renDoge = new PublicKey(MOCK_TOKENS.REN_DOGE)
  const usdc = new PublicKey(MOCK_TOKENS.USDC)

  for (const i of [1, 2, 3]) {
    const pair = new Pair(renDoge, usdc, FEE_TIERS[i])

    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 65010
    }
    await market.createPool(createPoolVars)
  }
}

const createBtcRenDoge = async (market: Market) => {
  const renDoge = new PublicKey(MOCK_TOKENS.REN_DOGE)
  const btc = new PublicKey(MOCK_TOKENS.BTC)

  for (const i of [1, 2, 3]) {
    const pair = new Pair(renDoge, btc, FEE_TIERS[i])
    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 171600
    }
    await market.createPool(createPoolVars)
  }
}

const createUsdcUsdt = async (market: Market) => {
  const usdt = new PublicKey(MOCK_TOKENS.USDT)
  const usdc = new PublicKey(MOCK_TOKENS.USDC)

  for (const i of [0, 1]) {
    const pair = new Pair(usdc, usdt, FEE_TIERS[i])
    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 0
    }
    await market.createPool(createPoolVars)
  }
}

const createWsolUsdc = async (market: Market) => {
  const wsol = new PublicKey(MOCK_TOKENS.WSOL)
  const usdc = new PublicKey(MOCK_TOKENS.USDC)

  for (const i of [0, 1, 2]) {
    const pair = new Pair(usdc, wsol, FEE_TIERS[i])
    const createPoolVars: CreatePool = {
      pair,
      payer: wallet,
      initTick: 24000
    }
    await market.createPool(createPoolVars)
  }
}

// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
