import { Market, calculatePriceSqrt, Pair, Network, fromInteger } from '@invariant-labs/sdk'
import { CreateFeeTier, CreateTick, FeeTier, CreatePosition } from '@invariant-labs/sdk/lib/market'
import { fromFee, ERRORS } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Network as LockerNetwork } from '@invariant-labs/locker-sonic-sdk'
import { Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import { assertThrowsAsync, createToken } from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { CreatePool } from '@invariant-labs/sdk/src/market'
import { Locker } from '@invariant-labs/locker-sonic-sdk'
import { ILockPosition } from '@invariant-labs/locker-sonic-sdk/lib/locker'
import { getMaxLockDuration } from '@invariant-labs/locker-sonic-sdk'
import { positionEquals, positionWithoutOwnerEquals } from '../tests/testUtils'
import { signAndSend } from '@invariant-labs/locker-sonic-sdk'

describe('Position list', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()
  const positionOwner = Keypair.generate()
  const unauthorizedLocker = Keypair.generate()
  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 3
  }
  let market: Market
  let locker: Locker
  let pair: Pair
  let initTick: number
  let ticksIndexes: number[]
  let userTokenXAccount: PublicKey
  let userTokenYAccount: PublicKey

  before(async () => {
    market = Market.build(
      Network.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Invariant.programId
    )

    locker = Locker.build(
      LockerNetwork.LOCAL,
      provider.wallet,
      connection,
      anchor.workspace.Locker.programId
    )

    // Request airdrops
    await Promise.all([
      connection.requestAirdrop(wallet.publicKey, 1e9),
      connection.requestAirdrop(mintAuthority.publicKey, 1e9),
      connection.requestAirdrop(admin.publicKey, 1e9),
      connection.requestAirdrop(positionOwner.publicKey, 1e9),
      connection.requestAirdrop(unauthorizedLocker.publicKey, 1e9)
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
  it('#init()', async () => {
    initTick = -23028

    const createPoolVars: CreatePool = {
      pair,
      payer: admin,
      initTick
    }
    await market.createPool(createPoolVars)
    await market.createPositionList(positionOwner.publicKey, positionOwner)
    await market.createPositionList(unauthorizedLocker.publicKey, unauthorizedLocker)

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
  it('Create positions', async () => {
    await mintTo(connection, mintAuthority, pair.tokenX, userTokenXAccount, mintAuthority, 1e10)
    await mintTo(connection, mintAuthority, pair.tokenY, userTokenYAccount, mintAuthority, 1e10)

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

  it('lock first position', async () => {
    const lockIndex = 0
    const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
    const [lockerAuthority] = locker.getUserLocksAddress(positionOwner.publicKey)
    // const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(positionOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      positionOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 0)
    const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(positionOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(positionOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 1)
    assert.ok(ownerLocks.positions[0].positionId.eq(removedPosition.id))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(1, recipientListAfter.head)
  })
  it('lock middle position', async () => {
    const lockIndex = 1 // middle index
    const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
    const [lockerAuthority] = locker.getUserLocksAddress(positionOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(positionOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      positionOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

    await locker.lockPosition(lockPositionVars)

    const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const recipientPosition = await market.getPosition(lockerAuthority, recipientListAfter.head - 1)
    const middlePositionAfter = await market.getPosition(positionOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(positionOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, middlePositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 2)
    assert.ok(ownerLocks.positions[1].positionId.eq(removedPosition.id))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('lock last position', async () => {
    const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
    const lockIndex = ownerListBefore.head - 1
    const [lockerAuthority] = locker.getUserLocksAddress(positionOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(positionOwner.publicKey, lockIndex)

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

    await locker.lockPosition(lockPositionVars)

    const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const recipientPosition = await market.getPosition(lockerAuthority, recipientListAfter.head - 1)
    const ownerLocks = await locker.getUserLocks(positionOwner.publicKey)

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 3)
    assert.ok(ownerLocks.positions[2].positionId.eq(removedPosition.id))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('try to lock not owned position', async () => {
    const [authority] = locker.getUserLocksAddress(positionOwner.publicKey)
    const [locks] = locker.getUserLocksAddress(unauthorizedLocker.publicKey)

    const { positionListAddress: authorityList } = market.getPositionListAddress(authority)
    const { positionListAddress: positionList } = market.getPositionListAddress(
      positionOwner.publicKey
    )

    const ownerPositionList = await market.getPositionList(positionOwner.publicKey)

    const ownerListHead = ownerPositionList?.head ?? 0
    const authorityListHead = 0

    const { positionAddress: position } = market.getPositionAddress(positionOwner.publicKey, 0)
    const { positionAddress: lastPosition } = market.getPositionAddress(
      positionOwner.publicKey,
      ownerListHead - 1
    )
    const { positionAddress: transferredPosition } = market.getPositionAddress(
      authority,
      authorityListHead
    )

    const ixs = await locker.initLocksIfNeededIx(unauthorizedLocker.publicKey)
    const lockIx = await locker.program.methods
      .lockPosition(0, getMaxLockDuration())
      .accounts({
        owner: unauthorizedLocker.publicKey,
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

    const tx = new Transaction().add(...ixs).add(lockIx)

    await assertThrowsAsync(signAndSend(tx, [unauthorizedLocker], connection), 'ConstraintSeeds.')
  })
  it('Hit the lock limit', async () => {
    for (let i = 0; i < 7; i++) {
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

      const lockIndex = 0
      const ownerListBefore = await market.getPositionList(positionOwner.publicKey)
      const [lockerAuthority] = locker.getUserLocksAddress(positionOwner.publicKey)
      const recipientListBefore = await market.getPositionList(lockerAuthority)
      const removedPosition = await market.getPosition(positionOwner.publicKey, lockIndex)
      const lastPositionBefore = await market.getPosition(
        positionOwner.publicKey,
        ownerListBefore.head - 1
      )

      const lockPositionVars: ILockPosition = {
        index: lockIndex,
        market,
        lockDuration: getMaxLockDuration(),
        payer: positionOwner
      }

      await locker.lockPosition(lockPositionVars)

      const recipientPosition = await market.getPosition(lockerAuthority, recipientListBefore.head)
      const ownerListAfter = await market.getPositionList(positionOwner.publicKey)
      const recipientListAfter = await market.getPositionList(lockerAuthority)
      const firstPositionAfter = await market.getPosition(positionOwner.publicKey, lockIndex)
      const ownerLocks = await locker.getUserLocks(positionOwner.publicKey)

      // move last position
      assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

      // equals fields of transferred position
      assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
      assert.ok(recipientPosition.owner.equals(lockerAuthority))

      // check owner locks
      const existingLocks = 4
      assert.equal(ownerLocks.positions.length, existingLocks + i)
      assert.ok(ownerLocks.positions[existingLocks + i - 1].positionId.eq(removedPosition.id))

      // positions length
      assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
      assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
    }
  })
  it('Try to lock more than the limit', async () => {
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

    const lockIndex = 0

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: getMaxLockDuration(),
      payer: positionOwner
    }

    await assertThrowsAsync(locker.lockPosition(lockPositionVars), 'ExceededLockLimit.')
  })
})
