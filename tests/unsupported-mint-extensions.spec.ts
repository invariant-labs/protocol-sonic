import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import {
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction
} from '@solana/web3.js'
import { assertThrowsAsync, createMintWithTransferFee } from './testUtils'
import { Market, Pair, Network, calculatePriceSqrt } from '@invariant-labs/sdk'
import { FeeTier } from '@invariant-labs/sdk/lib/market'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeDefaultAccountStateInstruction,
  createInitializeInterestBearingMintInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializeMintInstruction,
  createInitializeNonTransferableMintInstruction,
  createInitializePermanentDelegateInstruction,
  createMint,
  getMintLen
} from '@solana/spl-token'
import { INVARIANT_ERRORS } from '@invariant-labs/sdk'

describe('unsupported-mint-extension', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 10
  }
  const initTick = 0
  const initSqrtPrice = calculatePriceSqrt(initTick)
  const decimals = 6
  let market: Market

  before(async () => {
    market = Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    // Request airdrops
    await Promise.all([
      connection
        .requestAirdrop(mintAuthority.publicKey, 1e9)
        .then(signature => connection.confirmTransaction(signature)),
      connection
        .requestAirdrop(admin.publicKey, 1e9)
        .then(signature => connection.confirmTransaction(signature))
    ])
  })
  it('#initMarket', async () => {
    await market.createState(admin.publicKey, admin)
    await market.createFeeTier(
      {
        feeTier,
        admin: admin.publicKey
      },
      admin
    )
  })
  describe('create pool with init sqrt price', async () => {
    it('cannot create a pool for a token with fee', async () => {
      const tokens: Keypair[] = new Array(3)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [tokenX, tokenY, tokenZ] = tokens

      const feeBasisPoints = 100 // 1%
      const maxFee = BigInt(5000)

      await Promise.all([
        createMintWithTransferFee(
          connection,
          wallet,
          mintAuthority,
          tokenX,
          decimals,
          feeBasisPoints,
          maxFee
        ),
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          tokenY,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithTransferFee(
          connection,
          wallet,
          mintAuthority,
          tokenZ,
          decimals,
          feeBasisPoints,
          maxFee
        )
      ])

      const pairXY = new Pair(tokenX.publicKey, tokenY.publicKey, feeTier)
      const pairYZ = new Pair(tokenY.publicKey, tokenZ.publicKey, feeTier)

      // cannot create a pool when token x has a fee
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairXY,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
      // cannot create a pool when token y has a fee
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairYZ,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
    })

    it('cannot create a pool for a token with other unsupported extensions', async () => {
      const tokens: Keypair[] = new Array(5)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [
        token,
        tokenClose,
        tokenNonTransfer,
        tokenPermanentDelegate,
        tokenDefaultAccountState
      ] = tokens

      await Promise.all([
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          token,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithCloseAuthority(connection, wallet, mintAuthority, tokenClose, decimals),
        createMintWithNonTransferable(
          connection,
          wallet,
          mintAuthority,
          tokenNonTransfer,
          decimals
        ),
        createMintWithPermanentDelegate(
          connection,
          wallet,
          mintAuthority,
          tokenPermanentDelegate,
          decimals
        ),
        createMintWithDefaultAccountState(
          connection,
          wallet,
          mintAuthority,
          tokenDefaultAccountState,
          decimals
        )
      ])

      const pairClose = new Pair(token.publicKey, tokenClose.publicKey, feeTier)
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairClose,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairNonTransfer = new Pair(token.publicKey, tokenNonTransfer.publicKey, feeTier)
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairNonTransfer,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairPermanentDelegate = new Pair(
        token.publicKey,
        tokenPermanentDelegate.publicKey,
        feeTier
      )
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairPermanentDelegate,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairDefaultAccountState = new Pair(
        token.publicKey,
        tokenDefaultAccountState.publicKey,
        feeTier
      )
      await assertThrowsAsync(
        market.createPoolWithSqrtPrice({
          pair: pairDefaultAccountState,
          payer: admin,
          initSqrtPrice
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
    })

    it('can create a pool for a token with interest bearing extension', async () => {
      const tokens: Keypair[] = new Array(2)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [token, tokenInterestBearing] = tokens

      await Promise.all([
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          token,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithInterestBearing(
          connection,
          wallet,
          mintAuthority,
          tokenInterestBearing,
          decimals
        )
      ])

      const pairInterestBearing = new Pair(token.publicKey, tokenInterestBearing.publicKey, feeTier)

      await market.createPoolWithSqrtPrice({
        pair: pairInterestBearing,
        payer: admin,
        initSqrtPrice
      })
    })
  })
  describe('create pool with init tick', async () => {
    it('cannot create a pool for a token with fee', async () => {
      const tokens: Keypair[] = new Array(3)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [tokenX, tokenY, tokenZ] = tokens

      const feeBasisPoints = 100 // 1%
      const maxFee = BigInt(5000)

      await Promise.all([
        createMintWithTransferFee(
          connection,
          wallet,
          mintAuthority,
          tokenX,
          decimals,
          feeBasisPoints,
          maxFee
        ),
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          tokenY,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithTransferFee(
          connection,
          wallet,
          mintAuthority,
          tokenZ,
          decimals,
          feeBasisPoints,
          maxFee
        )
      ])

      const pairXY = new Pair(tokenX.publicKey, tokenY.publicKey, feeTier)
      const pairYZ = new Pair(tokenY.publicKey, tokenZ.publicKey, feeTier)

      // cannot create a pool when token x has a fee
      await assertThrowsAsync(
        market.createPool({
          pair: pairXY,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
      // cannot create a pool when token y has a fee
      await assertThrowsAsync(
        market.createPool({
          pair: pairYZ,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
    })

    it('cannot create a pool for a token with other unsupported extensions', async () => {
      const tokens: Keypair[] = new Array(5)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [
        token,
        tokenClose,
        tokenNonTransfer,
        tokenPermanentDelegate,
        tokenDefaultAccountState
      ] = tokens

      await Promise.all([
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          token,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithCloseAuthority(connection, wallet, mintAuthority, tokenClose, decimals),
        createMintWithNonTransferable(
          connection,
          wallet,
          mintAuthority,
          tokenNonTransfer,
          decimals
        ),
        createMintWithPermanentDelegate(
          connection,
          wallet,
          mintAuthority,
          tokenPermanentDelegate,
          decimals
        ),
        createMintWithDefaultAccountState(
          connection,
          wallet,
          mintAuthority,
          tokenDefaultAccountState,
          decimals
        )
      ])

      const pairClose = new Pair(token.publicKey, tokenClose.publicKey, feeTier)
      await assertThrowsAsync(
        market.createPool({
          pair: pairClose,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairNonTransfer = new Pair(token.publicKey, tokenNonTransfer.publicKey, feeTier)
      await assertThrowsAsync(
        market.createPool({
          pair: pairNonTransfer,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairPermanentDelegate = new Pair(
        token.publicKey,
        tokenPermanentDelegate.publicKey,
        feeTier
      )
      await assertThrowsAsync(
        market.createPool({
          pair: pairPermanentDelegate,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )

      const pairDefaultAccountState = new Pair(
        token.publicKey,
        tokenDefaultAccountState.publicKey,
        feeTier
      )
      await assertThrowsAsync(
        market.createPool({
          pair: pairDefaultAccountState,
          payer: admin,
          initTick
        }),
        INVARIANT_ERRORS.UNSUPPORTED_EXTENSION
      )
    })

    it('can create a pool for a token with interest bearing extension', async () => {
      const tokens: Keypair[] = new Array(2)
        .fill(0)
        .map(() => Keypair.generate())
        .sort((a, b) => (a.publicKey.toString() < b.publicKey.toString() ? -1 : 1))
      const [token, tokenInterestBearing] = tokens

      await Promise.all([
        createMint(
          connection,
          wallet,
          mintAuthority.publicKey,
          null,
          decimals,
          token,
          undefined,
          TOKEN_2022_PROGRAM_ID
        ),
        createMintWithInterestBearing(
          connection,
          wallet,
          mintAuthority,
          tokenInterestBearing,
          decimals
        )
      ])

      const pairInterestBearing = new Pair(token.publicKey, tokenInterestBearing.publicKey, feeTier)

      await market.createPool({
        pair: pairInterestBearing,
        payer: admin,
        initTick
      })
    })
  })
})

const createMintWithCloseAuthority = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number
) => {
  const extensions = [ExtensionType.MintCloseAuthority]
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
    createInitializeMintCloseAuthorityInstruction(
      mintKeypair.publicKey, // Mint Account address
      mintAuthority.publicKey, // Designated Close Authority
      TOKEN_2022_PROGRAM_ID // Token Extension Program ID
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

const createMintWithNonTransferable = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number
) => {
  const extensions = [ExtensionType.NonTransferable]
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
    createInitializeNonTransferableMintInstruction(
      mintKeypair.publicKey, // Mint Account address
      TOKEN_2022_PROGRAM_ID // Token Extension Program ID
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

const createMintWithInterestBearing = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number
) => {
  const extensions = [ExtensionType.InterestBearingConfig]
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
    createInitializeInterestBearingMintInstruction(
      mintKeypair.publicKey, // Mint Account address
      mintAuthority.publicKey, // Designated Rate Authority
      32_767, // Interest rate basis points
      TOKEN_2022_PROGRAM_ID // Token Extension Program ID
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

const createMintWithPermanentDelegate = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number
) => {
  const extensions = [ExtensionType.PermanentDelegate]
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
    createInitializePermanentDelegateInstruction(
      mintKeypair.publicKey, // Mint Account address
      mintAuthority.publicKey, // Designated Permanent Delegate
      TOKEN_2022_PROGRAM_ID // Token Extension Program ID
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

const createMintWithDefaultAccountState = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  mintKeypair: Keypair,
  decimals: number
) => {
  const extensions = [ExtensionType.DefaultAccountState]
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
    createInitializeDefaultAccountStateInstruction(
      mintKeypair.publicKey, // Mint Account address
      AccountState.Frozen, // Default AccountState
      TOKEN_2022_PROGRAM_ID // Token Extension Program ID
    ),
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthority.publicKey,
      mintAuthority.publicKey,
      TOKEN_2022_PROGRAM_ID
    )
  )

  const signature = await sendAndConfirmTransaction(connection, mintTransaction, [
    payer,
    mintKeypair
  ])

  return signature
}
