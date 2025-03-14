import { AnchorProvider } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market, Pair } from '@invariant-labs/sdk-sonic/src'
import { Locker } from '@invariant-labs/locker-sonic-sdk/src/locker'
import { MINTER } from '../minter'
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes'
import { getMaxLockDuration } from '@invariant-labs/locker-sonic-sdk'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = AnchorProvider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})

const connection = provider.connection

const main = async () => {
  const bs = bs58.decode('PRIVATE_KEY')
  const positionOwner = Keypair.fromSecretKey(bs)
  const network = Network.TEST
  const market = Market.build(network, provider.wallet, connection)

  const locker = Locker.build(network, provider.wallet, connection)
  const authority = locker.getAuthorityAddress()[0]

  const requeriedPositions = await market.getAllPositions()

  const lockedPosition = requeriedPositions.filter(p => p.owner.equals(authority))[0]

  const pool = await market.getPoolByAddress(lockedPosition.pool)
  const pair = new Pair(pool.tokenX, pool.tokenY, {
    fee: pool.fee.v,
    tickSpacing: pool.tickSpacing
  })

  await locker.claimFee({
    payer: positionOwner,
    pair,
    positionId: lockedPosition.id,
    authorityMarketIndex: 0,
    lowerTickIndex: lockedPosition.lowerTickIndex,
    upperTickIndex: lockedPosition.upperTickIndex,
    market
  })
}
// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
