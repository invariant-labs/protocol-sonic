import * as anchor from '@coral-xyz/anchor'
import { BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market, Pair } from '@invariant-labs/sdk/src'
import { FEE_TIERS } from '@invariant-labs/sdk/src/utils'
import {
  createAndExtendAddressLookupTableTxs,
  fetchLookupTableByPoolAccount,
  fetchLookupTableByPoolAndAdjustedTickIndex,
  generateLookupTableForCommonAccounts,
  generateLookupTableForPool,
  generateLookupTableRangeForTicks,
  getRealTickFromAdjustedLookupTableStartingTick
} from '@invariant-labs/sdk/src/utils'
import assert from 'assert'
import { sleep } from '@invariant-labs/sdk'
import { LedgerWalletProvider } from './walletProvider/ledger'
import { getLedgerWallet, signAndSendLedger } from './walletProvider/wallet'
import { signAndSend } from '@invariant-labs/sdk'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()
const TESTNET_RPC = 'https://api.testnet.sonic.game'

const provider = anchor.AnchorProvider.local(TESTNET_RPC, {
  skipPreflight: false,
  commitment: 'confirmed'
})

const connection = provider.connection

// @ts-expect-error
const wallet = provider.wallet.payer as Keypair
const commonLookupTableExist = true

// ETH/USDC - TESTNET
const token0 = new PublicKey('62rMuAVWh2mQYE9wP4cPhaLDsbn8SzQNbHyJqUM6oQCB')
const token1 = new PublicKey('6B8zhSGkjZcQxHCE9RFwYMxT8ipifJ4JZLFTskLMcMeL')
const minTick = 72380
const maxTick = 82380
const tierIndex = 3
// let ledgerWallet: LedgerWalletProvider
// let ledgerPubkey: PublicKey = PublicKey.default

const createPoolLookupTable = async (market: Market, pair: Pair) => {
  const poolAsssociatedAddresses = generateLookupTableForPool(
    market,
    pair,
    await market.getPool(pair)
  )

  // const accounts = await fetchLookupTableByPoolAccount(market, ledgerPubkey, pair)
  const accounts = await fetchLookupTableByPoolAccount(market, wallet.publicKey, pair)
  if (accounts.length) {
    console.warn('Pool account lookup table already initialized')
    for (let i = 0; i < poolAsssociatedAddresses.length; i++) {
      assert(accounts[0].state.addresses[i].equals(poolAsssociatedAddresses[i]))
      return accounts[0].key
    }
  }

  console.log(
    'Creating pool lookup tables for',
    pair.getAddress(market.program.programId).toString()
  )

  const slot = await connection.getSlot('confirmed')

  const createPoolLookupTableTxs = await createAndExtendAddressLookupTableTxs(
    // ledgerPubkey,
    wallet.publicKey,
    slot,
    poolAsssociatedAddresses
  )
  console.log('Pool associated addresses', createPoolLookupTableTxs.lookupTableAddress.toString())

  assert(createPoolLookupTableTxs.txs.length === 1)

  // await signAndSendLedger(createPoolLookupTableTxs.txs[0], connection, ledgerWallet)
  await signAndSend(createPoolLookupTableTxs.txs[0], [wallet], connection)
  return createPoolLookupTableTxs.lookupTableAddress
}

const createTickLookupTables = async (
  market: Market,
  pair: Pair,
  startingTick: number,
  finalTick: number,
  validateAfter: boolean = false,
  validateDelay: number = 12000
) => {
  const ticks = generateLookupTableRangeForTicks(market, pair, startingTick, finalTick)
  const addresses: [number, PublicKey][] = []
  // const currentSlot = await connection.getSlot('recent')
  // const slots = await connection.getBlocks(currentSlot - 200, currentSlot, 'finalized')
  // let slotsCounter = 0

  // if (slots.length <= (startingTick - finalTick) / TICK_COUNT_PER_LOOKUP_TABLE) {
  //   throw new Error(`Could find only ${slots.length} ${slots} on the main fork`)
  // }

  for (const tickRange of ticks) {
    try {
      const result = await fetchLookupTableByPoolAndAdjustedTickIndex(
        market,
        // ledgerPubkey,
        wallet.publicKey,
        pair,
        tickRange.startingTickForLookupTable
      )

      console.warn(
        'Lookup table already initialized:',
        result[0].key.toString(),
        'with',
        result[0].state.addresses.length,
        'addresses, on tick:',
        getRealTickFromAdjustedLookupTableStartingTick(
          pair.tickSpacing,
          tickRange.startingTickForLookupTable
        )
      )
      for (let i = 0; i < tickRange.addresses.length; i++) {
        let correct = true
        if (i === 1) {
          correct = new BN(result[0].state.addresses[i].toBuffer()).eq(
            new BN(tickRange.addresses[i].toBuffer())
          )
        } else {
          correct = result[0].state.addresses[i].equals(tickRange.addresses[i])
        }
        assert(
          correct,
          `Address of the existing table at index ${i} is incorrect, remove the table and try again`
        )
      }

      continue
    } catch (e) {}

    const currentSlot = await connection.getSlot('recent')
    const lookupTableTxs = await createAndExtendAddressLookupTableTxs(
      // ledgerPubkey,
      wallet.publicKey,
      // slots[slotsCounter],
      currentSlot,
      tickRange.addresses
    )

    // slotsCounter += 1

    console.log(
      'Processing table',
      lookupTableTxs.lookupTableAddress.toString(),
      'with starting index',
      getRealTickFromAdjustedLookupTableStartingTick(
        pair.tickSpacing,
        tickRange.startingTickForLookupTable
      )
    )

    assert(tickRange.addresses[0].equals(pair.getAddress(market.program.programId)))
    assert(
      tickRange.addresses[1].equals(new PublicKey(new BN(tickRange.startingTickForLookupTable)))
    )

    const [initTx, ...remiaining] = lookupTableTxs.txs

    // await signAndSendLedger(initTx, connection, ledgerWallet)
    await signAndSend(initTx, [wallet], connection)
    await sleep(400)

    addresses.push([
      getRealTickFromAdjustedLookupTableStartingTick(
        pair.tickSpacing,
        tickRange.startingTickForLookupTable
      ),
      lookupTableTxs.lookupTableAddress
    ])

    for (const rem of remiaining) {
      // await signAndSendLedger(rem, connection, ledgerWallet)
      await signAndSend(rem, [wallet], connection)
    }
    if (validateAfter) {
      await sleep(validateDelay ?? 12000)
      const result = await fetchLookupTableByPoolAndAdjustedTickIndex(
        market,
        // ledgerPubkey,
        wallet.publicKey,
        pair,
        tickRange.startingTickForLookupTable
      )

      if (result.length === 1) {
        for (let i = 0; i < tickRange.addresses.length; i++) {
          let correct = true
          if (i === 1) {
            correct = new BN(result[0].state.addresses[i].toBuffer()).eq(
              new BN(tickRange.addresses[i].toBuffer())
            )
          } else {
            correct = result[0].state.addresses[i].equals(tickRange.addresses[i])
          }
          assert(correct, `Address at index ${i} is incorrect, remove the table and try again`)
        }
      } else {
        throw new Error(
          'Multiple lookup tables exist, deactivate and close existing tables to esure that the right one is being fetched'
        )
      }
    }
  }
  return addresses
}

const createCommonLookupTable = async (market: Market) => {
  const slot = await market.connection.getSlot()
  const accounts = generateLookupTableForCommonAccounts(market)
  // const tx = await createAndExtendAddressLookupTableTxs(ledgerPubkey, slot, accounts)
  const tx = await createAndExtendAddressLookupTableTxs(wallet.publicKey, slot, accounts)
  console.info('Initializing common lookup table', tx.lookupTableAddress.toString())

  // await signAndSendLedger(tx.txs[0], connection, ledgerWallet)
  signAndSend(tx.txs[0], [wallet], connection)

  return tx.lookupTableAddress
}
const main = async () => {
  //
  const market = Market.build(Network.DEV, provider.wallet, connection)

  // ledgerWallet = await getLedgerWallet()
  // ledgerPubkey = ledgerWallet.publicKey as PublicKey

  // console.log('owner', ledgerPubkey.toString())
  console.log('owner', wallet.publicKey.toString())

  const tier = FEE_TIERS[tierIndex]
  const pair = new Pair(token0, token1, tier)
  console.log('pool', pair.getAddress(market.program.programId).toString())

  // create common lookup table (call it once per contract)
  if (!commonLookupTableExist) {
    await createCommonLookupTable(market)
  }

  // create account that stores reserves and tickmap if it doesn't exist yet
  const poolLookupTable = await createPoolLookupTable(market, pair)

  // create accounts which store ticks for the specified range, disable validation to make it faster
  const validateAfterCreation = false
  const validateDelay = 24000
  const addedLookupTables = await createTickLookupTables(
    market,
    pair,
    minTick,
    maxTick,
    validateAfterCreation,
    validateDelay
  )
  console.log(poolLookupTable.toString(), addedLookupTables)
}

main().catch(console.error)
