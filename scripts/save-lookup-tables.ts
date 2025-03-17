import * as anchor from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market } from '@invariant-labs/sdk/src'
import fs from 'fs'
import {
  fetchAllLookupTablesByPool,
  serializeLookupTableData,
  serializePoolLookupTable
} from '@invariant-labs/sdk/lib/utils'
import { PoolStructure } from '@invariant-labs/sdk/lib/market'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()
const TESTNET_RPC = 'https://api.testnet.sonic.game'

const provider = anchor.AnchorProvider.local(TESTNET_RPC, {
  skipPreflight: false,
  commitment: 'confirmed'
})

const connection = provider.connection

const owner = new PublicKey('7zwsfwpnrxLHA65hzWMZfRtRDva9VjDRrMFWMjp5ZtRi')
const commonLookupTableAddress = new PublicKey('HhXMWL3q3sZ6HWh4kM9NS7vqg9RvVuAP1VqUbXFxhPsW')

const pools = [
  new PublicKey('H4QcXPqL88TUhgD2U5CgJRQEn1qMcBbxRkdczTPxP71f') // ETH/USDC 0.1 - TESTNET
]

const main = async () => {
  const network = Network.TEST
  const market = Market.build(network, provider.wallet, connection)

  const tables = await Promise.all(pools.map(p => fetchAllLookupTablesByPool(connection, owner, p)))

  const commonLookupTable = await connection
    .getAddressLookupTable(commonLookupTableAddress)
    .then(r => r.value)
  if (!commonLookupTable) {
    throw new Error('Common lookup table address not found')
  }

  const prefix = `./artifacts/${network}`

  if (!fs.existsSync(prefix)) {
    fs.mkdirSync(prefix)
  }

  fs.writeFileSync(
    `${prefix}/commonLookupTable.json`,
    JSON.stringify(serializeLookupTableData(commonLookupTable))
  )
  let allTables: any[] = []

  await Promise.all(
    tables.map(async tablesForPool => {
      const poolData = (await market.getPoolByAddress(
        tablesForPool[0].state.addresses[0]
      )) as PoolStructure
      const duplicates = new Set<number>()

      const serializedTables = tablesForPool
        .map(table => {
          const serializedTable = serializePoolLookupTable(table, poolData)
          return serializedTable
        })
        .filter(t => t !== null)
      allTables = allTables.concat(serializedTables)
    })
  )

  fs.writeFileSync(`${prefix}/poolsLookupTables.json`, JSON.stringify(allTables))
  // const serialized = serializeLookupTable(tables[0])
}

main().catch(console.error)
