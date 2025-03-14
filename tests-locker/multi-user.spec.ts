import { Market, calculatePriceSqrt, Pair, Network } from '@invariant-labs/sdk'
import { CreateFeeTier, CreateTick, FeeTier } from '@invariant-labs/sdk/lib/market'
import { fromFee } from '@invariant-labs/sdk/lib/utils'
import * as anchor from '@coral-xyz/anchor'
import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { Network as LockerNetwork } from '@invariant-labs/locker-sonic-sdk'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { assert } from 'chai'
import { assertThrowsAsync, createPosition, createToken } from './testUtils'
import { createAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { CreatePool } from '@invariant-labs/sdk/src/market'
import { Locker } from '@invariant-labs/locker-sonic-sdk'
import { ILockPosition, IUnlockPosition } from '@invariant-labs/locker-sonic-sdk/lib/locker'
import { positionEquals, positionWithoutOwnerEquals } from '../tests/testUtils'
import { sleep } from '@invariant-labs/sdk'
import { signAndSend } from '@invariant-labs/locker-sonic-sdk'

describe('Multi user', () => {
  const provider = AnchorProvider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const mintAuthority = Keypair.generate()

  const firstOwner = Keypair.generate()
  const secondOwner = Keypair.generate()

  const admin = Keypair.generate()
  const feeTier: FeeTier = {
    fee: fromFee(new BN(600)),
    tickSpacing: 3
  }

  const singleLockDuration = new BN(5) // 5 seconds
  let market: Market
  let locker: Locker
  let pair: Pair
  let initTick: number
  let ticksIndexes: number[]
  let firstOwnerX: PublicKey
  let firstOwnerY: PublicKey
  let secondOwnerX: PublicKey
  let secondOwnerY: PublicKey

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
      connection.requestAirdrop(firstOwner.publicKey, 1e9),
      connection.requestAirdrop(secondOwner.publicKey, 1e9)
    ])
    // Create pair
    const tokens = await Promise.all([
      createToken(connection, wallet, mintAuthority),
      createToken(connection, wallet, mintAuthority)
    ])
    pair = new Pair(tokens[0], tokens[1], feeTier)

    // user deposit
    firstOwnerX = await createAssociatedTokenAccount(
      connection,
      firstOwner,
      pair.tokenX,
      firstOwner.publicKey
    )
    firstOwnerY = await createAssociatedTokenAccount(
      connection,
      firstOwner,
      pair.tokenY,
      firstOwner.publicKey
    )
    secondOwnerX = await createAssociatedTokenAccount(
      connection,
      secondOwner,
      pair.tokenX,
      secondOwner.publicKey
    )
    secondOwnerY = await createAssociatedTokenAccount(
      connection,
      secondOwner,
      pair.tokenY,
      secondOwner.publicKey
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
    await market.createPositionList(firstOwner.publicKey, firstOwner)
    await market.createPositionList(secondOwner.publicKey, secondOwner)

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
    await mintTo(connection, mintAuthority, pair.tokenX, firstOwnerX, mintAuthority, 1e10)
    await mintTo(connection, mintAuthority, pair.tokenY, firstOwnerY, mintAuthority, 1e10)
    await mintTo(connection, mintAuthority, pair.tokenX, secondOwnerX, mintAuthority, 1e10)
    await mintTo(connection, mintAuthority, pair.tokenY, secondOwnerY, mintAuthority, 1e10)

    const createPositionsVars = [
      {
        owner: firstOwner,
        accountX: firstOwnerX,
        accountY: firstOwnerY
      },
      {
        owner: secondOwner,
        accountX: secondOwnerX,
        accountY: secondOwnerY
      }
    ]

    for (const { owner, accountX, accountY } of createPositionsVars) {
      await createPosition(
        market,
        pair,
        owner,
        accountX,
        accountY,
        ticksIndexes[0],
        ticksIndexes[1]
      )
      await createPosition(
        market,
        pair,
        owner,
        accountX,
        accountY,
        ticksIndexes[0],
        ticksIndexes[1]
      )
      await createPosition(
        market,
        pair,
        owner,
        accountX,
        accountY,
        ticksIndexes[1],
        ticksIndexes[2]
      )
      await createPosition(
        market,
        pair,
        owner,
        accountX,
        accountY,
        ticksIndexes[2],
        ticksIndexes[3]
      )
    }
  })

  it('first owner locks his middle position with id = 1', async () => {
    const lockIndex = 1
    const ownerListBefore = await market.getPositionList(firstOwner.publicKey)
    const [lockerAuthority] = locker.getUserLocksAddress(firstOwner.publicKey)
    const removedPosition = await market.getPosition(firstOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      firstOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: firstOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 0)
    const ownerListAfter = await market.getPositionList(firstOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(firstOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(firstOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 1)
    assert.ok(ownerLocks.positions[0].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[0].positionId.eqn(1))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(1, recipientListAfter.head)
  })
  it('second owner lock his middle position with id = 5', async () => {
    const lockIndex = 1
    const ownerListBefore = await market.getPositionList(secondOwner.publicKey)
    const [lockerAuthority] = locker.getUserLocksAddress(secondOwner.publicKey)
    const removedPosition = await market.getPosition(secondOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      secondOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: secondOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 0)
    const ownerListAfter = await market.getPositionList(secondOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(secondOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(secondOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 1)
    assert.ok(ownerLocks.positions[0].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[0].positionId.eqn(5))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(1, recipientListAfter.head)
  })
  it('second owner lock his first position with id = 4', async () => {
    const lockIndex = 0
    const [lockerAuthority] = locker.getUserLocksAddress(secondOwner.publicKey)
    const ownerListBefore = await market.getPositionList(secondOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(secondOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      secondOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: secondOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 1)
    const ownerListAfter = await market.getPositionList(secondOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(secondOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(secondOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 2)
    assert.ok(ownerLocks.positions[1].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[1].positionId.eqn(4))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('first owner lock his last position with id = 2', async () => {
    const lockIndex = 2
    const [lockerAuthority] = locker.getUserLocksAddress(firstOwner.publicKey)
    const ownerListBefore = await market.getPositionList(firstOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(firstOwner.publicKey, lockIndex)

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: firstOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 1)
    const ownerListAfter = await market.getPositionList(firstOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const ownerLocks = await locker.getUserLocks(firstOwner.publicKey)

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 2)
    assert.ok(ownerLocks.positions[1].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[1].positionId.eqn(2))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('first owner lock his first position with id = 0', async () => {
    const lockIndex = 0
    const [lockerAuthority] = locker.getUserLocksAddress(firstOwner.publicKey)
    const ownerListBefore = await market.getPositionList(firstOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(firstOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      firstOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: firstOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 2)
    const ownerListAfter = await market.getPositionList(firstOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(firstOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(firstOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 3)
    assert.ok(ownerLocks.positions[2].positionId.eq(removedPosition.id))

    assert.ok(ownerLocks.positions[2].positionId.eqn(0))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('first owner lock his first position with id = 3', async () => {
    const lockIndex = 0
    const [lockerAuthority] = locker.getUserLocksAddress(firstOwner.publicKey)
    const ownerListBefore = await market.getPositionList(firstOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(firstOwner.publicKey, lockIndex)

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: firstOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 3)
    const ownerListAfter = await market.getPositionList(firstOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)

    const ownerLocks = await locker.getUserLocks(firstOwner.publicKey)

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 4)
    assert.ok(ownerLocks.positions[3].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[3].positionId.eqn(3))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('second owner lock his first position with id = 6', async () => {
    const lockIndex = 0
    const [lockerAuthority] = locker.getUserLocksAddress(secondOwner.publicKey)
    const ownerListBefore = await market.getPositionList(secondOwner.publicKey)
    const recipientListBefore = await market.getPositionList(lockerAuthority)
    const removedPosition = await market.getPosition(secondOwner.publicKey, lockIndex)
    const lastPositionBefore = await market.getPosition(
      secondOwner.publicKey,
      ownerListBefore.head - 1
    )

    const lockPositionVars: ILockPosition = {
      index: lockIndex,
      market,
      lockDuration: singleLockDuration,
      payer: secondOwner
    }

    await locker.lockPosition(lockPositionVars)

    const recipientPosition = await market.getPosition(lockerAuthority, 2)
    const ownerListAfter = await market.getPositionList(secondOwner.publicKey)
    const recipientListAfter = await market.getPositionList(lockerAuthority)
    const firstPositionAfter = await market.getPosition(secondOwner.publicKey, lockIndex)
    const ownerLocks = await locker.getUserLocks(secondOwner.publicKey)

    // move last position
    assert.ok(positionEquals(lastPositionBefore, firstPositionAfter))

    // equals fields of transferred position
    assert.ok(positionWithoutOwnerEquals(removedPosition, recipientPosition))
    assert.ok(recipientPosition.owner.equals(lockerAuthority))

    // check owner locks
    assert.equal(ownerLocks.positions.length, 3)
    assert.ok(ownerLocks.positions[2].positionId.eq(removedPosition.id))
    assert.ok(ownerLocks.positions[2].positionId.eqn(6))

    // positions length
    assert.equal(ownerListBefore.head - 1, ownerListAfter.head)
    assert.equal(recipientListBefore.head + 1, recipientListAfter.head)
  })
  it('Validate locks', async () => {
    // First owner opened 4 positions with ids 0, 1, 2, 3
    // Second owner opened 4 positions with ids 4, 5, 6, 7
    // First owner locked 4 positions in order: 1, 2, 0, 3 the list order after each lock: ([0,3,2], [0,3], [3], [])
    // Second owner locked 3 position in order: 1, 5, 4 the list order after each lock: ([4,7,6], [6,7], [7])
    const expectedFirstOwnerLocks = [1, 2, 0, 3]
    const expectedSecondOwnerLocks = [5, 4, 6]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('Ensure all locks expire', async () => {
    await sleep(singleLockDuration.muln(1000).toNumber())
  })
  it('Unlock second lock with id 2 by first owner', async () => {
    const authorityListIndex = 1

    const withdrawParams: IUnlockPosition = {
      payer: firstOwner,
      market,
      authorityListIndex
    }

    await locker.unlockPosition(withdrawParams)

    const expectedFirstOwnerLocks = [1, 0, 3]
    const expectedSecondOwnerLocks = [5, 4, 6]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('Unlock first lock with id 1 by first owner', async () => {
    const authorityListIndex = 0

    const withdrawParams: IUnlockPosition = {
      payer: firstOwner,
      market,
      authorityListIndex
    }

    await locker.unlockPosition(withdrawParams)

    const expectedFirstOwnerLocks = [0, 3]
    const expectedSecondOwnerLocks = [5, 4, 6]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('Unlock last lock with id 6 by second owner', async () => {
    const authorityListIndex = 2

    const withdrawParams: IUnlockPosition = {
      payer: secondOwner,
      market,
      authorityListIndex
    }

    await locker.unlockPosition(withdrawParams)

    const expectedFirstOwnerLocks = [0, 3]
    const expectedSecondOwnerLocks = [5, 4]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('Unlock last lock with id 5 by second owner', async () => {
    const authorityListIndex = 0

    const withdrawParams: IUnlockPosition = {
      payer: secondOwner,
      market,
      authorityListIndex
    }

    await locker.unlockPosition(withdrawParams)

    const expectedFirstOwnerLocks = [0, 3]
    const expectedSecondOwnerLocks = [4]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('try to unlock someone else lock - should fail', async () => {
    const authorityListIndex = 1

    const withdrawParams: IUnlockPosition = {
      payer: secondOwner,
      market,
      authorityListIndex
    }

    const ix = await locker.unlockPositionIx(withdrawParams, firstOwner.publicKey)

    await assertThrowsAsync(
      signAndSend(new Transaction().add(...ix), [secondOwner], connection),
      'Signature verification failed.'
    )

    const expectedFirstOwnerLocks = [0, 3]
    const expectedSecondOwnerLocks = [4]

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
  it('Unlock all remaining locks by first owner', async () => {
    {
      const authorityListIndex = 0

      const withdrawParams: IUnlockPosition = {
        payer: firstOwner,
        market,
        authorityListIndex
      }

      await locker.unlockPosition(withdrawParams)

      const expectedFirstOwnerLocks = [3]
      const expectedSecondOwnerLocks = [4]

      await validateLocksState(
        locker,
        market,
        firstOwner.publicKey,
        secondOwner.publicKey,
        expectedFirstOwnerLocks,
        expectedSecondOwnerLocks
      )
    }
    {
      const authorityListIndex = 0

      const withdrawParams: IUnlockPosition = {
        payer: firstOwner,
        market,
        authorityListIndex
      }

      await locker.unlockPosition(withdrawParams)

      const expectedFirstOwnerLocks = []
      const expectedSecondOwnerLocks = [4]

      await validateLocksState(
        locker,
        market,
        firstOwner.publicKey,
        secondOwner.publicKey,
        expectedFirstOwnerLocks,
        expectedSecondOwnerLocks
      )
    }
  })
  it('Unlock last lock with id 4 by second owner', async () => {
    const authorityListIndex = 0

    const withdrawParams: IUnlockPosition = {
      payer: secondOwner,
      market,
      authorityListIndex
    }

    await locker.unlockPosition(withdrawParams)

    const expectedFirstOwnerLocks = []
    const expectedSecondOwnerLocks = []

    await validateLocksState(
      locker,
      market,
      firstOwner.publicKey,
      secondOwner.publicKey,
      expectedFirstOwnerLocks,
      expectedSecondOwnerLocks
    )
  })
})

const validateLocksState = async (
  locker: Locker,
  market: Market,
  firstOwner: PublicKey,
  secondOwner: PublicKey,
  expectedFirstOwnerLocks: number[],
  expectedSecondOwnerLocks: number[]
) => {
  const [firstOwnerAuthority] = locker.getUserLocksAddress(firstOwner)
  const [secondOwnerAuthority] = locker.getUserLocksAddress(secondOwner)

  const allPositions = await market.getAllPositions()
  const ownerWithIds = allPositions.map(p => {
    return {
      owner: p.owner,
      positionId: p.id
    }
  })

  const firstOwnerLockedPositions = ownerWithIds.filter(p => p.owner.equals(firstOwnerAuthority))
  const secondOwnerLockedPositions = ownerWithIds.filter(p => p.owner.equals(secondOwnerAuthority))

  for (const { owner, positionId } of firstOwnerLockedPositions) {
    assert.ok(owner.equals(firstOwnerAuthority))
    assert.ok(expectedFirstOwnerLocks.some(id => id === positionId.toNumber()))
  }

  for (const { owner, positionId } of secondOwnerLockedPositions) {
    assert.ok(owner.equals(secondOwnerAuthority))
    assert.ok(expectedSecondOwnerLocks.some(id => id === positionId.toNumber()))
  }

  const firstOwnerLocks = await locker.getUserLocks(firstOwner)
  assert.equal(firstOwnerLocks.positions.length, expectedFirstOwnerLocks.length)

  for (const [index] of expectedFirstOwnerLocks.entries()) {
    assert.ok(
      expectedFirstOwnerLocks.some(
        id => id === firstOwnerLocks.positions[index].positionId.toNumber()
      )
    )
  }

  const secondOwnerLocks = await locker.getUserLocks(secondOwner)
  assert.equal(secondOwnerLocks.positions.length, expectedSecondOwnerLocks.length)

  for (const [index] of expectedSecondOwnerLocks.entries()) {
    assert.ok(
      expectedSecondOwnerLocks.some(
        id => id === secondOwnerLocks.positions[index].positionId.toNumber()
      )
    )
  }
}
