import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionSignature
} from '@solana/web3.js'
import {
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  ExtensionType,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { CreatePosition, Market } from '@invariant-labs/sdk/lib/market'
import { CreateFeeTier, CreatePool, Decimal } from '@invariant-labs/sdk/src/market'
import BN from 'bn.js'
import { Pair, TICK_LIMIT, calculatePriceSqrt } from '@invariant-labs/sdk'
import { assert } from 'chai'
import { Locker } from '@invariant-labs/locker-sonic-sdk'
import { IInitializeUserAuthority } from '@invariant-labs/locker-sonic-sdk/src/locker'
import { fromInteger } from '@invariant-labs/sdk'

export async function assertThrowsAsync(fn: Promise<any>, word?: string) {
  try {
    await fn
  } catch (e: any) {
    let err
    if (e.code) {
      err = '0x' + e.code.toString(16)
    } else {
      err = e.toString()
    }
    if (word) {
      if (!err.includes(word)) {
        throw new Error(`Invalid Error message: ${err as string}`)
      }
    }
    return
  }
  throw new Error('Function did not throw error')
}

export const getTimestampInSeconds = () => {
  return new BN(new Date().getTime() / 1000)
}

export const createToken = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  decimals: number = 6,
  freezeAuthority: PublicKey | null = null,
  isToken2022: boolean = false
): Promise<PublicKey> => {
  const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

  const mint = await createMint(
    connection,
    payer,
    mintAuthority.publicKey,
    freezeAuthority,
    decimals,
    undefined,
    undefined,
    programId
  )

  return mint
}

export const createMintWithTransferFee = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number,
  feeBasisPoints: number,
  maxFee: bigint
): Promise<TransactionSignature> => {
  const extensions = [ExtensionType.TransferFeeConfig]
  const mintLength = getMintLen(extensions)

  const mintLamports = await connection.getMinimumBalanceForRentExemption(mintLength)

  const mintTransaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLength,
      lamports: mintLamports,
      programId: TOKEN_2022_PROGRAM_ID
    }),
    createInitializeTransferFeeConfigInstruction(
      mintKeypair.publicKey,
      mintAuthority.publicKey,
      mintAuthority.publicKey,
      feeBasisPoints,
      maxFee,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthority.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID
    )
  )

  const signature = await sendAndConfirmTransaction(connection, mintTransaction, [
    payer,
    mintKeypair
  ])

  return signature
}

export const initMarket = async (
  market: Market,
  pairs: Pair[],
  admin: Keypair,
  initTick?: number
) => {
  try {
    await market.createState(admin.publicKey, admin)
  } catch (e) {}

  const state = await market.getState()
  const bump = market.stateAddress.bump
  const { address: programAuthority, bump: nonce } = market.programAuthority
  assert.ok(state.admin.equals(admin.publicKey))
  assert.ok(state.authority.equals(programAuthority))
  assert.ok(state.nonce === nonce)
  assert.ok(state.bump === bump)

  for (const pair of pairs) {
    try {
      await market.getFeeTier(pair.feeTier)
    } catch (e) {
      const createFeeTierVars: CreateFeeTier = {
        feeTier: pair.feeTier,
        admin: admin.publicKey
      }
      await market.createFeeTier(createFeeTierVars, admin)
    }

    const createPoolVars: CreatePool = {
      pair,
      payer: admin,
      initTick: initTick
    }
    await market.createPool(createPoolVars)

    const createdPool = await market.getPool(pair)
    assert.ok(createdPool.tokenX.equals(pair.tokenX))
    assert.ok(createdPool.tokenY.equals(pair.tokenY))
    assert.ok(createdPool.fee.eq(pair.feeTier.fee))
    assert.equal(createdPool.tickSpacing, pair.feeTier.tickSpacing)
    assert.ok(createdPool.liquidity.eqn(0))
    assert.ok(createdPool.sqrtPrice.eq(calculatePriceSqrt(initTick ?? 0)))
    assert.ok(createdPool.currentTickIndex === (initTick ?? 0))
    assert.ok(createdPool.feeGrowthGlobalX.eqn(0))
    assert.ok(createdPool.feeGrowthGlobalY.eqn(0))
    assert.ok(createdPool.feeProtocolTokenX.eqn(0))
    assert.ok(createdPool.feeProtocolTokenY.eqn(0))

    const tickmapData = await market.getTickmap(pair)
    assert.ok(tickmapData.bitmap.length === TICK_LIMIT / 4)
    assert.ok(tickmapData.bitmap.every(v => v === 0))
  }
}

export const createPosition = async (
  market: Market,
  pair: Pair,
  owner: Keypair,
  accountX: PublicKey,
  accountY: PublicKey,
  lowerTick: number,
  upperTick: number,
  liquidityDelta: BN = fromInteger(1),
  knownPrice: BN = calculatePriceSqrt(-23028),
  slippage: BN = new BN(0)
) => {
  const initPositionVars: CreatePosition = {
    pair,
    owner: owner.publicKey,
    userTokenX: accountX,
    userTokenY: accountY,
    lowerTick,
    upperTick,
    liquidityDelta,
    knownPrice,
    slippage
  }
  await market.createPosition(initPositionVars, owner)
}
