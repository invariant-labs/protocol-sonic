import { WalletProviderFactory } from './factory'
import { DERIVATION_PATH } from './localStorage'
import { LedgerWalletProvider } from './ledger'
import { AnchorProvider, Provider } from '@coral-xyz/anchor'
import {
  Transaction,
  Connection,
  ConfirmOptions,
  sendAndConfirmRawTransaction
} from '@solana/web3.js'

export const getLedgerWallet = async (): Promise<LedgerWalletProvider> => {
  const args = {
    onDisconnect: () => {
      console.log('disconnected')
    },
    derivationPath: DERIVATION_PATH.bip44Root
  }
  const wallet = WalletProviderFactory.getProvider(args)

  await wallet.init()
  return wallet
}

export const signAndSendLedger = async (
  tx: Transaction,
  connection: Connection,
  wallet: LedgerWalletProvider,
  opts?: ConfirmOptions
) => {
  const blockhash = await connection.getLatestBlockhash(
    opts?.commitment ?? AnchorProvider.defaultOptions().commitment
  )
  tx.recentBlockhash = blockhash.blockhash
  tx.feePayer = wallet.pubKey

  const signedTx = (await wallet.signTransaction(tx)) as Transaction
  const rawTx = signedTx.serialize()
  return await sendAndConfirmRawTransaction(
    connection,
    rawTx,
    opts ?? AnchorProvider.defaultOptions()
  )
}
