import { AnchorProvider, BN, Program } from '@coral-xyz/anchor'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js'
import { getLockerAddress, Network } from './network'
import { IWallet, signAndSend } from '.'
import { Locker as ILocker } from './idl/locker'
import * as IDL from './idl/locker.json'
import { getTokenProgramAddress } from './utils'
import { Market, Pair } from '@invariant-labs/sdk-sonic'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

export class Locker {
  public connection: Connection
  public wallet: IWallet
  public program: Program<ILocker>
  public network: Network

  private constructor(
    network: Network,
    wallet: IWallet,
    connection: Connection,
    _programId?: PublicKey
  ) {
    this.connection = connection
    this.wallet = wallet
    const programAddress = new PublicKey(getLockerAddress(network))
    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions())
    this.network = network

    this.program = new Program<ILocker>(IDL as unknown as ILocker, programAddress, provider)
  }

  public static async buildWithoutProvider(
    network: Network,
    connection: Connection,
    programId?: PublicKey
  ) {
    const instance = new Locker(
      network,
      {
        publicKey: PublicKey.default,
        signTransaction: async tx => {
          return tx
        },
        signAllTransactions: async txs => {
          return txs
        }
      },
      connection,
      programId
    )

    return instance
  }

  public static build(
    network: Network,
    wallet: IWallet,
    connection: Connection,
    programId?: PublicKey
  ): Locker {
    const instance = new Locker(network, wallet, connection, programId)

    return instance
  }

  async sendTx(ix: TransactionInstruction[], signers: Keypair[]) {
    const tx = new Transaction().add(...ix)
    return await signAndSend(tx, signers, this.connection)
  }

  async initializeUserLocksIx(feePayer?: PublicKey): Promise<TransactionInstruction> {
    feePayer ??= this.wallet.publicKey
    const [locks] = this.getUserLocksAddress(feePayer)
    return await this.program.methods
      .initializeUserLocks()
      .accounts({
        owner: feePayer,
        locks,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async lockPosition(params: ILockPosition) {
    const ixs = await this.lockPositionIx(params, params.payer.publicKey)
    return await this.sendTx(ixs, [params.payer])
  }

  async lockPositionIx(
    { lockDuration, market, index }: ILockPositionIx,
    feePayer?: PublicKey
  ): Promise<TransactionInstruction[]> {
    feePayer ??= this.wallet.publicKey

    const [locks] = this.getUserLocksAddress(feePayer)

    const { positionListAddress: authorityList } = market.getPositionListAddress(locks)
    const { positionListAddress: positionList } = market.getPositionListAddress(feePayer)

    const [ownerPositionList, initLocksIfNeededIx] = await Promise.all([
      await market.getPositionList(feePayer),
      await this.initLocksIfNeededIx(feePayer)
    ])

    const ixs = []

    let authorityPositionList
    try {
      authorityPositionList = await market.getPositionList(locks)
    } catch (e) {
      authorityPositionList = { head: 0 }
      ixs.push(await market.createPositionListIx(locks, feePayer))
    }

    const ownerListHead = ownerPositionList?.head ?? 0
    const authorityListHead = authorityPositionList.head ?? 0

    const { positionAddress: position } = market.getPositionAddress(feePayer, index)
    const { positionAddress: lastPosition } = market.getPositionAddress(feePayer, ownerListHead - 1)
    const { positionAddress: transferredPosition } = market.getPositionAddress(
      locks,
      authorityListHead
    )

    const lockIx = await this.program.methods
      .lockPosition(index, lockDuration)
      .accounts({
        owner: feePayer,
        locks,
        authorityList,
        transferredPosition,
        lastPosition,
        invProgram: market.program.programId,
        position,
        positionList,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()

    ixs.push(...initLocksIfNeededIx)
    ixs.push(lockIx)
    return ixs
  }

  async unlockPosition(params: IUnlockPosition) {
    const ixs = await this.unlockPositionIx(params, params.payer.publicKey)
    return await this.sendTx(ixs, [params.payer])
  }
  async unlockPositionIx({ authorityListIndex, market }: IUnlockPositionIx, feePayer?: PublicKey) {
    feePayer ??= this.wallet.publicKey
    const [locks] = this.getUserLocksAddress(feePayer)

    const [authorityPositionList, ownerPositionList] = await Promise.all([
      market.getPositionList(locks),
      market.getPositionList(feePayer)
    ])

    const { positionListAddress: authorityList } = market.getPositionListAddress(locks)
    const { positionListAddress: positionList } = market.getPositionListAddress(feePayer)

    const authorityListHead = authorityPositionList?.head ?? 0
    const ownerListHead = ownerPositionList?.head ?? 0

    const { positionAddress: position } = market.getPositionAddress(locks, authorityListIndex)
    const { positionAddress: lastPosition } = market.getPositionAddress(
      locks,
      authorityListHead - 1
    )

    const { positionAddress: transferredPosition } = market.getPositionAddress(
      feePayer,
      ownerListHead
    )

    const withdrawIx = await this.program.methods
      .unlockPosition(authorityListIndex)
      .accounts({
        owner: feePayer,
        locks,
        authorityList,
        invProgram: market.program.programId,
        position,
        transferredPosition,
        positionList,
        lastPosition,
        systemProgram: SystemProgram.programId
      })
      .instruction()

    return [withdrawIx]
  }

  async claimFee(params: IClaimFee) {
    const ixs = await this.claimFeeIx(params, params.payer.publicKey)
    return await this.sendTx(ixs, [params.payer])
  }
  async claimFeeIx(
    { authorityListIndex, market, pair, userTokenX, userTokenY }: IClaimFeeIx,
    feePayer?: PublicKey
  ) {
    feePayer ??= this.wallet.publicKey
    const [locks] = this.getUserLocksAddress(feePayer)

    const pool = pair.getAddress(market.program.programId)

    const [
      poolState,
      positionState,
      tokenXProgram,
      tokenYProgram,
      authorityPositionList,
      ownerPositionList
    ] = await Promise.all([
      market.getPool(pair),
      market.getPosition(locks, authorityListIndex),
      getTokenProgramAddress(this.connection, pair.tokenX),
      getTokenProgramAddress(this.connection, pair.tokenY),
      market.getPositionList(locks),
      market.getPositionList(feePayer)
    ])

    const { tickAddress: lowerTick } = market.getTickAddress(pair, positionState.lowerTickIndex)
    const { tickAddress: upperTick } = market.getTickAddress(pair, positionState.upperTickIndex)
    const { positionListAddress: authorityList } = market.getPositionListAddress(locks)
    const { positionListAddress: positionList } = market.getPositionListAddress(feePayer)

    const authorityListHead = authorityPositionList?.head ?? 0
    const ownerListHead = ownerPositionList?.head ?? 0

    const { positionAddress: position } = market.getPositionAddress(locks, authorityListIndex)
    const { positionAddress: transferredPosition } = market.getPositionAddress(
      feePayer,
      ownerListHead
    )
    const { positionAddress: lastPosition } = market.getPositionAddress(
      locks,
      authorityListHead - 1
    )

    const { address: state } = market.getStateAddress()

    const claimFeeIx = await this.program.methods
      .claimFee(authorityListIndex, positionState.lowerTickIndex, positionState.upperTickIndex)
      .accounts({
        owner: feePayer,
        locks,
        authorityList,
        invProgram: market.program.programId,
        invState: state,
        invProgramAuthority: market.programAuthority.address,
        position,
        pool,
        lowerTick,
        upperTick,
        positionList,
        transferredPosition,
        lastPosition,
        accountX: userTokenX,
        accountY: userTokenY,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        invReserveX: poolState.tokenXReserve,
        invReserveY: poolState.tokenYReserve,
        tokenXProgram,
        tokenYProgram,
        systemProgram: SystemProgram.programId
      })
      .instruction()

    return [claimFeeIx]
  }

  getUserLocksAddress(owner: PublicKey) {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('Locks'), owner.toBuffer()],
      this.program.programId
    )
  }

  setWallet(wallet: IWallet) {
    this.wallet = wallet
  }

  async getUserLocks(owner: PublicKey) {
    const [locks] = this.getUserLocksAddress(owner)
    return await this.program.account.locks.fetch(locks)
  }

  async getAllLockedPositions(market: Market) {
    const authorities = (await this.program.account.locks.all()).map(a => a.publicKey)
    const promises = authorities.map(authority => market.getAllUserLockedPositions(authority))
    const lockedPositions = await Promise.all(promises)
    return lockedPositions.flat()
  }

  async getUserLockedPositions(market: Market, owner: PublicKey) {
    const [authority] = this.getUserLocksAddress(owner)

    const lockedPositions = await market.getAllUserLockedPositions(authority)

    return lockedPositions
  }

  async initLocksIfNeededIx(feePayer?: PublicKey): Promise<TransactionInstruction[]> {
    feePayer ??= this.wallet.publicKey

    try {
      await this.getUserLocks(feePayer)
      return []
    } catch (e) {
      return [await this.initializeUserLocksIx(feePayer)]
    }
  }

  satisfyDecimal(v: BN): { v: any } {
    return { v }
  }
}

export interface IInitializeUserAuthority extends IInitializeUserAuthorityIx {
  payer: Keypair
}

export interface IInitializeUserAuthorityIx {
  market: PublicKey
  positionList: PublicKey
}

export interface ILockPosition extends ILockPositionIx {
  payer: Keypair
}
export interface ILockPositionIx {
  lockDuration: BN
  market: Market
  index: number
}

export interface IUnlockPosition extends IUnlockPositionIx {
  payer: Keypair
}

export interface IUnlockPositionIx {
  authorityListIndex: number
  market: Market
}

export interface IClaimFee extends IClaimFeeIx {
  payer: Keypair
}
export interface IClaimFeeIx {
  authorityListIndex: number
  userTokenX: PublicKey
  userTokenY: PublicKey
  market: Market
  pair: Pair
}
