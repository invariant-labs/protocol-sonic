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
  createAssociatedTokenAccount,
  createInitializeMint2Instruction,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createMint,
  ExtensionType,
  getMintLen,
  getTransferFeeAmount,
  mintTo,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
  withdrawWithheldTokensFromAccounts
} from '@solana/spl-token'
import { FeeTier, Market, Position, Tick } from '@invariant-labs/sdk/lib/market'
import {
  CreateFeeTier,
  CreatePool,
  CreateTick,
  Decimal,
  CreatePosition,
  Swap
} from '@invariant-labs/sdk/src/market'
import {
  feeToTickSpacing,
  FEE_TIERS,
  generateTicksArray,
  getTokenProgramAddress
} from '@invariant-labs/sdk/src/utils'
import BN from 'bn.js'
import {
  Pair,
  TICK_LIMIT,
  calculatePriceSqrt,
  LIQUIDITY_DENOMINATOR,
  sleep,
  signAndSend
} from '@invariant-labs/sdk'
import { assert } from 'chai'
import {
  createAndExtendAddressLookupTableTxs,
  fetchLookupTableByPoolAccount,
  fetchLookupTableByPoolAndAdjustedTickIndex,
  generateLookupTableForCommonAccounts,
  generateLookupTableForPool,
  generateLookupTableRangeForTicks,
  getBalance,
  getRealTickFromAdjustedLookupTableStartingTick,
  TICK_COUNT_PER_LOOKUP_TABLE
} from '@invariant-labs/sdk/lib/utils'

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

export const createToken = async (
  connection: Connection,
  payer: Keypair,
  mintAuthority: Keypair,
  decimals: number = 6,
  freezeAuthority: PublicKey | null = null,
  isToken2022: boolean = false,
  keypair?: Keypair
): Promise<PublicKey> => {
  const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID

  const mint = await createMint(
    connection,
    payer,
    mintAuthority.publicKey,
    freezeAuthority,
    decimals,
    keypair,
    undefined,
    programId
  )

  return mint
}

// do not compare bump
export const positionEquals = (a: Position, b: Position) => {
  return positionWithoutOwnerEquals(a, b) && a.owner.equals(b.owner)
}

export const positionWithoutOwnerEquals = (a: Position, b: Position) => {
  return (
    a.feeGrowthInsideX.eq(b.feeGrowthInsideX) &&
    a.feeGrowthInsideY.eq(b.feeGrowthInsideY) &&
    a.liquidity.eq(b.liquidity) &&
    a.lowerTickIndex === b.lowerTickIndex &&
    a.upperTickIndex === b.upperTickIndex &&
    a.pool.equals(b.pool) &&
    a.id.eq(b.id) &&
    a.lastSlot.eq(b.lastSlot) &&
    a.secondsPerLiquidityInside.eq(b.secondsPerLiquidityInside) &&
    a.tokensOwedX.eq(b.tokensOwedX) &&
    a.tokensOwedY.eq(b.tokensOwedY)
  )
}

export const createStandardFeeTiers = async (market: Market, payer: Keypair) => {
  await Promise.all(
    FEE_TIERS.map(async feeTier => {
      const createFeeTierVars: CreateFeeTier = {
        feeTier,
        admin: payer.publicKey
      }
      await market.createFeeTier(createFeeTierVars, payer)
    })
  )
}

export const createTokensAndPool = async (
  market: Market,
  connection: Connection,
  payer: Keypair,
  initTick: number = 0,
  feeTier: FeeTier = FEE_TIERS[0]
) => {
  const mintAuthority = Keypair.generate()

  const promiseResults = await Promise.all([
    createToken(connection, payer, mintAuthority),
    createToken(connection, payer, mintAuthority),
    connection.requestAirdrop(mintAuthority.publicKey, 1e9),
    connection.requestAirdrop(payer.publicKey, 1e9)
  ])

  const pair = new Pair(promiseResults[0], promiseResults[1], feeTier)
  const tokenX = pair.tokenX
  const tokenY = pair.tokenY
  const feeTierAccount = await connection.getAccountInfo(market.getFeeTierAddress(feeTier).address)
  if (feeTierAccount === null) {
    const createFeeTierVars: CreateFeeTier = {
      feeTier,
      admin: payer.publicKey
    }
    await market.createFeeTier(createFeeTierVars, payer)
  }

  const createPoolVars: CreatePool = {
    pair,
    payer: payer,
    initTick
  }
  await market.createPool(createPoolVars)

  return { tokenX, tokenY, pair, mintAuthority }
}

export const createUserWithTokens = async (
  pair: Pair,
  connection: Connection,
  mintAuthority: Keypair,
  mintAmount: BN = new BN(1e9)
) => {
  const owner = Keypair.generate()
  const tokenXProgram = TOKEN_PROGRAM_ID
  const tokenYProgram = TOKEN_PROGRAM_ID
  const [userAccountX, userAccountY] = await Promise.all([
    createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenX,
      owner.publicKey,
      undefined,
      tokenXProgram
    ),
    createAssociatedTokenAccount(
      connection,
      mintAuthority,
      pair.tokenY,
      owner.publicKey,
      undefined,
      tokenYProgram
    ),
    connection.requestAirdrop(owner.publicKey, 1e9)
  ])

  await Promise.all([
    mintTo(
      connection,
      mintAuthority,
      pair.tokenX,
      userAccountX,
      mintAuthority,
      mintAmount as any,
      [],
      undefined,
      tokenXProgram
    ),
    mintTo(
      connection,
      mintAuthority,
      pair.tokenY,
      userAccountY,
      mintAuthority,
      mintAmount as any,
      [],
      undefined,
      tokenYProgram
    )
  ])

  return { owner, userAccountX, userAccountY }
}

export const createPoolWithLiquidity = async (
  market: Market,
  connection: Connection,
  payer: Keypair,
  liquidity: BN = new BN(10).pow(new BN(16)),
  initialTick: number = 0,
  lowerTick: number = -1000,
  upperTick: number = 1000
) => {
  const { pair, mintAuthority } = await createTokensAndPool(market, connection, payer, initialTick)
  const { owner, userAccountX, userAccountY } = await createUserWithTokens(
    pair,
    connection,
    mintAuthority,
    new BN(10).pow(new BN(14))
  )

  const initPositionVars: CreatePosition = {
    pair,
    owner: owner.publicKey,
    userTokenX: userAccountX,
    userTokenY: userAccountY,
    lowerTick,
    upperTick,
    liquidityDelta: liquidity,
    knownPrice: calculatePriceSqrt(initialTick),
    slippage: new BN(0)
  }
  await market.createPosition(initPositionVars, owner)

  return { pair, mintAuthority }
}

export const setInitialized = (bitmap: number[], index: number) => {
  bitmap[Math.floor((index + TICK_LIMIT) / 8)] |= 1 << (index + TICK_LIMIT) % 8
}

export const createPosition = async (
  connection: Connection,
  lowerTick: number,
  upperTick: number,
  liquidity: BN,
  owner: Keypair,
  ownerTokenXAccount: PublicKey,
  ownerTokenYAccount: PublicKey,
  pair: Pair,
  market: Market,
  wallet: Keypair,
  mintAuthority: Keypair
) => {
  const tokenXProgram = await getTokenProgramAddress(connection, pair.tokenX)
  const tokenYProgram = await getTokenProgramAddress(connection, pair.tokenY)

  const mintAmount = new BN(10).pow(new BN(18))
  if ((await getBalance(connection, ownerTokenXAccount, tokenXProgram)).eq(new BN(0))) {
    await mintTo(
      connection,
      wallet,
      pair.tokenX,
      ownerTokenXAccount,
      mintAuthority,
      mintAmount as any,
      [mintAuthority],
      undefined,
      tokenXProgram
    )
  }
  if ((await getBalance(connection, ownerTokenYAccount, tokenYProgram)).eq(new BN(0))) {
    await mintTo(
      connection,
      wallet,
      pair.tokenY,
      ownerTokenYAccount,
      mintAuthority,
      mintAmount as any,
      [mintAuthority],
      undefined,
      tokenYProgram
    )
  }

  const initPositionVars: CreatePosition = {
    pair,
    owner: owner.publicKey,
    userTokenX: ownerTokenXAccount,
    userTokenY: ownerTokenYAccount,
    lowerTick,
    upperTick,
    liquidityDelta: liquidity,
    knownPrice: (await market.getPool(pair)).sqrtPrice,
    slippage: new BN(0)
  }
  await market.createPosition(initPositionVars, owner)
}

export const performSwap = async (
  pair: Pair,
  xToY: boolean,
  amount: BN,
  estimatedPriceAfterSwap: BN,
  slippage: BN,
  byAmountIn: boolean,
  connection: Connection,
  market: Market,
  mintAuthority: Keypair
) => {
  const swapper = Keypair.generate()
  await connection.requestAirdrop(swapper.publicKey, 1e12)
  await sleep(1000)
  const tokenXProgram = await getTokenProgramAddress(connection, pair.tokenX)
  const tokenYProgram = await getTokenProgramAddress(connection, pair.tokenY)

  const accountX = await createAssociatedTokenAccount(
    connection,
    swapper,
    pair.tokenX,
    swapper.publicKey,
    undefined,
    tokenXProgram
  )
  const accountY = await createAssociatedTokenAccount(
    connection,
    swapper,
    pair.tokenY,
    swapper.publicKey,
    undefined,
    tokenYProgram
  )

  if (xToY) {
    await mintTo(
      connection,
      mintAuthority,
      pair.tokenX,
      accountX,
      mintAuthority,
      amount as any,
      [],
      undefined,
      tokenXProgram
    )
  } else {
    await mintTo(
      connection,
      mintAuthority,
      pair.tokenY,
      accountY,
      mintAuthority,
      amount as any,
      [],
      undefined,
      tokenYProgram
    )
  }

  const swapVars: Swap = {
    pair,
    owner: swapper.publicKey,
    xToY,
    amount,
    estimatedPriceAfterSwap,
    slippage,
    accountX,
    accountY,
    byAmountIn
  }
  await market.swap(swapVars, swapper)
}

export const createTicksFromRange = async (
  market: Market,
  { pair, payer }: CreateTick,
  start: number,
  stop: number,
  signer: Keypair
) => {
  const step = pair.feeTier.tickSpacing ?? feeToTickSpacing(pair.feeTier.fee)

  await Promise.all(
    generateTicksArray(start, stop, step).map(async index => {
      const createTickVars: CreateTick = {
        pair,
        index,
        payer
      }
      await market.createTick(createTickVars, signer)
    })
  )
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
      initTick
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

export const getCollectedTransferFee = async (connection: Connection, mint: PublicKey) => {
  // grabs all of the token accounts for a given mint
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: mint.toString()
        }
      }
    ]
  })

  const accountsToWithdrawFrom = {}

  for (const accountInfo of accounts) {
    const unpackedAccount = unpackAccount(
      accountInfo.pubkey,
      accountInfo.account,
      TOKEN_2022_PROGRAM_ID
    )

    // If there is withheld tokens add it to our list
    const transferFeeAmount = getTransferFeeAmount(unpackedAccount)
    if (transferFeeAmount != null && transferFeeAmount.withheldAmount > BigInt(0)) {
      accountsToWithdrawFrom[accountInfo.pubkey.toString()] = new BN(
        transferFeeAmount.withheldAmount as any
      )
    }
  }
  return accountsToWithdrawFrom
}

export const withdrawCollectedTransferFees = async (
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  feeVaultAccount: PublicKey,
  authority: Keypair
) => {
  // grabs all of the token accounts for a given mint
  const accounts = await connection.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: mint.toString()
        }
      }
    ]
  })

  const accountsToWithdrawFrom = []

  for (const accountInfo of accounts) {
    const unpackedAccount = unpackAccount(
      accountInfo.pubkey,
      accountInfo.account,
      TOKEN_2022_PROGRAM_ID
    )

    // If there is withheld tokens add it to our list
    const transferFeeAmount = getTransferFeeAmount(unpackedAccount)
    if (transferFeeAmount != null && transferFeeAmount.withheldAmount > BigInt(0)) {
      console.log(accountInfo.pubkey.toString(), transferFeeAmount)
      // @ts-expect-error
      accountsToWithdrawFrom.push(accountInfo.pubkey)
    }
  }

  await withdrawWithheldTokensFromAccounts(
    connection,
    payer,
    mint,
    feeVaultAccount,
    authority,
    [],
    accountsToWithdrawFrom,
    undefined,
    TOKEN_2022_PROGRAM_ID
  )
}

export const createTickArray = (size: number) => {
  const ticks: Tick[] = []
  for (let i = -(size / 2); i < size / 2; i++) {
    const tick: Tick = {
      pool: Keypair.generate().publicKey,
      index: i * 10,
      sign: true,
      liquidityChange: new BN(Math.random() * 100000000).mul(LIQUIDITY_DENOMINATOR),
      liquidityGross: new BN(0),
      sqrtPrice: new BN(0),
      feeGrowthOutsideX: new BN(Math.random() * 100),
      feeGrowthOutsideY: new BN(Math.random() * 100),
      secondsPerLiquidityOutside: new BN(0),
      bump: 0
    }
    ticks.push(tick)
  }

  return ticks
}

export const jsonArrayToTicks = (data: any[]) => {
  const ticks: Tick[] = []

  data.forEach(tick => {
    ticks.push({
      index: tick.index,
      sign: tick.sign,
      bump: tick.bump,
      liquidityChange: new BN(tick.liquidityChange),
      liquidityGross: new BN(tick.liquidityGross),
      sqrtPrice: new BN(tick.sqrtPrice),
      feeGrowthOutsideX: new BN(tick.feeGrowthOutsideX),
      feeGrowthOutsideY: new BN(tick.feeGrowthOutsideY),
      secondsPerLiquidityOutside: new BN(tick.secondsPerLiquidityOutside),
      pool: new PublicKey(tick.pool)
    })
  })

  return ticks
}

export const usdcUsdhPoolSnapshot = {
  ticksPreviousSnapshot: [
    {
      index: -13860,
      sign: true,
      bump: 251,
      liquidityChange: { v: '22964554844140308' },
      liquidityGross: { v: '22964554844140308' },
      sqrtPrice: { v: '500090922499000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264697' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -39,
      sign: true,
      bump: 253,
      liquidityChange: { v: '161429709979803343' },
      liquidityGross: { v: '161429709979803343' },
      sqrtPrice: { v: '998051997319000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264157' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -10,
      sign: true,
      bump: 255,
      liquidityChange: { v: '2000600039969988198' },
      liquidityGross: { v: '2000600039969988198' },
      sqrtPrice: { v: '999500149965000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -6,
      sign: true,
      bump: 255,
      liquidityChange: { v: '11699113914588497725' },
      liquidityGross: { v: '11699113914588497725' },
      sqrtPrice: { v: '999700059990000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264155' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -2,
      sign: true,
      bump: 255,
      liquidityChange: { v: '15563669416664063941' },
      liquidityGross: { v: '15563669416664063941' },
      sqrtPrice: { v: '999900009999000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264639' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 0,
      sign: true,
      bump: 253,
      liquidityChange: { v: '14214718904961000000' },
      liquidityGross: { v: '14214718904961000000' },
      sqrtPrice: { v: '1000000000000000000000000' },
      feeGrowthOutsideX: { v: '125342983384200995' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '265443' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 2,
      sign: true,
      bump: 255,
      liquidityChange: { v: '280022883875000000' },
      liquidityGross: { v: '280022883875000000' },
      sqrtPrice: { v: '1000100000000000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '249352' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 3,
      sign: true,
      bump: 254,
      liquidityChange: { v: '141968198361735573' },
      liquidityGross: { v: '141968198361735573' },
      sqrtPrice: { v: '1000150003749000000000000' },
      feeGrowthOutsideX: { v: '124355143127782591' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '265408' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 4,
      sign: true,
      bump: 254,
      liquidityChange: { v: '170571497404733572290' },
      liquidityGross: { v: '170571497404733572290' },
      sqrtPrice: { v: '1000200010000000000000000' },
      feeGrowthOutsideX: { v: '124252497947731995' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '265406' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 5,
      sign: false,
      bump: 252,
      liquidityChange: { v: '170713465603095307863' },
      liquidityGross: { v: '170713465603095307863' },
      sqrtPrice: { v: '1000250018750000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 8,
      sign: false,
      bump: 255,
      liquidityChange: { v: '280022883875000000' },
      liquidityGross: { v: '280022883875000000' },
      sqrtPrice: { v: '1000400060004000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 9,
      sign: false,
      bump: 254,
      liquidityChange: { v: '14214718904961000000' },
      liquidityGross: { v: '14214718904961000000' },
      sqrtPrice: { v: '1000450078756000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 10,
      sign: false,
      bump: 253,
      liquidityChange: { v: '17564269456634052139' },
      liquidityGross: { v: '17564269456634052139' },
      sqrtPrice: { v: '1000500100010000000000000' },
      feeGrowthOutsideX: { v: '44518539706358012' },
      feeGrowthOutsideY: { v: '44584358715477974' },
      secondsPerLiquidityOutside: { v: '29240' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 14,
      sign: false,
      bump: 248,
      liquidityChange: { v: '9779105136174456388' },
      liquidityGross: { v: '9779105136174456388' },
      sqrtPrice: { v: '1000700210035000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 15,
      sign: false,
      bump: 255,
      liquidityChange: { v: '1920008778414041337' },
      liquidityGross: { v: '1920008778414041337' },
      sqrtPrice: { v: '1000750243793000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 47,
      sign: false,
      bump: 249,
      liquidityChange: { v: '161429709979803343' },
      liquidityGross: { v: '161429709979803343' },
      sqrtPrice: { v: '1002352645643000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 13868,
      sign: false,
      bump: 255,
      liquidityChange: { v: '22964554844140308' },
      liquidityGross: { v: '22964554844140308' },
      sqrtPrice: { v: '2000436350662000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    }
  ],
  ticksCurrentSnapshot: [
    {
      index: -13860,
      sign: true,
      bump: 251,
      liquidityChange: { v: '19068164041883237' },
      liquidityGross: { v: '19068164041883237' },
      sqrtPrice: { v: '500090922499000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264697' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -39,
      sign: true,
      bump: 253,
      liquidityChange: { v: '161429709979803343' },
      liquidityGross: { v: '161429709979803343' },
      sqrtPrice: { v: '998051997319000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264157' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -21,
      sign: true,
      bump: 254,
      liquidityChange: { v: '40357944858000000' },
      liquidityGross: { v: '40357944858000000' },
      sqrtPrice: { v: '998950603498000000000000' },
      feeGrowthOutsideX: { v: '125342983384200995' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '265976' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -10,
      sign: true,
      bump: 255,
      liquidityChange: { v: '8353205782440988198' },
      liquidityGross: { v: '8353205782440988198' },
      sqrtPrice: { v: '999500149965000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -6,
      sign: true,
      bump: 255,
      liquidityChange: { v: '37131384992131673308' },
      liquidityGross: { v: '37131384992131673308' },
      sqrtPrice: { v: '999700059990000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264155' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -5,
      sign: true,
      bump: 255,
      liquidityChange: { v: '759269202163885743' },
      liquidityGross: { v: '759269202163885743' },
      sqrtPrice: { v: '999750043743000000000000' },
      feeGrowthOutsideX: { v: '125342983384200995' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '266097' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -2,
      sign: true,
      bump: 255,
      liquidityChange: { v: '15563669416664063941' },
      liquidityGross: { v: '15563669416664063941' },
      sqrtPrice: { v: '999900009999000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '264639' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: -1,
      sign: true,
      bump: 255,
      liquidityChange: { v: '13210465448874091781' },
      liquidityGross: { v: '13210465448874091781' },
      sqrtPrice: { v: '999950003749000000000000' },
      feeGrowthOutsideX: { v: '125670055388951310' },
      feeGrowthOutsideY: { v: '146327805999865497' },
      secondsPerLiquidityOutside: { v: '266308' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 2,
      sign: true,
      bump: 255,
      liquidityChange: { v: '20363576185323580807' },
      liquidityGross: { v: '20363576185323580807' },
      sqrtPrice: { v: '1000100000000000000000000' },
      feeGrowthOutsideX: { v: '124251168448391763' },
      feeGrowthOutsideY: { v: '146254149906104013' },
      secondsPerLiquidityOutside: { v: '249352' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 4,
      sign: true,
      bump: 254,
      liquidityChange: { v: '136542678376659381762' },
      liquidityGross: { v: '136542678376659381762' },
      sqrtPrice: { v: '1000200010000000000000000' },
      feeGrowthOutsideX: { v: '124252497947731995' },
      feeGrowthOutsideY: { v: '146260402736825943' },
      secondsPerLiquidityOutside: { v: '265406' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 5,
      sign: false,
      bump: 252,
      liquidityChange: { v: '136542678376659381762' },
      liquidityGross: { v: '136542678376659381762' },
      sqrtPrice: { v: '1000250018750000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 7,
      sign: false,
      bump: 255,
      liquidityChange: { v: '20083553301448580807' },
      liquidityGross: { v: '20083553301448580807' },
      sqrtPrice: { v: '1000350043751000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 8,
      sign: false,
      bump: 255,
      liquidityChange: { v: '280022883875000000' },
      liquidityGross: { v: '280022883875000000' },
      sqrtPrice: { v: '1000400060004000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 9,
      sign: false,
      bump: 254,
      liquidityChange: { v: '13210465448874091781' },
      liquidityGross: { v: '13210465448874091781' },
      sqrtPrice: { v: '1000450078756000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 10,
      sign: false,
      bump: 253,
      liquidityChange: { v: '17564269456634052139' },
      liquidityGross: { v: '17564269456634052139' },
      sqrtPrice: { v: '1000500100010000000000000' },
      feeGrowthOutsideX: { v: '44518539706358012' },
      feeGrowthOutsideY: { v: '44584358715477974' },
      secondsPerLiquidityOutside: { v: '29240' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 13,
      sign: false,
      bump: 255,
      liquidityChange: { v: '759269202163885743' },
      liquidityGross: { v: '759269202163885743' },
      sqrtPrice: { v: '1000650178776000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 14,
      sign: false,
      bump: 248,
      liquidityChange: { v: '43349110313498673308' },
      liquidityGross: { v: '43349110313498673308' },
      sqrtPrice: { v: '1000700210035000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 19,
      sign: false,
      bump: 254,
      liquidityChange: { v: '69000725542000000' },
      liquidityGross: { v: '69000725542000000' },
      sqrtPrice: { v: '1000950403850000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 20,
      sign: false,
      bump: 253,
      liquidityChange: { v: '65879695562000000' },
      liquidityGross: { v: '65879695562000000' },
      sqrtPrice: { v: '1001000450120000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 29,
      sign: false,
      bump: 254,
      liquidityChange: { v: '40357944858000000' },
      liquidityGross: { v: '40357944858000000' },
      sqrtPrice: { v: '1001450979157000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 47,
      sign: false,
      bump: 249,
      liquidityChange: { v: '161429709979803343' },
      liquidityGross: { v: '161429709979803343' },
      sqrtPrice: { v: '1002352645643000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    },
    {
      index: 13868,
      sign: false,
      bump: 255,
      liquidityChange: { v: '19068164041883237' },
      liquidityGross: { v: '19068164041883237' },
      sqrtPrice: { v: '2000436350662000000000000' },
      feeGrowthOutsideX: { v: '0' },
      feeGrowthOutsideY: { v: '0' },
      secondsPerLiquidityOutside: { v: '0' },
      pool: 'FwiuNR91xfiUvWiBu4gieK4SFmh9qjMhYS9ebyYJ8PGj'
    }
  ],
  currentTickIndex: 4
}

export const createPoolLookupTable = async (market: Market, pair: Pair, wallet: Keypair) => {
  const poolAsssociatedAddresses = generateLookupTableForPool(
    market,
    pair,
    await market.getPool(pair)
  )

  const accounts = await fetchLookupTableByPoolAccount(market, wallet.publicKey, pair)
  if (accounts.length) {
    console.warn('Pool account lookup table already initialized')
    for (let i = 0; i < poolAsssociatedAddresses.length; i++) {
      assert(accounts[0].state.addresses[i].equals(poolAsssociatedAddresses[i]))
      return accounts[0].key
    }
  }

  console.log(
    'Creating pool lookup tables for',
    pair.getAddress(market.program.programId).toString()
  )

  const slot = await market.connection.getSlot('finalized')

  const createPoolLookupTableTxs = await createAndExtendAddressLookupTableTxs(
    wallet.publicKey,
    slot,
    poolAsssociatedAddresses
  )
  console.log('Pool associated addresses', createPoolLookupTableTxs.lookupTableAddress.toString())

  assert(createPoolLookupTableTxs.txs.length === 1)

  await signAndSend(createPoolLookupTableTxs.txs[0], [wallet], market.connection)
  return createPoolLookupTableTxs.lookupTableAddress
}

export const createTickLookupTables = async (
  market: Market,
  pair: Pair,
  wallet: Keypair,
  startingTick: number,
  finalTick: number,
  validateAfter: boolean = false,
  validateDelay: number = 12000
) => {
  const ticks = generateLookupTableRangeForTicks(market, pair, startingTick, finalTick)
  const addresses: [number, PublicKey][] = []
  const currentSlot = await market.connection.getSlot('recent')
  const slots = await market.connection.getBlocks(currentSlot - 40, currentSlot, 'finalized')
  let slotsCounter = 0

  if (slots.length <= (startingTick - finalTick) / TICK_COUNT_PER_LOOKUP_TABLE) {
    throw new Error(`Could find only ${slots.length} ${slots} on the main fork`)
  }

  for (const tickRange of ticks) {
    try {
      const result = await fetchLookupTableByPoolAndAdjustedTickIndex(
        market,
        wallet.publicKey,
        pair,
        tickRange.startingTickForLookupTable
      )

      console.warn(
        'Lookup table already initialized:',
        result[0].key.toString(),
        'with',
        result[0].state.addresses.length,
        'addresses, on tick:',
        getRealTickFromAdjustedLookupTableStartingTick(
          pair.tickSpacing,
          tickRange.startingTickForLookupTable
        )
      )
      for (let i = 0; i < tickRange.addresses.length; i++) {
        let correct = true
        if (i === 1) {
          correct = new BN(result[0].state.addresses[i].toBuffer()).eq(
            new BN(tickRange.addresses[i].toBuffer())
          )
        } else {
          correct = result[0].state.addresses[i].equals(tickRange.addresses[i])
        }
        assert(
          correct,
          `Address of the existing table at index ${i} is incorrect, remove the table and try again`
        )
      }

      continue
    } catch (e) {}

    const lookupTableTxs = await createAndExtendAddressLookupTableTxs(
      wallet.publicKey,
      slots[slotsCounter],
      tickRange.addresses
    )

    slotsCounter += 1

    console.log(
      'Processing table',
      lookupTableTxs.lookupTableAddress.toString(),
      'with starting index',
      getRealTickFromAdjustedLookupTableStartingTick(
        pair.tickSpacing,
        tickRange.startingTickForLookupTable
      )
    )

    assert(tickRange.addresses[0].equals(pair.getAddress(market.program.programId)))
    assert(
      tickRange.addresses[1].equals(new PublicKey(new BN(tickRange.startingTickForLookupTable)))
    )

    const [initTx, ...remiaining] = lookupTableTxs.txs

    await signAndSend(initTx, [wallet], market.connection)
    await sleep(400)

    addresses.push([
      getRealTickFromAdjustedLookupTableStartingTick(
        pair.tickSpacing,
        tickRange.startingTickForLookupTable
      ),
      lookupTableTxs.lookupTableAddress
    ])

    for (const rem of remiaining) {
      await signAndSend(rem, [wallet], market.connection)
    }
    if (validateAfter) {
      await sleep(validateDelay ?? 12000)
      const result = await fetchLookupTableByPoolAndAdjustedTickIndex(
        market,
        wallet.publicKey,
        pair,
        tickRange.startingTickForLookupTable
      )

      if (result.length === 1) {
        for (let i = 0; i < tickRange.addresses.length; i++) {
          let correct = true
          if (i === 1) {
            correct = new BN(result[0].state.addresses[i].toBuffer()).eq(
              new BN(tickRange.addresses[i].toBuffer())
            )
          } else {
            correct = result[0].state.addresses[i].equals(tickRange.addresses[i])
          }
          assert(correct, `Address at index ${i} is incorrect, remove the table and try again`)
        }
      } else {
        throw new Error(
          'Multiple lookup tables exist, deactivate and close existing tables to esure that the right one is being fetched'
        )
      }
    }
  }
  return addresses
}

export const createCommonLookupTable = async (market: Market, wallet: Keypair) => {
  const slot = await market.connection.getSlot('finalized')
  const accounts = generateLookupTableForCommonAccounts(market)
  const tx = await createAndExtendAddressLookupTableTxs(wallet.publicKey, slot, accounts)
  console.info('Initializing common lookup table', tx.lookupTableAddress.toString())

  await signAndSend(tx.txs[0], [wallet], market.connection)

  return tx.lookupTableAddress
}
