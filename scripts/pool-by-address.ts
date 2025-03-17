import { AnchorProvider, Provider } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market } from '@invariant-labs/sdk/src'
import { PoolStructure } from '@invariant-labs/sdk/lib/market'
import { FEE_TIERS, printBN } from '@invariant-labs/sdk/lib/utils'
import { Pair } from '@invariant-labs/sdk'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = AnchorProvider.local('https://api.testnet.sonic.game', {
  skipPreflight: true
})
const connection = provider.connection
const poolAddress = new PublicKey('H4QcXPqL88TUhgD2U5CgJRQEn1qMcBbxRkdczTPxP71f')

const main = async () => {
  const market = await Market.build(Network.MAIN, provider.wallet, connection)

  const token0 = new PublicKey('62rMuAVWh2mQYE9wP4cPhaLDsbn8SzQNbHyJqUM6oQCB')
  const token1 = new PublicKey('6B8zhSGkjZcQxHCE9RFwYMxT8ipifJ4JZLFTskLMcMeL')

  for (const tier of FEE_TIERS) {
    const pair = new Pair(token0, token1, tier)
    console.log(+printBN(tier.fee, 10), pair.getAddress(market.program.programId).toString())
  }

  const pool = await market.getPoolByAddress(poolAddress)
  console.log(pool)
  // const allPools = await market.program.account.pool.all([])

  // let pool = allPools.find(pool => pool.publicKey.equals(poolAddress))
  //   ?.account as any as PoolStructure

  // tokenX = USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  // tokenY = SOL1 | So11111111111111111111111111111111111111112

  // console.log(pool.tokenX.toString())
  // console.log(pool.tokenY.toString())
}
// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
