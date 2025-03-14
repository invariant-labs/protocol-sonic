import { BN, AnchorProvider } from '@coral-xyz/anchor'
import {
  BlockheightBasedTransactionConfirmationStrategy,
  ConfirmOptions,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionSignature
} from '@solana/web3.js'

import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token'

export const MAX_U64 = new BN(1).shln(64)
export const MAX_CONFIRMATION_TIMEOUT = 300 // 300 seconds

export const signAndSend = async (
  tx: Transaction,
  signers: Keypair[],
  connection: Connection,
  opts?: ConfirmOptions
): Promise<TransactionSignature> => {
  tx.feePayer ??= signers[0].publicKey
  const latestBlockhash = await connection.getLatestBlockhash(
    opts?.commitment ?? AnchorProvider.defaultOptions().commitment
  )
  tx.recentBlockhash = latestBlockhash.blockhash
  tx.partialSign(...signers)

  const signature = await connection.sendRawTransaction(
    tx.serialize(),
    opts ?? AnchorProvider.defaultOptions()
  )

  const confirmStrategy: BlockheightBasedTransactionConfirmationStrategy = {
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    signature
  }
  await connection.confirmTransaction(confirmStrategy)

  return signature
}

export const sleep = async (ms: number) => {
  return await new Promise(resolve => setTimeout(resolve, ms))
}

export const getBalance = async (
  connection: Connection,
  ata: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<BN> => {
  const acc = await getAccount(connection, ata, 'confirmed', programId)
  return new BN(acc.amount.toString())
}

export const getTokenProgramAddress = async (
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> => {
  const info = await connection.getAccountInfo(mint)
  if (!info) {
    throw new Error("Couldn't retrieve token program address")
  }
  return info.owner
}

export const getMaxLockDuration = (): BN => {
  const now = new BN(Math.ceil(Date.now() / 1000))
  const maxPossibleTimestamp = MAX_U64.sub(now)
  return maxPossibleTimestamp.subn(MAX_CONFIRMATION_TIMEOUT)
}
