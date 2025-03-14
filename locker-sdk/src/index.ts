import {
  Locker,
  IInitializeUserAuthority,
  IInitializeUserAuthorityIx,
  IUnlockPosition,
  IUnlockPositionIx,
  ILockPosition,
  ILockPositionIx,
  IClaimFee,
  IClaimFeeIx
} from './locker'
import { signAndSend, getMaxLockDuration } from './utils'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { getLockerAddress, Network } from './network'

export { Locker, Network, getLockerAddress, signAndSend, getMaxLockDuration }

export type {
  ILockPosition,
  ILockPositionIx,
  IClaimFee,
  IClaimFeeIx,
  IInitializeUserAuthority,
  IInitializeUserAuthorityIx,
  IUnlockPosition,
  IUnlockPositionIx
}
export interface IWallet {
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>
  publicKey: PublicKey
}
