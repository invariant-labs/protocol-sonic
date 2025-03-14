import { Market, calculatePriceSqrt, Pair, Network, sleep, fromInteger } from '@invariant-labs/sdk'
import { CreateFeeTier, CreateTick, FeeTier, InitPosition } from '@invariant-labs/sdk/lib/market'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js'

import { assertThrowsAsync, createToken } from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { CreatePool } from '@invariant-labs/sdk/src/market'
import { signAndSend } from '@invariant-labs/sdk'
import { INVARIANT_ERRORS } from '@invariant-labs/sdk'

describe('Disable transfer position', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const transferPositionPayer = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 3
  }
  let market: Market
  let pair: Pair
  let initTick: number
  let ticksIndexes: number[]
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey

  const tokenX = Keypair.fromSecretKey(
    new Uint8Array([
      58, 183, 123, 246, 228, 160, 239, 163, 153, 176, 165, 248, 249, 244, 239, 104, 88, 110, 72,
      229, 223, 232, 130, 142, 242, 113, 243, 151, 53, 37, 160, 123, 246, 79, 222, 251, 68, 47, 98,
      217, 206, 254, 41, 250, 113, 165, 250, 241, 7, 228, 134, 157, 165, 90, 25, 95, 227, 80, 141,
      172, 207, 32, 9, 162
    ])
  )
  const tokenY = Keypair.fromSecretKey(
    new Uint8Array([
      208, 40, 147, 74, 216, 168, 205, 135, 93, 237, 243, 109, 121, 32, 29, 191, 77, 61, 158, 38,
      201, 144, 70, 71, 95, 30, 193, 97, 217, 158, 80, 36, 237, 121, 45, 38, 76, 192, 166, 88, 254,
      95, 135, 145, 106, 134, 174, 147, 189, 202, 57, 157, 48, 78, 234, 191, 167, 243, 55, 99, 93,
      103, 13, 114
    ])
  )

  before(async () => {
    market = await Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    // Request airdrops
    await Promise.all([
      connection.requestAirdrop(wallet.publicKey, 1e9),
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9),
      connection.requestAirdrop(transferPositionPayer.publicKey, 1e9)
    ])
    // Create pair
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority, undefined, undefined, undefined, tokenX),
      createToken(connection, wallet, mintAuthority, undefined, undefined, undefined, tokenY)
    ])
    pair = new Pair(tokens[0], tokens[1], feeTier)

    // user deposit
    userTokenXAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenX,
      positionOwner.publicKey
    )
    userTokenYAccount = await createAssociatedTokenAccount(
      connection,
      positionOwner,
      pair.tokenY,
      positionOwner.publicKey
    )

    await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, 1e10)
    await mintTo(connection, mintAuthority, pair.tokenY, userTokenYAccount, mintAuthority, 1e10)

    await market.createState(admin.publicKey, admin)

    const createFeeTierVars: CreateFeeTier = {
      feeTier,
      admin: admin.publicKey
    }
    await market.createFeeTier(createFeeTierVars, admin)
  })
  describe('Settings', () => {
    it('Prepare pool', async () => {
      initTick = -23028

      const createPoolVars: CreatePool = {
        pair,
        payer: admin,
        initTick
      }
      await market.createPool(createPoolVars)
      await market.createPositionList(positionOwner.publicKey, positionOwner)

      ticksIndexes = [-9780, -42]
      await Promise.all(
        ticksIndexes.map(async tickIndex => {
          const createTickVars: CreateTick = {
            index: tickIndex,
            pair,
            payer: admin.publicKey
          }
          await market.createTick(createTickVars, admin)
        })
      )
    })
  })
  describe('#TransferPositionOwnership', () => {
    const positionRecipient = Keypair.generate()
    before(async () => {
      // prepare recipient
      await connection.requestAirdrop(positionRecipient.publicKey, 1e9)
      await sleep(2000)
      await market.createPositionList(positionRecipient.publicKey, positionRecipient)

      // init positions
      const initPositionVars: InitPosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[1],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars, positionOwner)
    })
    it('Transfer position panics on disabled pool', async () => {
      const transferredIndex = 0

      const owner = positionOwner.publicKey
      const recipient = positionRecipient.publicKey

      const { positionListAddress: ownerList } = market.getPositionListAddress(owner)
      const { positionListAddress: recipientList } = market.getPositionListAddress(recipient)

      const [ownerPositionList, { positionAddress: newPosition }] = await Promise.all([
        market.getPositionList(owner),
        market.getNewPositionAddress(recipient)
      ])
      const { positionAddress: removedPosition } = market.getPositionAddress(
        owner,
        transferredIndex
      )
      const { positionAddress: lastPosition } = market.getPositionAddress(
        owner,
        ownerPositionList.head - 1
      )

      const ix = await market.program.methods
        .transferPositionOwnership(transferredIndex)
        .accounts({
          payer: transferPositionPayer.publicKey,
          owner,
          recipient,
          ownerList,
          recipientList,
          lastPosition,
          removedPosition,
          newPosition,
          rent: SYSVAR_RENT_PUBKEY,
          systemProgram: SystemProgram.programId
        })
        .instruction()

      const tx = new Transaction().add(ix)

      await assertThrowsAsync(
        signAndSend(tx, [transferPositionPayer, positionOwner], connection),
        INVARIANT_ERRORS.DISABLED_POOL
      )
    })
  })
})
