import { AnchorProvider } from '@coral-xyz/anchor'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market, Pair } from '@invariant-labs/sdk-sonic/src'
import { Locker } from '@invariant-labs/locker-sonic-sdk/src/locker'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = AnchorProvider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})

const connection = provider.connection

const main = async () => {
  const network = Network.TEST
  const market = Market.build(network, provider.wallet, connection)

  const locker = Locker.build(network, provider.wallet, connection)

  const lockedPositions = await locker.getAllLockedPositions(market)
  console.log(lockedPositions)
}
// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
