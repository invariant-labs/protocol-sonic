import { FeeTier } from '@invariant-labs/sdk/lib/market'
import { Market, Network, Pair } from '@invariant-labs/sdk/src'
import { MOCK_TOKENS } from '@invariant-labs/sdk/src/network'
import { FEE_TIERS } from '@invariant-labs/sdk/src/utils'
import { Provider } from '@coral-xyz/anchor'
import { clusterApiUrl, PublicKey } from '@solana/web3.js'
// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = Provider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})
const connection = provider.connection

const main = async () => {
  const market = await Market.build(Network.DEV, provider.wallet, connection)

  FEE_TIERS.forEach(async feeTier => {
    console.log(`fee = ${feeTier.fee.toNumber() / 10e9} %`)
    console.log(`tick spacing = ${feeTier.tickSpacing}\n`)
  })
  console.log('------------------')

  const feeTier = (await market.program.account.feeTier.all()).sort(
    (a, b) => a.account.fee.v.toNumber() - b.account.fee.v.toNumber()
  )
  feeTier.forEach(tier => {
    console.log(`fee = ${tier.account.fee.v.toNumber() / 10e9} %`)
    console.log(`tick spacing = ${tier.account.tickSpacing}\n`)
  })
}
// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
