import { getStakerAddress, Network } from './network'
import { Staker as StakerIdl, IDL } from './idl/staker'
import { BN, Program, Provider } from '@coral-xyz/anchor'
import { IWallet } from '.'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { UpdateSecondsPerLiquidity, Market } from '@invariant-labs/sdk/lib/market'
import {
  Connection,
  PublicKey,
  ConfirmOptions,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  Keypair,
  sendAndConfirmRawTransaction
} from '@solana/web3.js'
import { STAKER_SEED } from './utils'
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes'

export class Staker {
  public connection: Connection
  public network: Network
  public wallet: IWallet
  public programId: PublicKey
  public program: Program<StakerIdl>
  public programAuthority: ProgramAuthority = { authority: PublicKey.default, nonce: 0 }
  public opts?: ConfirmOptions

  private constructor(
    connection: Connection,
    network: Network,
    wallet: IWallet,
    opts?: ConfirmOptions
  ) {
    this.connection = connection
    this.wallet = wallet
    this.opts = opts
    this.programId = new PublicKey(getStakerAddress(network))
    const provider = new Provider(connection, wallet, opts ?? Provider.defaultOptions())
    const programAddress = new PublicKey(getStakerAddress(network))

    this.network = network
    this.program = new Program(IDL, programAddress, provider)
  }

  public static async build(
    network: Network,
    wallet: IWallet,
    connection: Connection
  ): Promise<Staker> {
    const instance = new Staker(connection, network, wallet)
    instance.programAuthority = await instance.getProgramAuthority()

    return instance
  }

  // frontend methods
  public async createIncentive(createIncentive: CreateIncentive) {
    const incentiveAccount = Keypair.generate()
    const incentiveTokenAccount = Keypair.generate()
    const incentive = incentiveAccount.publicKey
    const incentiveToken = incentiveTokenAccount.publicKey
    const createIx = await this.createIncentiveIx(
      createIncentive,
      incentiveAccount.publicKey,
      incentiveTokenAccount.publicKey
    )
    const tx = new Transaction().add(createIx)
    const stringTx = await this.signAndSend(tx, [incentiveAccount, incentiveTokenAccount])

    return { stringTx, incentive, incentiveToken }
  }

  public async createStake(
    market: Market,
    update: UpdateSecondsPerLiquidity,
    createStake: CreateStake
  ) {
    const updateIx = await market.updateSecondsPerLiquidityInstruction(update)
    const stakeIx = await this.createStakeIx(createStake)
    const tx = new Transaction().add(updateIx).add(stakeIx)
    const stringTx = await this.signAndSend(tx)
    const [stake] = await this.getUserStakeAddressAndBump(
      createStake.incentive,
      createStake.pool,
      createStake.id
    )

    return { stringTx, stake }
  }

  public async withdraw(market: Market, update: UpdateSecondsPerLiquidity, withdraw: Withdraw) {
    const updateIx = await market.updateSecondsPerLiquidityInstruction(update)
    const withdrawIx = await this.withdrawIx(withdraw)
    const tx = new Transaction().add(updateIx).add(withdrawIx)
    const stringTx = await this.signAndSend(tx)

    return stringTx
  }

  public async endIncentive(endIncentive: EndIncentive) {
    const endIncentiveIx = await this.endIncentiveIx(endIncentive)
    const tx = new Transaction().add(endIncentiveIx)
    const stringTx = await this.signAndSend(tx)

    return stringTx
  }

  public async removeStake(pool: PublicKey, id: BN, incentive: PublicKey, founder: PublicKey) {
    const [userStakeAddress] = await this.getUserStakeAddressAndBump(incentive, pool, id)

    const removeIx = await this.removeStakeIx(userStakeAddress, incentive, founder)
    const tx = new Transaction().add(removeIx)
    const stringTx = await this.signAndSend(tx)

    return stringTx
  }

  public async closeStakeByOwner(closeStake: CloseStake) {
    const { pool, id, incentive, position, owner, index } = closeStake
    const [userStakeAddress] = await this.getUserStakeAddressAndBump(incentive, pool, id)

    const closeIx = await this.closeStakeByOwnerIx(
      userStakeAddress,
      incentive,
      position,
      owner,
      index
    )
    const tx = new Transaction().add(closeIx)
    const stringTx = await this.signAndSend(tx)

    return stringTx
  }

  public async removeAllStakes(incentive: PublicKey, founder: PublicKey) {
    const stakes = await this.getAllIncentiveStakes(incentive)
    let tx = new Transaction()
    const txs: Transaction[] = []

    // put max 18 Ix per Tx, sign and return array of tx hashes
    for (let i = 0; i < stakes.length; i++) {
      const removeIx = await this.removeStakeIx(stakes[i].publicKey, incentive, founder)
      tx.add(removeIx)
      // sign and send when max Ix or last stake
      if ((i + 1) % 18 === 0 || i + 1 === stakes.length) {
        txs.push(tx)
        tx = new Transaction()
      }
    }

    return await this.signAndSendAll(txs)
  }

  // instructions

  public async createIncentiveIx(
    {
      reward,
      startTime,
      endTime,
      founder,
      pool,
      incentiveToken,
      founderTokenAccount,
      invariant
    }: CreateIncentive,
    incentive: PublicKey,
    incentiveTokenAccount: PublicKey
  ) {
    return this.program.instruction.createIncentive(
      this.programAuthority.nonce,
      reward,
      startTime,
      endTime,
      {
        accounts: {
          incentive: incentive,
          pool,
          incentiveTokenAccount,
          incentiveToken,
          founderTokenAccount,
          founder: founder,
          stakerAuthority: this.programAuthority.authority,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          invariant,
          rent: SYSVAR_RENT_PUBKEY
        }
      }
    )
  }

  public async createStakeIx({
    pool,
    id,
    position,
    incentive,
    owner,
    signer,
    index,
    invariant
  }: CreateStake) {
    const [userStakeAddress] = await this.getUserStakeAddressAndBump(incentive, pool, id)

    return this.program.instruction.stake(index, {
      accounts: {
        userStake: userStakeAddress,
        position,
        incentive,
        owner,
        signer: signer ?? owner,
        systemProgram: SystemProgram.programId,
        invariant,
        rent: SYSVAR_RENT_PUBKEY
      }
    })
  }

  public async withdrawIx({
    incentive,
    pool,
    id,
    incentiveTokenAccount,
    ownerTokenAcc,
    position,
    owner,
    index
  }: Withdraw) {
    const [userStakeAddress] = await this.getUserStakeAddressAndBump(incentive, pool, id)

    return this.program.instruction.withdraw(index, this.programAuthority.nonce, {
      accounts: {
        userStake: userStakeAddress,
        incentive,
        incentiveTokenAccount: incentiveTokenAccount,
        ownerTokenAccount: ownerTokenAcc,
        position,
        stakerAuthority: this.programAuthority.authority,
        owner,
        tokenProgram: TOKEN_PROGRAM_ID
      }
    })
  }

  public async endIncentiveIx({
    incentive,
    incentiveToken,
    incentiveTokenAccount,
    founderTokenAccount,
    founder
  }: EndIncentive) {
    return this.program.instruction.endIncentive(this.programAuthority.nonce, {
      accounts: {
        incentive,
        incentiveToken,
        incentiveTokenAccount: incentiveTokenAccount,
        founderTokenAccount: founderTokenAccount,
        stakerAuthority: this.programAuthority.authority,
        founder: founder,
        tokenProgram: TOKEN_PROGRAM_ID
      }
    })
  }

  public async removeStakeIx(userStake: PublicKey, incentive: PublicKey, founder: PublicKey) {
    return this.program.instruction.removeStake({
      accounts: {
        incentive,
        userStake: userStake,
        founder: founder
      }
    })
  }

  public async closeStakeByOwnerIx(
    userStake: PublicKey,
    incentive: PublicKey,
    position: PublicKey,
    owner: PublicKey,
    index: number
  ) {
    return this.program.instruction.closeStakeByOwner(index, {
      accounts: {
        incentive,
        userStake,
        position,
        owner
      }
    })
  }

  // getters
  async getProgramAuthority() {
    const [authority, nonce] = await PublicKey.findProgramAddress(
      [Buffer.from(STAKER_SEED)],
      this.program.programId
    )

    return {
      authority,
      nonce
    }
  }

  public async getIncentive(incentivePubKey: PublicKey) {
    return (await this.program.account.incentive.fetch(incentivePubKey)) as IncentiveStructure
  }

  public async getUserStakeAddressAndBump(incentive: PublicKey, pool: PublicKey, id: BN) {
    const pubBuf = pool.toBuffer()
    const idBuf = Buffer.alloc(16)
    idBuf.writeBigUInt64LE(BigInt(id.toString()))
    return await PublicKey.findProgramAddress(
      [Buffer.from(STAKER_SEED), incentive.toBuffer(), pubBuf, idBuf],
      this.programId
    )
  }

  public async getStake(incentive: PublicKey, pool: PublicKey, id: BN) {
    const [userStakeAddress] = await this.getUserStakeAddressAndBump(incentive, pool, id)
    return await this.program.account.userStake.fetch(userStakeAddress)
  }

  public async getAllIncentiveStakes(incentive: PublicKey) {
    return await this.program.account.userStake.all([
      {
        memcmp: { bytes: bs58.encode(incentive.toBuffer()), offset: 8 }
      }
    ])
  }

  public async getAllIncentive() {
    return (await this.program.account.incentive.all()).map(i => {
      return { ...i.account, publicKey: i.publicKey }
    }) as Incentive[]
  }

  private async signAndSend(tx: Transaction, signers?: Keypair[], opts?: ConfirmOptions) {
    const blockhash = await this.connection.getRecentBlockhash(
      this.opts?.commitment || Provider.defaultOptions().commitment
    )
    tx.feePayer = this.wallet.publicKey
    tx.recentBlockhash = blockhash.blockhash

    const signedTx = await this.wallet.signTransaction(tx)
    if (signers) signedTx.partialSign(...signers)

    const rawTx = signedTx.serialize()
    return await sendAndConfirmRawTransaction(
      this.connection,
      rawTx,
      opts ?? Provider.defaultOptions()
    )
  }

  private async signAndSendAll(txs: Transaction[], opts?: ConfirmOptions) {
    const blockhash = await this.connection.getRecentBlockhash(
      this.opts?.commitment || Provider.defaultOptions().commitment
    )
    txs.forEach(tx => {
      tx.feePayer = this.wallet.publicKey
      tx.recentBlockhash = blockhash.blockhash
    })

    const signedTxs = await this.wallet.signAllTransactions(txs)

    const stringTx: string[] = []
    for (let i = 0; i < signedTxs.length; i++) {
      const rawTx = signedTxs[i].serialize()
      stringTx.push(
        await sendAndConfirmRawTransaction(
          this.connection,
          rawTx,
          opts ?? Provider.defaultOptions()
        )
      )
    }

    return stringTx
  }
}
export interface ProgramAuthority {
  authority: PublicKey
  nonce: number
}
export interface CreateIncentive {
  reward: Decimal
  startTime: Decimal
  endTime: Decimal
  pool: PublicKey
  founder: PublicKey
  incentiveToken: PublicKey
  founderTokenAccount: PublicKey
  invariant: PublicKey
}
export interface CreateStake {
  pool: PublicKey
  id: BN
  position: PublicKey
  incentive: PublicKey
  owner: PublicKey
  signer?: PublicKey
  index: number
  invariant: PublicKey
}
export interface Stake {
  incentive: PublicKey
  position: PublicKey
  secondsPerLiquidityInitial: Decimal
  liquidity: Decimal
  bump: number
}
export interface Withdraw {
  incentive: PublicKey
  pool: PublicKey
  id: BN
  incentiveTokenAccount: PublicKey
  ownerTokenAcc: PublicKey
  position: PublicKey
  owner: PublicKey
  index: number
}

export interface EndIncentive {
  incentive: PublicKey
  incentiveToken: PublicKey
  incentiveTokenAccount: PublicKey
  founderTokenAccount: PublicKey
  founder: PublicKey
}

export interface CloseStake {
  pool: PublicKey
  id: BN
  incentive: PublicKey
  position: PublicKey
  owner: PublicKey
  index: number
}

export interface IncentiveStructure {
  founder: PublicKey
  tokenAccount: PublicKey
  totalRewardUnclaimed: Decimal
  totalSecondsClaimed: Decimal
  startTime: Decimal
  endTime: Decimal
  endClaimTime: Decimal
  numOfStakes: BN
  pool: PublicKey
  nonce: number
}

export interface Incentive extends IncentiveStructure {
  publicKey: PublicKey
}

export interface Decimal {
  v: BN
}

export interface Init {
  nonce: number
  stakerAuthority: PublicKey
}
