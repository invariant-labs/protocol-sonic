import { Market, calculatePriceSqrt, Pair, Network, sleep, fromInteger } from '@invariant-labs/sdk'
import {
  CreateFeeTier,
  CreateTick,
  FeeTier,
  CreatePosition,
  RemovePosition,
  TransferPositionOwnership
} from '@invariant-labs/sdk/lib/market'
import { fromFee, ERRORS } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import {
  createToken,
  assertThrowsAsync,
  eqDecimal,
  positionEquals,
  positionWithoutOwnerEquals
} from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { CreatePool } from '@invariant-labs/sdk/src/market'
import { signAndSend } from '@invariant-labs/sdk'

describe('Position list', () => {
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
  let xOwnerAmount: BN
  let yOwnerAmount: BN
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey

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
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
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

      ticksIndexes = [-9780, -42, 0, 9, 276, 32343, -50001]
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
  describe('#RemovePosition()', () => {
    it('Remove from empty list should failed', async () => {
      const removePositionVars: RemovePosition = {
        index: 0,
        pair,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        owner: positionOwner.publicKey
      }
      await assertThrowsAsync(market.removePosition(removePositionVars, positionOwner))
    })
    it('Add multiple position', async () => {
      xOwnerAmount = 1e10 as any
      yOwnerAmount = 1e10 as any

      await mintTo(
        connection,
        mintAuthority,
        pair.tokenX,
        userTokenXAccount,
        mintAuthority,
        xOwnerAmount as any
      )
      await mintTo(
        connection,
        mintAuthority,
        pair.tokenY,
        userTokenYAccount,
        mintAuthority,
        yOwnerAmount as any
      )

      const initPositionVars: CreatePosition = {
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

      // create position with the same tick should pass
      await market.createPosition(initPositionVars, positionOwner)

      const initPositionVars2: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[2],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars2, positionOwner)

      const initPositionVars3: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[4],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars3, positionOwner)
    })
    it('Remove middle position', async () => {
      const positionIndexToRemove = 2
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)
      const positionsBefore = await market.getPositionsFromRange(
        positionOwner.publicKey,
        0,
        positionListBefore.head - 1
      )
      const lastPosition = positionsBefore[positionListBefore.head - 1]

      const removePositionVars: RemovePosition = {
        pair,
        owner: positionOwner.publicKey,
        index: positionIndexToRemove,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      }
      await market.removePosition(removePositionVars, positionOwner)

      const positionListAfter = await market.getPositionList(positionOwner.publicKey)
      const positionsAfter = await market.getPositionsFromRange(
        positionOwner.publicKey,
        0,
        positionListAfter.head - 1
      )

      // check position list head
      assert.ok(positionListBefore.head - 1 === positionListAfter.head)

      // last position should be at removed index
      const testedPosition = positionsAfter[positionIndexToRemove]
      assert.ok(lastPosition.pool.equals(testedPosition.pool))
      assert.ok(lastPosition.id.eq(testedPosition.id))
      assert.ok(lastPosition.liquidity.eq(testedPosition.liquidity))
      assert.ok(lastPosition.lowerTickIndex === testedPosition.lowerTickIndex)
      assert.ok(lastPosition.upperTickIndex === testedPosition.upperTickIndex)
      assert.ok(lastPosition.feeGrowthInsideX.eq(testedPosition.feeGrowthInsideX))
      assert.ok(lastPosition.feeGrowthInsideY.eq(testedPosition.feeGrowthInsideY))
      assert.ok(lastPosition.tokensOwedX.eq(testedPosition.tokensOwedX))
      assert.ok(lastPosition.tokensOwedY.eq(testedPosition.tokensOwedY))
    })
    it('Add position in place of the removed one', async () => {
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)

      const createTickVars: CreateTick = {
        pair,
        index: ticksIndexes[2],
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)

      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[2],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars, positionOwner)
      const positionListAfter = await market.getPositionList(positionOwner.publicKey)

      assert.equal(positionListBefore.head + 1, positionListAfter.head)
    })
    it('Remove last position', async () => {
      const lastPositionIndexBefore =
        (await market.getPositionList(positionOwner.publicKey)).head - 1

      const removePositionVars: RemovePosition = {
        pair,
        owner: positionOwner.publicKey,
        index: lastPositionIndexBefore,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      }
      await market.removePosition(removePositionVars, positionOwner)

      const lastPositionIndexAfter =
        (await market.getPositionList(positionOwner.publicKey)).head - 1
      assert.equal(lastPositionIndexBefore - 1, lastPositionIndexAfter)
    })
    it('Only owner can modify position list', async () => {
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)
      const initPositionVars: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[0],
        upperTick: ticksIndexes[3],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      const removePositionVars: RemovePosition = {
        pair,
        owner: positionOwner.publicKey,
        index: 0,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount
      }

      await assertThrowsAsync(market.createPosition(initPositionVars, wallet), ERRORS.SIGNATURE)
      await assertThrowsAsync(market.removePosition(removePositionVars, wallet), ERRORS.SIGNATURE)

      const positionListAfter = await market.getPositionList(positionOwner.publicKey)
      assert.equal(positionListBefore.head, positionListAfter.head)
    })
    it('Remove all positions', async () => {
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)

      for (let i = positionListBefore.head - 1; i >= 0; i--) {
        const removePositionVars: RemovePosition = {
          pair,
          owner: positionOwner.publicKey,
          index: i,
          userTokenX: userTokenXAccount,
          userTokenY: userTokenYAccount
        }
        await market.removePosition(removePositionVars, positionOwner)
      }
      const positionListAfter = await market.getPositionList(positionOwner.publicKey)
      assert.equal(positionListAfter.head, 0)
    })
    it('Add position to cleared list', async () => {
      const positionListBefore = await market.getPositionList(positionOwner.publicKey)

      const createTickVars: CreateTick = {
        pair,
        index: ticksIndexes[0],
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)

      const createTickVars2: CreateTick = {
        pair,
        index: ticksIndexes[1],
        payer: admin.publicKey
      }
      await market.createTick(createTickVars2, admin)

      const initPositionVars: CreatePosition = {
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

      const positionListAfter = await market.getPositionList(positionOwner.publicKey)
      assert.equal(positionListBefore.head + 1, positionListAfter.head)
    })
  })
  describe('#TransferPositionOwnership', () => {
    const positionRecipient = Keypair.generate()
    before(async () => {
      // prepare recipient
      await connection.requestAirdrop(positionRecipient.publicKey, 1e9)
      await sleep(2000)
      await market.createPositionList(positionRecipient.publicKey, positionRecipient)

      const createTickVars: CreateTick = {
        pair,
        index: ticksIndexes[2],
        payer: admin.publicKey
      }
      await market.createTick(createTickVars, admin)
      // init positions
      const initPositionVars: CreatePosition = {
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

      const initPositionVars2: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[2],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars2, positionOwner)

      const initPositionVars3: CreatePosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick: ticksIndexes[1],
        upperTick: ticksIndexes[3],
        liquidityDelta: fromInteger(1),
        knownPrice: calculatePriceSqrt(initTick),
        slippage: new BN(0)
      }
      await market.createPosition(initPositionVars3, positionOwner)
    })
    it('only owner can transfer position', async () => {
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)

      const transferPositionOwnershipVars: TransferPositionOwnership = {
        index: 0,
        owner: positionOwner.publicKey,
        recipient: positionRecipient.publicKey
      }
      await assertThrowsAsync(
        market.transferPositionOwnership(transferPositionOwnershipVars, positionRecipient),
        ERRORS.SIGNATURE
      )

      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      assert.equal(ownerListBefore.head, ownerListAfter.head)
      assert.equal(recipientListBefore.head, recipientListAfter.head)
    })
    it('transfer first position - using separate transfer payer', async () => {
      const transferredIndex = 0
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)
      const removedPosition = await market.getPosition(positionOwner.publicKey, transferredIndex)
      const lastPositionBefore = await market.getPosition(
        positionOwner.publicKey,
        ownerListBefore.head - 1
      )

      {
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

        await signAndSend(tx, [transferPositionPayer, positionOwner], connection)
      }

      const recipientPosition = await market.getPosition(positionRecipient.publicKey, 0)
      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      const firstPositionAfter = await market.getPosition(positionOwner.publicKey, transferredIndex)

      // move last position
      assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
      assert.ok(recipientPosition.owner.equals(positionRecipient.publicKey))

      // positions length
      assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
      assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
    })
    it('transfer middle position', async () => {
      const transferredIndex = 1 // middle index
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)
      const removedPosition = await market.getPosition(positionOwner.publicKey, transferredIndex)
      const lastPositionBefore = await market.getPosition(
        positionOwner.publicKey,
        ownerListBefore.head - 1
      )

      const transferPositionOwnershipVars: TransferPositionOwnership = {
        index: transferredIndex,
        owner: positionOwner.publicKey,
        recipient: positionRecipient.publicKey
      }
      await market.transferPositionOwnership(transferPositionOwnershipVars, positionOwner)

      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      const recipientPosition = await market.getPosition(
        positionRecipient.publicKey,
        recipientListAfter.head - 1
      )
      const middlePositionAfter = await market.getPosition(
        positionOwner.publicKey,
        transferredIndex
      )

      // move last position
      assert.ok(positionEquals(lastPositionBefore, middlePositionAfter))

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
      assert.ok(recipientPosition.owner.equals(positionRecipient.publicKey))

      // positions length
      assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
      assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
    })
    it('transfer last position', async () => {
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const transferredIndex = ownerListBefore.head - 1
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)
      const removedPosition = await market.getPosition(positionOwner.publicKey, transferredIndex)

      const transferPositionOwnershipVars: TransferPositionOwnership = {
        index: transferredIndex,
        owner: positionOwner.publicKey,
        recipient: positionRecipient.publicKey
      }
      await market.transferPositionOwnership(transferPositionOwnershipVars, positionOwner)

      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      const recipientPosition = await market.getPosition(
        positionRecipient.publicKey,
        recipientListAfter.head - 1
      )

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
      assert.ok(recipientPosition.owner.equals(positionRecipient.publicKey))

      // positions length
      assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
      assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
    })
    it('clear position', async () => {
      const transferredIndex = 0
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)
      const removedPosition = await market.getPosition(positionOwner.publicKey, transferredIndex)

      const transferPositionOwnershipVars: TransferPositionOwnership = {
        index: transferredIndex,
        owner: positionOwner.publicKey,
        recipient: positionRecipient.publicKey
      }
      await market.transferPositionOwnership(transferPositionOwnershipVars, positionOwner)

      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      const recipientPosition = await market.getPosition(
        positionRecipient.publicKey,
        recipientListAfter.head - 1
      )

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
      assert.ok(recipientPosition.owner.equals(positionRecipient.publicKey))

      // positions length
      assert.equal(ownerListAfter.head, 0)
      assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
    })
    it('get back position', async () => {
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const transferredIndex = 0
      const recipientListBefore = await market.getPositionList(positionRecipient.publicKey)
      const lastPositionBefore = await market.getPosition(
        positionRecipient.publicKey,
        recipientListBefore.head - 1
      )
      const removedPosition = await market.getPosition(
        positionRecipient.publicKey,
        transferredIndex
      )

      const transferPositionOwnershipVars: TransferPositionOwnership = {
        index: transferredIndex,
        owner: positionRecipient.publicKey,
        recipient: positionOwner.publicKey
      }
      await market.transferPositionOwnership(transferPositionOwnershipVars, positionRecipient)

      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(positionRecipient.publicKey)
      const firstPositionAfter = await market.getPosition(positionRecipient.publicKey, 0)
      const ownerNewPosition = await market.getPosition(
        positionOwner.publicKey,
        ownerListAfter.head - 1
      )

      // move last position
      assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, ownerNewPosition))
      assert.ok(ownerNewPosition.owner.equals(positionOwner.publicKey))

      // positions length
      assert.equal(ownerListBefore.head + 1, ownerListAfter.head)
      assert.equal(recipientListBefore.head - 1, recipientListAfter.head)
    })
  })
})
