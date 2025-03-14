import { Market, Network } from '@invariant-labs/sdk/src'
import { CreateFeeTier } from '@invariant-labs/sdk/src/market'
import { FEE_TIERS } from '@invariant-labs/sdk/src/utils'
import { AnchorProvider, Provider } from '@coral-xyz/anchor'
import { clusterApiUrl, Keypair } from '@solana/web3.js'
import { MINTER } from './minter'
import { IWallet } from '@invariant-labs/sdk'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const TESTNET_RPC = 'https://api.testnet.sonic.game '

const provider = AnchorProvider.local(TESTNET_RPC, {
  skipPreflight: true
})

const connection = provider.connection

const createStandardFeeTiers = async (market: Market, payer: Keypair) => {
  await Promise.all(
    FEE_TIERS.map(async feeTier => {
      const createFeeTierVars: CreateFeeTier = {
        feeTier,
        admin: payer.publicKey
      }
      await market.createFeeTier(createFeeTierVars, payer)
    })
  )
}

const main = async () => {
  console.log(MINTER.publicKey.toString())

  const market = await Market.build(Network.DEV, provider.wallet as IWallet, connection)
  // await market.createState(MINTER.publicKey, MINTER)
  const createFeeTierVars: CreateFeeTier = {
    feeTier: FEE_TIERS[3],
    admin: MINTER.publicKey
  }
  await market.createFeeTier(createFeeTierVars, MINTER)
  // await createStandardFeeTiers(market, MINTER)
}

// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
