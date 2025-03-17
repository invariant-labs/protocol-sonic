import { AnchorProvider, BN, BorshEventCoder, Program, utils, web3 } from '@coral-xyz/anchor'
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction
} from '@solana/web3.js'
import { DENOMINATOR, IWallet, Pair, signAndSend } from '.'
import {
  calculatePriceAfterSlippage,
  calculatePriceSqrt,
  findClosestTicks,
  getX,
  getY,
  isInitialized,
  TICK_SEARCH_RANGE
} from './math'
import { getInvariantAutoswapAddress, getMarketAddress, Network } from './network'
import {
  calculateClaimAmount,
  computeUnitsInstruction,
  createNativeAtaInstructions,
  FEE_TIERS,
  feeToTickSpacing,
  fromFee,
  getBalance,
  getFeeTierAddress,
  getLookupTableAddresses,
  getMaxTick,
  getMinTick,
  getPrice,
  getTokenProgramAddress,
  getTokens,
  getTokensData,
  isActive,
  MIN_BALANCE_FOR_TICKMAP_RENT_EXEMPT,
  parseLiquidityOnTicks,
  PositionClaimData,
  PRICE_DENOMINATOR,
  printBN,
  SEED,
  SimulateClaim,
  TokenData
} from './utils'
import { Invariant } from './idl/invariant'
import * as IDL from './idl/invariant.json'
import { InvariantAutoswap } from './idl/invariant_autoswap'
import * as autoswapIDL from './idl/invariant_autoswap.json'
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'

const POSITION_SEED = 'positionv1'
const TICK_SEED = 'tickv1'
const POSITION_LIST_SEED = 'positionlistv1'
const STATE_SEED = 'statev1'

export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const TICK_CROSSES_PER_IX_NATIVE_TOKEN = 11
export const TICK_CROSSES_PER_IX = 16
export const TICK_VIRTUAL_CROSSES_PER_IX = 10
export const FEE_TIER = 'feetierv1'
export const DEFAULT_PUBLIC_KEY = new PublicKey(0)
export const MAX_SPL_POSITION_FOR_CLAIM_ALL = 2
export const MAX_NATIVE_POSITION_FOR_CLAIM_ALL = 2

export class Market {
  public connection: Connection
  public wallet: IWallet
  public program: Program<Invariant>
  public autoswapProgram: Program<InvariantAutoswap>
  public stateAddress: AddressAndBump
  public programAuthority: AddressAndBump
  public network: Network
  public eventDecoder: BorshEventCoder

  private constructor(
    network: Network,
    wallet: IWallet,
    connection: Connection,
    _programId?: PublicKey
  ) {
    this.connection = connection
    this.wallet = wallet
    const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions())
    const programAddress = getMarketAddress(network)
    const autoswapProgramAddress = getInvariantAutoswapAddress(network)
    this.network = network
    this.program = new Program<Invariant>(IDL as unknown as Invariant, programAddress, provider)
    this.autoswapProgram = new Program<InvariantAutoswap>(
      autoswapIDL as unknown as InvariantAutoswap,
      autoswapProgramAddress,
      provider
    )
    this.eventDecoder = new BorshEventCoder(IDL as unknown as Invariant)
    this.stateAddress = this.getStateAddress()
    this.programAuthority = this.getProgramAuthority()
  }

  public static async buildWithoutProvider(
    network: Network,
    connection: Connection,
    programId?: PublicKey
  ) {
    const instance = new Market(
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
  ): Market {
    const instance = new Market(network, wallet, connection, programId)

    return instance
  }

  setWallet(wallet: IWallet) {
    this.wallet = wallet
  }

  async getCurrentTokenStats(
    tokenMintAddress: string,
    vsToken: string,
    vsTokenPrice: number
  ): Promise<
    | { priceBase: string; priceUsd: string; marketCapBase: string; marketCapUsd: string }
    | { error: string }
  > {
    const LAIKA = {
      address: new PublicKey('LaihKXA47apnS599tyEyasY2REfEzBNe4heunANhsMx'),
      decimal: 5,
      circulatingSupply: new BN('700000000000'),
      feeTier: { fee: fromFee(new BN(100)), tickSpacing: 10 }
    }
    const TURBO = {
      address: new PublicKey('trbts2EsWyMdnCjsHUFBKLtgudmBD7Rfbz8zCg1s4EK'),
      decimal: 9,
      circulatingSupply: new BN('1000000000')
    }
    const supportedTokens = [LAIKA, TURBO]

    const supportedTokenIndex = supportedTokens.findIndex(
      supportedToken => supportedToken.address.toString() === tokenMintAddress
    )

    if (supportedTokenIndex === -1) {
      return { error: 'Token data is not supported' }
    }

    const supportedToken = supportedTokens[supportedTokenIndex]

    let pair: Pair
    let pool: PoolStructure

    if (!('feeTier' in supportedToken)) {
      const pairs = FEE_TIERS.map(
        fee => new Pair(supportedToken.address, new PublicKey(vsToken), fee)
      )
      const addresses = pairs.map(pair => pair.getAddress(this.program.programId))
      const pools = (await this.program.account.pool.fetchMultiple(addresses))
        .filter(p => p !== null)
        .map(p => parsePool(p))

      let maxLiquidity = new BN(0)
      let maxPool: PoolStructure | null = null

      for (const pool of pools) {
        const liquidity: BN = pool?.liquidity ?? new BN(0)
        if (liquidity.gt(maxLiquidity)) {
          maxPool = pool
          maxLiquidity = liquidity
        }
      }

      if (!maxPool) {
        return { error: 'Pool not found' }
      }

      pool = maxPool
      pair = new Pair(maxPool.tokenX, maxPool.tokenY, {
        fee: maxPool.fee,
        tickSpacing: maxPool.tickSpacing
      })
    } else {
      pair = new Pair(
        supportedToken.address,
        new PublicKey(vsToken),
        supportedToken.feeTier as FeeTier
      )
      pool = await this.getPool(pair)
    }

    const poolPrice = pool.sqrtPrice.pow(new BN(2)).div(PRICE_DENOMINATOR)
    const isX = supportedToken.address.toString() === pair.tokenX.toString()
    const rawPrice: BN = isX
      ? poolPrice
      : new BN(PRICE_DENOMINATOR).mul(PRICE_DENOMINATOR).div(poolPrice)
    const decimalDiff = supportedToken.decimal - 9
    let priceBased = rawPrice

    if (decimalDiff > 0) {
      priceBased = rawPrice.mul(new BN(10).pow(new BN(decimalDiff)))
    }
    if (decimalDiff < 0) {
      priceBased = rawPrice.div(new BN(10).pow(new BN(Math.abs(decimalDiff))))
    }

    const priceInUsd = priceBased.mul(new BN(vsTokenPrice))
    const mcapBase = priceBased.mul(supportedToken.circulatingSupply)
    const mcapUsd = priceInUsd.mul(supportedToken.circulatingSupply)

    return {
      priceBase: printBN(priceBased, 24),
      priceUsd: printBN(priceInUsd, 24),
      marketCapBase: printBN(mcapBase, 24),
      marketCapUsd: printBN(mcapUsd, 24)
    }
  }

  async createPool(createPool: CreatePool, cache: CreatePoolCache = {}) {
    const { transaction, signers } = await this.createPoolTx(createPool, cache)

    await signAndSend(transaction, [createPool.payer, ...signers], this.connection)
  }

  async createPoolWithSqrtPrice(createPool: CreatePoolWithSqrtPrice, cache: CreatePoolCache = {}) {
    const { transaction, signers } = await this.createPoolWithSqrtPriceTx(createPool, cache)

    await signAndSend(transaction, [createPool.payer, ...signers], this.connection)
  }

  private async _createPoolTx(
    params: CreatePoolTx | CreatePoolWithSqrtPriceTx,
    withTick: boolean,
    cache: CreatePoolCache = {}
  ) {
    const { payer, pair } = params

    const payerPubkey = payer?.publicKey ?? this.wallet.publicKey
    const bitmapKeypair = Keypair.generate()
    const tokenXReserve = Keypair.generate()
    const tokenYReserve = Keypair.generate()

    const stateAddress = this.stateAddress.address

    const [poolAddress] = pair.getAddressAndBump(this.program.programId)
    const { address: feeTierAddress } = this.getFeeTierAddress(pair.feeTier)

    const [tokenXProgram, tokenYProgram] = await Promise.all([
      cache.tokenXProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])

    let createIx
    const accounts = {
      state: stateAddress,
      pool: poolAddress,
      feeTier: feeTierAddress,
      tickmap: bitmapKeypair.publicKey,
      tokenX: pair.tokenX,
      tokenY: pair.tokenY,
      tokenXProgram,
      tokenYProgram,
      payer: payerPubkey,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId
    }

    if (withTick) {
      createIx = await this.program.methods
        .createPool((params as CreatePool).initTick ?? 0)
        .accounts(accounts)
        .instruction()
    } else {
      createIx = await this.program.methods
        .createPoolWithSqrtPrice({
          v: (params as CreatePoolWithSqrtPriceTx).initSqrtPrice ?? PRICE_DENOMINATOR
        })
        .accounts(accounts)
        .instruction()
    }

    const initReservesIx = await this.program.methods
      .initReserves()
      .accounts({
        state: stateAddress,
        pool: poolAddress,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        tokenXReserve: tokenXReserve.publicKey,
        tokenYReserve: tokenYReserve.publicKey,
        authority: this.programAuthority.address,
        tokenXProgram,
        tokenYProgram,
        payer: payerPubkey,
        systemProgram: SystemProgram.programId
      })
      .instruction()

    const transaction = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: payerPubkey,
          newAccountPubkey: bitmapKeypair.publicKey,
          space: this.program.account.tickmap.size,
          lamports: MIN_BALANCE_FOR_TICKMAP_RENT_EXEMPT[this.network],
          programId: this.program.programId
        })
      )
      .add(createIx)
      .add(initReservesIx)

    return {
      transaction,
      signers: [bitmapKeypair, tokenXReserve, tokenYReserve]
    }
  }

  async createPoolTx(params: CreatePoolTx, cache: CreatePoolCache = {}) {
    return this._createPoolTx(params, true, cache)
  }

  async createPoolWithSqrtPriceTx(params: CreatePoolWithSqrtPriceTx, cache: CreatePoolCache = {}) {
    return this._createPoolTx(params, false, cache)
  }

  getProgramAuthority() {
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(SEED)],
      this.program.programId
    )

    return {
      address,
      bump
    }
  }

  getEventOptAccount(pool: PublicKey) {
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('eventoptaccv1'), pool.toBuffer()],
      this.program.programId
    )

    return {
      address,
      bump
    }
  }

  async getFeeTier(feeTier: FeeTier): Promise<FeeTier> {
    const { address } = this.getFeeTierAddress(feeTier)
    return parseFeeTier(await this.program.account.feeTier.fetch(address))
  }

  async getPool(pair: Pair): Promise<PoolStructure> {
    const address = pair.getAddress(this.program.programId)
    return parsePool(await this.program.account.pool.fetch(address))
  }

  async getPoolByAddress(address: PublicKey) {
    return parsePool(await this.program.account.pool.fetch(address))
  }

  public onPoolChange(
    tokenX: PublicKey,
    tokenY: PublicKey,
    feeTier: FeeTier,
    fn: (poolStructure: RawPoolStructure) => void
  ) {
    const poolAddress = new Pair(tokenX, tokenY, feeTier).getAddress(this.program.programId)

    this.program.account.pool
      .subscribe(poolAddress, 'singleGossip') // REVIEW use recent commitment + allow overwrite via props
      .on('change', (poolStructure: RawPoolStructure) => {
        fn(poolStructure)
      })
  }

  public onTickChange(pair: Pair, index: number, fn: (tick: RawTick) => void) {
    const { tickAddress } = this.getTickAddress(pair, index)

    this.program.account.tick
      .subscribe(tickAddress, 'singleGossip') // REVIEW use recent commitment + allow overwrite via props
      .on('change', (poolStructure: RawTick) => {
        fn(poolStructure)
      })
  }

  public async unsubscribeTick(pair: Pair, index: number): Promise<void> {
    const { tickAddress } = this.getTickAddress(pair, index)
    return this.program.account.tick.unsubscribe(tickAddress)
  }

  public onTickmapChange(tickmap: PublicKey, fn: (tickmap: Tickmap) => void) {
    this.program.account.tickmap
      .subscribe(tickmap, 'singleGossip') // REVIEW use recent commitment + allow overwrite via props
      .on('change', (tickmapStructure: Tickmap) => {
        fn(tickmapStructure)
      })
  }

  getFeeTierAddress(feeTier: FeeTier) {
    return getFeeTierAddress(feeTier, this.program.programId)
  }

  async getTickmap(pair: Pair, pool?: { tickmap: PublicKey }): Promise<Tickmap> {
    pool = pool ?? (await this.getPool(pair))

    return this.program.account.tickmap.fetch(pool.tickmap)
  }

  async isInitialized(
    pair: Pair,
    index: number,
    pool?: { tickmap: PublicKey; tickSpacing: number },
    tickmap?: Tickmap
  ) {
    pool = pool ?? (await this.getPool(pair))
    tickmap = tickmap ?? (await this.getTickmap(pair, pool))
    return isInitialized(tickmap, index, pool.tickSpacing)
  }

  async getTick(pair: Pair, index: number) {
    const { tickAddress } = this.getTickAddress(pair, index)
    return parseTick(await this.program.account.tick.fetch(tickAddress)) as Tick
  }

  async getTickByPool(poolAddress: PublicKey, index: number) {
    const { tickAddress } = this.getTickAddressByPool(poolAddress, index)
    return parseTick(await this.program.account.tick.fetch(tickAddress)) as Tick
  }

  async getClosestTicks(
    pair: Pair,
    limit: number,
    maxRange?: number,
    oneWay?: 'up' | 'down',
    pool?: { currentTickIndex: number; tickSpacing: number; tickmap: PublicKey },
    tickmap?: Tickmap
  ) {
    pool = pool ?? (await this.getPool(pair))
    tickmap = tickmap ?? (await this.getTickmap(pair, pool))

    const indexes = findClosestTicks(
      tickmap.bitmap,
      pool.currentTickIndex,
      pool.tickSpacing,
      limit,
      maxRange,
      oneWay
    )

    const ticksArray = indexes
      .map(index => this.getTickAddress(pair, index))
      .map(a => a.tickAddress)
    return (await this.program.account.tick.fetchMultiple(ticksArray))
      .filter(v => v !== null)
      .map(v => parseTick(v)) as Tick[]
  }

  async getAllIndexedTicks(pair: Pair): Promise<Map<number, Tick>> {
    return new Map(
      (await this.getAllTicks(pair)).map(tick => {
        return [tick.index, tick]
      })
    )
  }

  async getAllTicks(pair: Pair) {
    const poolPublicKey = pair.getAddress(this.program.programId)
    return (
      await this.program.account.tick.all([
        {
          memcmp: { bytes: bs58.encode(poolPublicKey.toBuffer()), offset: 8 }
        }
      ])
    ).map(a => parseTick(a.account)) as Tick[]
  }

  async getAllPoolLiquidityInTokens(poolAddress: PublicKey) {
    return (await this.program.account.position.all())
      .map(({ account }) => account)
      .filter(account => account.pool.equals(poolAddress))
      .reduce(
        (tokens, { liquidity, lowerTickIndex, upperTickIndex }) =>
          tokens.add(getTokens(liquidity.v, lowerTickIndex, upperTickIndex)),
        new BN(0)
      )
  }

  async getActiveLiquidityInTokens(poolAddress: PublicKey, currentTickIndex: number) {
    return (await this.program.account.position.all())
      .map(({ account }) => account)
      .filter(account => account.pool.equals(poolAddress))
      .filter(account => isActive(account.lowerTickIndex, account.upperTickIndex, currentTickIndex))
      .reduce(
        (tokens, { liquidity, lowerTickIndex, upperTickIndex }) =>
          tokens.add(getTokens(liquidity.v, lowerTickIndex, upperTickIndex)),
        new BN(0)
      )
  }

  async getAllPositions() {
    return (await this.program.account.position.all()).map(({ account }) =>
      parsePosition(account)
    ) as Position[]
  }

  async getAllUserPositions(owner: PublicKey): Promise<PositionStructure[]> {
    const positions: Position[] = (
      await this.program.account.position.all([
        {
          memcmp: { bytes: bs58.encode(owner.toBuffer()), offset: 8 }
        }
      ])
    ).map(({ account }) => parsePosition(account)) as Position[]

    const promises = positions.map(async position => this.calculatePositionUnclaimedFees(position))

    return Promise.all(promises)
  }

  async getAllUserPositionsWithIds(owner: PublicKey): Promise<[number, Position][]> {
    const positionList = await this.getPositionList(owner)
    const positionAddresses: PublicKey[] = []

    for (let i = 0; i < positionList.head; i++) {
      positionAddresses.push(this.getPositionAddress(owner, i).positionAddress)
    }

    let fetchedPositions: [number, Position][] = []
    if (positionAddresses.length) {
      fetchedPositions = (await this.program.account.position.fetchMultiple(positionAddresses))
        .filter(p => p !== null)
        .map((p, i) => [i, parsePosition(p)])
    }

    return fetchedPositions
  }

  async getAllUserLockedPositions(owner: PublicKey): Promise<LockedPosition[]> {
    const positions: Position[] = (
      await this.program.account.position.all([
        {
          memcmp: { bytes: bs58.encode(owner.toBuffer()), offset: 8 }
        }
      ])
    ).map(({ account }) => parsePosition(account)) as Position[]

    const promises = positions.map(async position => {
      const {
        pool: poolAddress,
        lowerTickIndex,
        upperTickIndex,
        tokensOwedX,
        tokensOwedY,
        liquidity,
        feeGrowthInsideX,
        feeGrowthInsideY
      }: Position = position

      const [pool, tickLower, tickUpper] = await Promise.all([
        this.getPoolByAddress(poolAddress),
        this.getTickByPool(poolAddress, lowerTickIndex),
        this.getTickByPool(poolAddress, upperTickIndex)
      ])

      const {
        fee,
        tickSpacing,
        tokenX,
        tokenY,
        currentTickIndex,
        feeGrowthGlobalX,
        feeGrowthGlobalY
      } = pool

      const currentSqrtPrice = calculatePriceSqrt(currentTickIndex)
      const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
      const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)

      const feeTier: FeeTier = { fee, tickSpacing }

      const amountTokenX: BN = getX(liquidity, upperSqrtPrice, currentSqrtPrice, lowerSqrtPrice)

      const amountTokenY: BN = getY(liquidity, upperSqrtPrice, currentSqrtPrice, lowerSqrtPrice)

      const positionData: PositionClaimData = {
        liquidity,
        feeGrowthInsideX,
        feeGrowthInsideY,
        tokensOwedX,
        tokensOwedY
      }

      const claim: SimulateClaim = {
        position: positionData,
        tickLower,
        tickUpper,
        tickCurrent: currentTickIndex,
        feeGrowthGlobalX,
        feeGrowthGlobalY
      }

      const [unclaimedFeesX, unclaimedFeesY] = calculateClaimAmount(claim)

      const positionStruct: LockedPosition = {
        tokenX,
        tokenY,
        feeTier,
        amountTokenX,
        amountTokenY,
        unclaimedFeesX,
        unclaimedFeesY,
        pool: position.pool,
        id: position.id
      }

      return positionStruct
    })

    return Promise.all(promises)
  }

  async calculatePositionUnclaimedFees(position: Position): Promise<PositionStructure> {
    const {
      pool: poolAddress,
      lowerTickIndex,
      upperTickIndex,
      tokensOwedX,
      tokensOwedY,
      liquidity,
      feeGrowthInsideX,
      feeGrowthInsideY
    }: Position = position

    const [pool, tokenData, tickLower, tickUpper] = await Promise.all([
      this.getPoolByAddress(poolAddress),
      getTokensData(),
      this.getTickByPool(poolAddress, lowerTickIndex),
      this.getTickByPool(poolAddress, upperTickIndex)
    ])

    const {
      fee,
      tickSpacing,
      tokenX,
      tokenY,
      currentTickIndex,
      feeGrowthGlobalX,
      feeGrowthGlobalY
    } = pool

    const dataTokenX: TokenData = tokenData[tokenX.toString()]
    const dataTokenY: TokenData = tokenData[tokenY.toString()]

    const decimalDiff: number = dataTokenX.decimals - dataTokenY.decimals

    const currentSqrtPrice = calculatePriceSqrt(currentTickIndex)
    const lowerSqrtPrice = calculatePriceSqrt(lowerTickIndex)
    const upperSqrtPrice = calculatePriceSqrt(upperTickIndex)

    const lowerPrice = getPrice(lowerSqrtPrice, decimalDiff)
    const upperPrice = getPrice(upperSqrtPrice, decimalDiff)

    const feeTier: FeeTier = { fee: fee, tickSpacing }

    const amountTokenX: BN = getX(liquidity, upperSqrtPrice, currentSqrtPrice, lowerSqrtPrice)

    const amountTokenY: BN = getY(liquidity, upperSqrtPrice, currentSqrtPrice, lowerSqrtPrice)

    const positionData: PositionClaimData = {
      liquidity: liquidity,
      feeGrowthInsideX: feeGrowthInsideX,
      feeGrowthInsideY: feeGrowthInsideY,
      tokensOwedX: tokensOwedX,
      tokensOwedY: tokensOwedY
    }

    const claim: SimulateClaim = {
      position: positionData,
      tickLower,
      tickUpper,
      tickCurrent: currentTickIndex,
      feeGrowthGlobalX,
      feeGrowthGlobalY
    }

    const [unclaimedFeesX, unclaimedFeesY] = calculateClaimAmount(claim)

    const positionStruct: PositionStructure = {
      tokenX,
      tokenY,
      feeTier,
      amountTokenX,
      amountTokenY,
      lowerPrice,
      upperPrice,
      unclaimedFeesX,
      unclaimedFeesY
    }

    return positionStruct
  }

  async getLiquidityOnTicks(pair: Pair) {
    const ticks = await this.getClosestTicks(pair, Infinity)

    return parseLiquidityOnTicks(ticks)
  }

  async getPositionList(owner: PublicKey) {
    const { positionListAddress } = this.getPositionListAddress(owner)
    return (await this.program.account.positionList.fetch(positionListAddress)) as PositionList
  }

  async getPosition(owner: PublicKey, index: number) {
    const { positionAddress } = this.getPositionAddress(owner, index)
    return parsePosition(await this.program.account.position.fetch(positionAddress)) as Position
  }

  async getPositionsFromIndexes(owner: PublicKey, indexes: number[]) {
    const positionAddresses = indexes.map(i => this.getPositionAddress(owner, i).positionAddress)
    return (await this.program.account.position.fetchMultiple(positionAddresses))
      .filter(v => v !== null)
      .map(v => parsePosition(v)) as Position[]
  }

  async getPositionsFromRange(owner: PublicKey, lowerIndex: number, upperIndex: number) {
    try {
      return this.getPositionsFromIndexes(
        owner,
        Array.from({ length: upperIndex - lowerIndex + 1 }, (_, i) => i + lowerIndex)
      )
    } catch (e) {
      return []
    }
  }

  getTickAddress(pair: Pair, index: number) {
    const poolAddress = pair.getAddress(this.program.programId)
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(index)

    const [tickAddress, tickBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode(TICK_SEED)), poolAddress.toBuffer(), indexBuffer],
      this.program.programId
    )

    return {
      tickAddress,
      tickBump
    }
  }

  getTickAddressByPool(poolAddress: PublicKey, index: number) {
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(index)

    const [tickAddress, tickBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode(TICK_SEED)), poolAddress.toBuffer(), indexBuffer],
      this.program.programId
    )

    return {
      tickAddress,
      tickBump
    }
  }

  getPositionListAddress(owner: PublicKey) {
    const [positionListAddress, positionListBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode(POSITION_LIST_SEED)), owner.toBuffer()],
      this.program.programId
    )

    return {
      positionListAddress,
      positionListBump
    }
  }

  getPositionAddress(owner: PublicKey, index: number) {
    const indexBuffer = Buffer.alloc(4)
    indexBuffer.writeInt32LE(index)

    const [positionAddress, positionBump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode(POSITION_SEED)), owner.toBuffer(), indexBuffer],
      this.program.programId
    )

    return {
      positionAddress,
      positionBump
    }
  }

  async getNewPositionAddress(owner: PublicKey, positionListHead?: number) {
    if (!positionListHead) {
      const positionList = await this.getPositionList(owner)
      positionListHead = positionList.head
    }

    return this.getPositionAddress(owner, positionListHead)
  }

  async getPositionsForPool(pool: PublicKey) {
    return (
      await this.program.account.position.all([
        {
          memcmp: { bytes: bs58.encode(pool.toBuffer()), offset: 40 }
        }
      ])
    ).map(({ account, publicKey }) => ({
      ...parsePosition(account),
      address: publicKey
    })) as PositionWithAddress[]
  }

  async createFeeTierIx({ feeTier, admin }: CreateFeeTier) {
    admin = admin ?? this.wallet.publicKey
    const { fee, tickSpacing } = feeTier
    const { address } = this.getFeeTierAddress(feeTier)
    const ts = tickSpacing ?? feeToTickSpacing(fee)

    return this.program.methods
      .createFeeTier(fee, ts)
      .accounts({
        state: this.stateAddress.address,
        feeTier: address,
        admin,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async createFeeTierTx(createFeeTier: CreateFeeTier) {
    const ix = await this.createFeeTierIx(createFeeTier)
    return new Transaction().add(ix)
  }

  // Admin function
  async createFeeTier(createFeeTier: CreateFeeTier, signer: Keypair) {
    const tx = await this.createFeeTierTx(createFeeTier)

    await signAndSend(tx, [signer], this.connection)
  }

  async createStateIx(admin?: PublicKey) {
    admin = admin ?? this.wallet.publicKey
    const { address: programAuthority, bump: nonce } = this.programAuthority

    return this.program.methods
      .createState(nonce)
      .accounts({
        state: this.stateAddress.address,
        admin,
        programAuthority: programAuthority,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async createStateTx(admin?: PublicKey) {
    const ix = await this.createStateIx(admin)
    return new Transaction().add(ix)
  }

  async createState(admin: PublicKey, signer: Keypair) {
    const tx = await this.createStateTx(admin)

    await signAndSend(tx, [signer], this.connection)
  }

  getStateAddress(): AddressAndBump {
    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from(utils.bytes.utf8.encode(STATE_SEED))],
      this.program.programId
    )

    return {
      address,
      bump
    }
  }

  async getState() {
    return (await this.program.account.state.fetch(this.stateAddress.address)) as State
  }

  async createTickIx({ pair, index, payer }: CreateTick, cache: CreateTickInstructionCache = {}) {
    payer = payer ?? this.wallet.publicKey
    const [state, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.pool ?? this.getPool(pair),
      cache.tokenXProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])

    const { tickAddress } = this.getTickAddress(pair, index)

    return this.program.methods
      .createTick(index)
      .accounts({
        tick: tickAddress,
        pool: pair.getAddress(this.program.programId),
        tickmap: state.tickmap,
        payer,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenXProgram,
        tokenYProgram
      })
      .instruction()
  }

  async createTickTx(createTick: CreateTick) {
    const ix = await this.createTickIx(createTick)
    return new Transaction().add(ix)
  }

  async createTick(createTick: CreateTick, signer: Keypair) {
    const tx = await this.createTickTx(createTick)

    await signAndSend(tx, [signer], this.connection)
  }

  async createPositionListIx(owner: PublicKey, signer?: PublicKey) {
    signer = signer ?? owner ?? this.wallet.publicKey
    const { positionListAddress } = this.getPositionListAddress(owner)

    return this.program.methods
      .createPositionList()
      .accounts({
        positionList: positionListAddress,
        owner,
        signer,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async createPositionListTx(owner: PublicKey, signer?: PublicKey) {
    const ix = await this.createPositionListIx(owner, signer)
    return new Transaction().add(ix)
  }

  async createPositionList(owner: PublicKey, signer: Keypair) {
    const tx = await this.createPositionListTx(owner, signer.publicKey)

    await signAndSend(tx, [signer], this.connection)
  }

  private async createPositionAccounts(
    pair: Pair,
    lowerTick: number,
    upperTick: number,
    userTokenX: PublicKey,
    userTokenY: PublicKey,
    owner?: PublicKey,
    cache: CreatePositionInstructionCache = {}
  ) {
    owner = owner ?? this.wallet.publicKey

    // maybe in the future index cloud be store at market
    const { tickAddress: lowerTickAddress } = this.getTickAddress(pair, lowerTick)
    const { tickAddress: upperTickAddress } = this.getTickAddress(pair, upperTick)
    const poolAddress = pair.getAddress(this.program.programId)
    const { positionListAddress } = this.getPositionListAddress(owner)

    const [state, head, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.pool ?? this.getPool(pair),
      cache.positionList?.head ??
        (async () => {
          try {
            const positionListHead = await this.getPositionList(owner).then(p => p.head)
            cache.positionList = { initialized: true, head: positionListHead }
            return positionListHead
          } catch (e) {
            cache.positionList = { initialized: false, head: 0 }
            return 0
          }
        })(),
      cache.tokenXProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])
    cache.pool = state
    cache.tokenXProgramAddress = tokenXProgram
    cache.tokenYProgramAddress = tokenYProgram

    const { positionAddress } = this.getPositionAddress(owner, head)

    return {
      state: this.stateAddress.address,
      pool: poolAddress,
      positionList: positionListAddress,
      position: positionAddress,
      tickmap: state.tickmap,
      owner,
      payer: owner,
      lowerTick: lowerTickAddress,
      upperTick: upperTickAddress,
      tokenX: pair.tokenX,
      tokenY: pair.tokenY,
      accountX: userTokenX,
      accountY: userTokenY,
      reserveX: state.tokenXReserve,
      reserveY: state.tokenYReserve,
      programAuthority: this.programAuthority.address,
      tokenXProgram,
      tokenYProgram,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
      eventOptAcc: this.getEventOptAccount(poolAddress).address
    }
  }

  async swapAndCreatePositionTx(
    createPosition: SwapAndCreatePosition,
    ticks: Ticks = {
      tickCrosses: TICK_CROSSES_PER_IX
    },
    cache: SwapAndCreatePositionTransactionCache = {}
  ) {
    const positionPair =
      createPosition.swapAndCreateOnDifferentPools?.positionPair ?? createPosition.swapPair

    const tx = await this.createAssociatedPositionAccountsTx(
      { pair: positionPair, ...createPosition },
      cache.position
    )
    const setCuIx = computeUnitsInstruction(
      1_400_000,
      createPosition.owner ?? this.wallet.publicKey
    )

    const createPositionTx = await this.swapAndCreatePositionIx(createPosition, ticks, cache)

    return tx.add(setCuIx).add(createPositionTx)
  }

  async swapAndCreatePositionIx(
    createPosition: SwapAndCreatePosition,
    ticks: Ticks = {
      tickCrosses: TICK_CROSSES_PER_IX
    },
    cache: SwapAndCreatePositionInstructionCache = {}
  ) {
    const {
      swapPair,
      owner,
      userTokenX,
      userTokenY,
      lowerTick,
      upperTick,
      amount,
      referralAccount,
      xToY,
      estimatedPriceAfterSwap,
      byAmountIn,
      liquidityDelta,
      minUtilizationPercentage,
      slippage,
      amountX,
      amountY
    } = createPosition
    const swapPriceLimit = calculatePriceAfterSlippage(estimatedPriceAfterSwap, slippage, !xToY)

    const positionPair = createPosition.swapAndCreateOnDifferentPools?.positionPair ?? swapPair
    const positionPrice =
      createPosition.swapAndCreateOnDifferentPools?.positionPoolPrice ?? estimatedPriceAfterSwap
    const positionSlippage =
      createPosition.swapAndCreateOnDifferentPools?.positionSlippage ?? slippage

    const slippageLimitLower = calculatePriceAfterSlippage(positionPrice, positionSlippage, false)
    const slippageLimitUpper = calculatePriceAfterSlippage(positionPrice, positionSlippage, true)
    const upperTickIndex = upperTick !== Infinity ? upperTick : getMaxTick(positionPair.tickSpacing)
    const lowerTickIndex =
      lowerTick !== -Infinity ? lowerTick : getMinTick(positionPair.tickSpacing)

    const liquiditySlippage = minUtilizationPercentage.mul(liquidityDelta).div(DENOMINATOR)

    const [positionAccounts, swapPool, prefetchedTickmap] = await Promise.all([
      this.createPositionAccounts(
        positionPair,
        lowerTickIndex,
        upperTickIndex,
        userTokenX,
        userTokenY,
        owner,
        cache.position
      ),
      cache.swap?.pool ?? this.getPool(swapPair),
      cache.swap?.pool?.tickmap ?? cache.swap?.pool
        ? this.getTickmap(swapPair, cache.swap?.pool)
        : undefined
    ])
    const swapTickmap = prefetchedTickmap ?? (await this.getTickmap(swapPair, swapPool))

    const tickAddresses =
      ticks.tickAddresses ??
      this.findTickAddressesForSwap(
        swapPair,
        swapPool,
        swapTickmap,
        xToY,
        (ticks as { tickCrosses: number }).tickCrosses - (referralAccount ? 1 : 0)
      )
    const remainingAccounts = tickAddresses
    if (referralAccount) {
      remainingAccounts.unshift(referralAccount)
    }

    // trunk-ignore(eslint)
    const ra: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> =
      remainingAccounts.map(pubkey => {
        return { pubkey, isWritable: true, isSigner: false }
      })
    return this.autoswapProgram.methods
      .swapAndCreatePosition(
        lowerTick,
        upperTick,
        amount,
        xToY,
        { v: swapPriceLimit },
        byAmountIn,
        amountX,
        amountY,
        { v: liquiditySlippage },
        { v: slippageLimitLower },
        { v: slippageLimitUpper }
      )
      .accounts({
        rent: SYSVAR_RENT_PUBKEY,
        invariant: this.program.programId,
        state: positionAccounts.state,
        tokenX: positionAccounts.tokenX,
        tokenY: positionAccounts.tokenY,
        tokenXProgram: positionAccounts.tokenXProgram,
        tokenYProgram: positionAccounts.tokenYProgram,
        accountX: positionAccounts.accountX,
        accountY: positionAccounts.accountY,
        position: positionAccounts.position,
        positionList: positionAccounts.positionList,
        owner: positionAccounts.owner,
        positionPool: positionAccounts.pool,
        positionReserveX: positionAccounts.reserveX,
        positionReserveY: positionAccounts.reserveY,
        positionTickmap: positionAccounts.tickmap,
        lowerTick: positionAccounts.lowerTick,
        upperTick: positionAccounts.upperTick,
        eventOptAcc: this.getEventOptAccount(positionPair.getAddress(this.program.programId))
          .address,
        swapPool: swapPair.getAddress(this.program.programId),
        swapReserveX: swapPool.tokenXReserve,
        swapReserveY: swapPool.tokenYReserve,
        swapTickmap: swapPool.tickmap,
        systemProgram: positionAccounts.systemProgram,
        programAuthority: positionAccounts.programAuthority
      })
      .remainingAccounts(ra)
      .instruction()
  }

  async versionedSwapAndCreatePositionTx(
    createPosition: SwapAndCreatePosition,
    ticks: TickIndexesOrCrosses,
    cache: SwapAndCreatePositionTransactionCache & { blockhash?: string } = {},
    prependedIxs: TransactionInstruction[] = [],
    appendedIxs: TransactionInstruction[] = [],
    tableLookups?: AddressLookupTableAccount[]
  ) {
    const swapPair = createPosition.swapPair
    const positionPair = createPosition.swapAndCreateOnDifferentPools?.positionPair ?? swapPair

    const upperTickIndex =
      createPosition.upperTick !== Infinity
        ? createPosition.upperTick
        : getMaxTick(positionPair.tickSpacing)
    const lowerTickIndex =
      createPosition.lowerTick !== -Infinity
        ? createPosition.lowerTick
        : getMinTick(positionPair.tickSpacing)

    const [_, swapPool, prefetchedTickmap, fetchedBlockHash] = await Promise.all([
      this.createPositionAccounts(
        positionPair,
        lowerTickIndex,
        upperTickIndex,
        createPosition.userTokenX,
        createPosition.userTokenY,
        createPosition.owner,
        cache.position
      ),
      cache.swap?.pool ?? this.getPool(swapPair),
      cache.swap?.pool?.tickmap ?? cache.swap?.pool
        ? this.getTickmap(swapPair, cache.swap?.pool)
        : undefined,
      cache.blockhash ?? this.connection.getLatestBlockhash().then(h => h.blockhash)
    ])

    const swapTickmap = prefetchedTickmap ?? (await this.getTickmap(swapPair, swapPool))

    cache.position ??= {}
    cache.swap ??= {}
    cache.swap.pool = swapPool
    cache.swap.tickmap = swapTickmap

    let tickIndexes: number[] = []
    if (ticks.tickIndexes) {
      tickIndexes = ticks.tickIndexes
    } else {
      tickIndexes = this.findTickIndexesForSwap(
        cache.swap.pool,
        cache.swap.tickmap,
        createPosition.xToY,
        ticks.tickCrosses
      )
    }

    const lookups = tableLookups ?? getLookupTableAddresses(this, swapPair, tickIndexes)
    const tickAddresses = tickIndexes.map(index => this.getTickAddress(swapPair, index).tickAddress)

    if (!lookups.every(p => p !== undefined)) {
      throw new Error('Not all lookup tables were defined')
    }

    const swapTx = await this.swapAndCreatePositionTx(createPosition, {
      tickAddresses: tickAddresses
    })

    const messageV0 = new web3.TransactionMessage({
      payerKey: createPosition.owner ?? this.wallet.publicKey,
      recentBlockhash: fetchedBlockHash,
      instructions: [...prependedIxs, ...swapTx.instructions, ...appendedIxs]
    }).compileToV0Message(lookups)

    return new web3.VersionedTransaction(messageV0)
  }
  async createPositionIx(
    {
      pair,
      owner,
      userTokenX,
      userTokenY,
      lowerTick,
      upperTick,
      liquidityDelta,
      knownPrice,
      slippage
    }: CreatePosition,
    cache: CreatePositionInstructionCache = {}
  ) {
    const slippageLimitLower = calculatePriceAfterSlippage(knownPrice, slippage, false)
    const slippageLimitUpper = calculatePriceAfterSlippage(knownPrice, slippage, true)

    const upperTickIndex = upperTick !== Infinity ? upperTick : getMaxTick(pair.tickSpacing)
    const lowerTickIndex = lowerTick !== -Infinity ? lowerTick : getMinTick(pair.tickSpacing)

    const accounts = await this.createPositionAccounts(
      pair,
      lowerTickIndex,
      upperTickIndex,
      userTokenX,
      userTokenY,
      owner,
      cache
    )

    return this.program.methods
      .createPosition(
        lowerTickIndex,
        upperTickIndex,
        { v: liquidityDelta },
        { v: slippageLimitLower },
        { v: slippageLimitUpper }
      )
      .accounts(accounts)
      .instruction()
  }
  private async createAssociatedPositionAccountsTx(
    createPosition: Pick<CreatePosition, 'pair' | 'lowerTick' | 'upperTick' | 'owner'>,
    cache: CreatePositionTransactionCache = {}
  ) {
    const { pair, lowerTick: lowerIndex, upperTick: upperIndex } = createPosition
    const payer = createPosition.owner ?? this.wallet.publicKey
    const lowerTick = lowerIndex === -Infinity ? getMinTick(pair.tickSpacing) : lowerIndex
    const upperTick = upperIndex === Infinity ? getMaxTick(pair.tickSpacing) : upperIndex

    // undefined - tmp solution
    let positionListInstruction: TransactionInstruction | undefined
    let lowerTickInstruction: TransactionInstruction | undefined
    let upperTickInstruction: TransactionInstruction | undefined
    let positionList: PositionListCache
    const tx = new Transaction()

    const pool = cache.pool ?? (await this.getPool(pair))
    cache.pool = pool

    const checkTicks = async () => {
      let accountsToFetch: {
        lowerTick: boolean
        upperTick: boolean
      } = {
        lowerTick: true,
        upperTick: true
      }
      if (cache.lowerTickExists !== undefined) {
        accountsToFetch.lowerTick = false
        if (!cache.lowerTickExists) {
          lowerTickInstruction = await this.createTickIx({ pair, index: lowerTick, payer }, cache)
        }
      }

      if (cache.upperTickExists !== undefined) {
        accountsToFetch.upperTick = false
        if (!cache.upperTickExists) {
          upperTickInstruction = await this.createTickIx({ pair, index: upperTick, payer }, cache)
        }
      }

      const accounts: PublicKey[] = []
      let indexes: {
        low: number | undefined
        up: number | undefined
      } = {
        low: undefined,
        up: undefined
      }
      if (accountsToFetch.lowerTick) {
        const { tickAddress: lowerTickAddress } = this.getTickAddress(pair, lowerTick)
        accounts.push(lowerTickAddress)
        indexes.low = accounts.length - 1
      }

      if (accountsToFetch.upperTick) {
        const { tickAddress: upperTickAddress } = this.getTickAddress(pair, upperTick)
        accounts.push(upperTickAddress)
        indexes.up = accounts.length - 1
      }

      const fetchedAccounts = await this.program.account.tick.fetchMultiple(accounts)

      if (indexes.low !== undefined && fetchedAccounts[indexes.low] === null) {
        lowerTickInstruction = await this.createTickIx({ pair, index: lowerTick, payer }, cache)
      }
      if (indexes.up !== undefined && fetchedAccounts[indexes.up] === null) {
        upperTickInstruction = await this.createTickIx({ pair, index: upperTick, payer }, cache)
      }
    }

    const checkPositionList = async () => {
      if (cache.positionList !== undefined) {
        positionList = cache.positionList
        if (!cache.positionList.initialized) {
          positionListInstruction = await this.createPositionListIx(payer)
        }
        return
      }

      try {
        const list = await this.getPositionList(payer)
        positionList = { head: list.head, initialized: true }
      } catch (e) {
        positionListInstruction = await this.createPositionListIx(payer)
        positionList = { head: 0, initialized: false }
      }
    }

    const [tokenXProgramAddress, tokenYProgramAddress] = await Promise.all([
      cache.tokenXProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenY),
      checkTicks(),
      checkPositionList()
    ])

    cache.tokenXProgramAddress = tokenXProgramAddress
    cache.tokenYProgramAddress = tokenYProgramAddress
    cache.positionList = positionList!

    if (!positionList!.initialized) {
      positionListInstruction = await this.createPositionListIx(payer)
    }

    if (positionListInstruction) {
      tx.add(positionListInstruction)
    }
    if (lowerTickInstruction) {
      tx.add(lowerTickInstruction)
    }
    if (upperTickInstruction) {
      tx.add(upperTickInstruction)
    }

    return tx
  }
  async createPositionTx(
    createPosition: CreatePosition,
    cache: CreatePositionTransactionCache = {}
  ) {
    const tx = await this.createAssociatedPositionAccountsTx(createPosition, cache)
    const positionInstruction = await this.createPositionIx(createPosition, cache)

    return tx.add(positionInstruction)
  }

  async createPosition(
    createPosition: CreatePosition,
    signer: Keypair,
    cache: CreatePositionTransactionCache = {}
  ) {
    const tx = await this.createPositionTx(createPosition, cache)

    await signAndSend(tx, [signer], this.connection)
  }

  async swapAndCreatePosition(
    createPosition: SwapAndCreatePosition,
    signer: Keypair,
    ticks: Ticks = { tickCrosses: TICK_CROSSES_PER_IX },
    cache: SwapAndCreatePositionInstructionCache = {}
  ) {
    const tx = await this.swapAndCreatePositionTx(createPosition, ticks, cache)

    await signAndSend(tx, [signer], this.connection, { skipPreflight: true })
  }

  // async changeLiquidity(changeLiquidity: ChangeLiquidity, signer: Keypair) {
  //   const ix = await this.changeLiquidityIx(changeLiquidity, signer)
  //   const tx = new Transaction().add(ix)
  //   await signAndSend(tx, [signer], this.connection)
  // }

  // async changeLiquidityIx(
  //   {
  //     pair,
  //     slippage,
  //     knownPrice,
  //     index,
  //     liquidityDelta,
  //     addLiquidity,
  //     owner,
  //     ...accounts
  //   }: ChangeLiquidity,
  //   signer?: Keypair
  // ): Promise<TransactionInstruction> {
  //   const payerPubkey = signer?.publicKey ?? this.wallet.publicKey
  //   const ownerPubkey = owner ?? payerPubkey
  //   const slippageLimitLower = calculatePriceAfterSlippage(knownPrice, slippage, false)
  //   const slippageLimitUpper = calculatePriceAfterSlippage(knownPrice, slippage, true)

  //   const { address: state } = await this.getStateAddress()
  //   const { positionAddress: position } = await this.getPositionAddress(payerPubkey, index)
  //   const [pool] = await pair.getAddressAndBump(this.program.programId)

  //   let lowerTickIndex = accounts.lowerTickIndex
  //   let upperTickIndex = accounts.upperTickIndex
  //   if (!lowerTickIndex || !upperTickIndex) {
  //     const position = await this.getPosition(ownerPubkey, index)
  //     lowerTickIndex = position.lowerTickIndex
  //     upperTickIndex = position.upperTickIndex
  //   }
  //   const { tickAddress: lowerTick } = await this.getTickAddress(pair, lowerTickIndex)
  //   const { tickAddress: upperTick } = await this.getTickAddress(pair, upperTickIndex)
  //   const poolStruct = await this.getPool(pair)
  //   const tokenXProgram = await getTokenProgramAddress(this.connection, pair.tokenX)
  //   const tokenYProgram = await getTokenProgramAddress(this.connection, pair.tokenY)

  //   return this.program.methods
  //     .changeLiquidity(index, liquidityDelta, addLiquidity, slippageLimitLower, slippageLimitUpper)
  //     .accounts({
  //       state,
  //       position,
  //       pool,
  //       payer: payerPubkey,
  //       owner: ownerPubkey,
  //       lowerTick,
  //       upperTick,
  //       tokenX: pair.tokenX,
  //       tokenY: pair.tokenY,
  //       reserveX: poolStruct.tokenXReserve,
  //       reserveY: poolStruct.tokenYReserve,
  //       programAuthority: this.programAuthority,
  //       tokenXProgram,
  //       tokenYProgram,
  //       ...accounts
  //     })
  //     .instruction()
  // }
  async createPoolAndPositionTx(
    params: CreatePoolAndPosition,
    payer?: { publicKey: PublicKey },
    cache: CreatePoolAndPositionCache = {}
  ) {
    return this._createPoolAndPositionTx(params, true, payer, cache)
  }

  async createPoolWithSqrtPriceAndPositionTx(
    params: CreatePosition,
    payer?: { publicKey: PublicKey },
    cache: CreatePoolAndPositionCache = {}
  ) {
    return this._createPoolAndPositionTx(params, false, payer, cache)
  }

  private async _createPoolAndPositionTx(
    params: CreatePoolAndPosition,
    withTick: boolean,
    payer?: { publicKey: PublicKey },
    cache: CreatePoolAndPositionCache = {}
  ) {
    const {
      pair,
      owner,
      userTokenX,
      userTokenY,
      lowerTick,
      upperTick,
      liquidityDelta,
      knownPrice,
      slippage
    } = params
    const payerPubkey = payer?.publicKey ?? this.wallet.publicKey

    const [positionList, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.positionList ??
        (async () => {
          try {
            const positionList = await this.getPositionList(payerPubkey)
            return { initialized: true, head: positionList.head }
          } catch (e) {
            return { initialized: false, head: 0 }
          }
        })(),
      cache.tokenXProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgramAddress ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])
    cache.tokenXProgramAddress = tokenXProgram
    cache.tokenYProgramAddress = tokenYProgram
    cache.positionList = positionList

    const { transaction: createPoolTx, signers } = await this._createPoolTx(
      {
        payer: payer,
        initSqrtPrice: knownPrice,
        ...params
      },
      withTick,
      cache
    )
    createPoolTx.feePayer = payerPubkey

    const [bitmapKeypair, tokenXReserve, tokenYReserve] = signers

    const positionCache: CreatePositionTransactionCache = {
      pool: {
        tokenXReserve: tokenXReserve.publicKey,
        tokenYReserve: tokenYReserve.publicKey,
        tickmap: bitmapKeypair.publicKey
      },
      lowerTickExists: false,
      upperTickExists: false,
      ...cache
    }

    const createPositionTx = await this.createPositionTx(
      {
        pair,
        userTokenX,
        userTokenY,
        lowerTick,
        upperTick,
        liquidityDelta,
        knownPrice,
        slippage,
        owner: owner ?? this.wallet.publicKey
      },
      positionCache
    )

    createPositionTx.feePayer = payerPubkey

    return {
      createPoolTx,
      createPositionTx,
      createPoolSigners: signers
    }
  }

  async createPoolAndPosition(
    createPool: CreatePoolAndPosition,
    signer: Keypair,
    cache: CreatePoolAndPositionCache = {}
  ) {
    const { createPoolTx, createPositionTx, createPoolSigners } =
      await this.createPoolAndPositionTx(createPool, signer, cache)

    await signAndSend(createPoolTx, [signer, ...createPoolSigners], this.connection)
    await signAndSend(createPositionTx, [signer], this.connection)
  }

  async createPoolWithSqrtPriceAndPosition(
    params: CreatePosition,
    signer: Keypair,
    cache: CreatePoolAndPositionCache = {}
  ) {
    const { createPoolTx, createPositionTx, createPoolSigners } =
      await this.createPoolWithSqrtPriceAndPositionTx(params, signer, cache)

    await signAndSend(createPoolTx, [signer, ...createPoolSigners], this.connection)
    await signAndSend(createPositionTx, [signer], this.connection)
  }
  findTickIndexesForSwap(
    pool: PoolStructure,
    tickmap: Tickmap,
    xToY: boolean,
    tickCrosses: number
  ) {
    const indexesInDirection = findClosestTicks(
      tickmap.bitmap,
      pool.currentTickIndex,
      pool.tickSpacing,
      tickCrosses,
      (tickCrosses + TICK_VIRTUAL_CROSSES_PER_IX) * TICK_SEARCH_RANGE,
      xToY ? 'down' : 'up'
    )

    const indexesInReverse = findClosestTicks(
      tickmap.bitmap,
      pool.currentTickIndex,
      pool.tickSpacing,
      1,
      TICK_SEARCH_RANGE / 2,
      xToY ? 'up' : 'down'
    )

    return indexesInDirection.concat(indexesInReverse)
  }
  findTickAddressesForSwap(
    pair: Pair,
    pool: PoolStructure,
    tickmap: Tickmap,
    xToY: boolean,
    tickCrosses: number
  ) {
    const tickIndexes = this.findTickIndexesForSwap(pool, tickmap, xToY, tickCrosses)
    return tickIndexes.map(i => this.getTickAddress(pair, i).tickAddress)
  }

  async swapIx(
    swap: Swap,
    cache: SwapCache = {},
    ticks: Ticks = {
      tickCrosses: TICK_CROSSES_PER_IX
    }
  ) {
    const {
      pair,
      xToY,
      referralAccount,
      amount,
      byAmountIn,
      estimatedPriceAfterSwap,
      slippage,
      accountX,
      accountY
    } = swap

    const [pool, tokenXProgram, tokenYProgram, prefetchedTickmap] = await Promise.all([
      cache.pool ?? this.getPool(pair),
      cache.tokenXProgram ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgram ?? getTokenProgramAddress(this.connection, pair.tokenY),
      cache.tickmap ?? cache.pool ? this.getTickmap(pair, cache.pool) : undefined
    ])
    const tickmap = prefetchedTickmap ?? (await this.getTickmap(pair, pool))

    const tickAddresses =
      ticks.tickAddresses ??
      this.findTickAddressesForSwap(
        pair,
        pool,
        tickmap,
        xToY,
        (ticks as { tickCrosses: number }).tickCrosses - (referralAccount ? 1 : 0)
      )

    const owner = swap.owner ?? this.wallet.publicKey
    const poolAddress = pair.getAddress(this.program.programId)
    const priceLimit = calculatePriceAfterSlippage(estimatedPriceAfterSwap, slippage, !xToY)
    const remainingAccounts = tickAddresses
    if (swap.referralAccount) {
      remainingAccounts.unshift(swap.referralAccount)
    }

    // trunk-ignore(eslint)
    const ra: Array<{ pubkey: PublicKey; isWritable: boolean; isSigner: boolean }> =
      remainingAccounts.map(pubkey => {
        return { pubkey, isWritable: true, isSigner: false }
      })

    const swapIx = await this.program.methods
      .swap(xToY, amount, byAmountIn, priceLimit)
      .accounts({
        state: this.stateAddress.address,
        pool: poolAddress,
        tickmap: pool.tickmap,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        reserveX: pool.tokenXReserve,
        reserveY: pool.tokenYReserve,
        owner,
        accountX,
        accountY,
        programAuthority: this.programAuthority.address,
        tokenXProgram,
        tokenYProgram
      })
      .remainingAccounts(ra)
      .instruction()
    return swapIx
  }

  async swapTx(
    swap: Swap,
    cache: SwapCache = {},
    ticks: Ticks = { tickCrosses: TICK_CROSSES_PER_IX }
  ) {
    const setCuIx = computeUnitsInstruction(1_400_000, swap.owner ?? this.wallet.publicKey)
    const swapIx = await this.swapIx(swap, cache, ticks)
    return new Transaction().add(setCuIx).add(swapIx)
  }

  async versionedSwapTx(
    swap: Swap,
    cache: SwapCache & { blockhash?: string } = {},
    ticks: TickIndexesOrCrosses = { tickCrosses: TICK_CROSSES_PER_IX },
    prependedIxs: TransactionInstruction[] = [],
    appendedIxs: TransactionInstruction[] = [],
    tableLookups?: AddressLookupTableAccount[]
  ) {
    const swapPair = swap.pair
    const [swapPool, prefetchedTickmap, fetchedBlockHash] = await Promise.all([
      cache?.pool ?? this.getPool(swapPair),
      cache?.pool?.tickmap ?? cache?.pool ? this.getTickmap(swapPair, cache?.pool) : undefined,
      cache.blockhash ?? this.connection.getLatestBlockhash().then(h => h.blockhash)
    ])
    cache.pool = swapPool

    const swapTickmap = prefetchedTickmap ?? (await this.getTickmap(swapPair, swapPool))
    cache.tickmap = swapTickmap

    let tickIndexes: number[] = []
    if (ticks.tickIndexes) {
      tickIndexes = ticks.tickIndexes
    } else {
      tickIndexes = this.findTickIndexesForSwap(swapPool, swapTickmap, swap.xToY, ticks.tickCrosses)
    }

    const lookups = tableLookups ?? getLookupTableAddresses(this, swapPair, tickIndexes)
    const tickAddresses = tickIndexes.map(index => this.getTickAddress(swapPair, index).tickAddress)

    const swapTx = await this.swapTx(swap, cache, {
      tickAddresses: tickAddresses
    })

    const messageV0 = new web3.TransactionMessage({
      payerKey: swap.owner ?? this.wallet.publicKey,
      recentBlockhash: fetchedBlockHash,
      instructions: [...prependedIxs, ...swapTx.instructions, ...appendedIxs]
    }).compileToV0Message(lookups)

    return new web3.VersionedTransaction(messageV0)
  }

  async swap(
    swap: Swap,
    signer: Keypair,
    cache: SwapCache = {},
    ticks: Ticks = { tickCrosses: TICK_CROSSES_PER_IX }
  ) {
    const tx = await this.swapTx(swap, cache, ticks)

    return signAndSend(tx, [signer], this.connection)
  }

  async getReserveBalances(pair: Pair) {
    const state = await this.getPool(pair)
    const tokenXProgram = await getTokenProgramAddress(this.connection, pair.tokenX)
    const tokenYProgram = await getTokenProgramAddress(this.connection, pair.tokenY)

    const [x, y] = await Promise.all([
      getBalance(this.connection, state.tokenXReserve, tokenXProgram),
      getBalance(this.connection, state.tokenYReserve, tokenYProgram)
    ])

    return { x, y }
  }

  async claimFeeIx(claimFee: ClaimFee, cache: ClaimFeeCache = {}) {
    const { pair, userTokenX, userTokenY, index } = claimFee
    const owner = claimFee.owner ?? this.wallet.publicKey

    const [state, position, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.pool ?? this.getPool(pair),
      cache.position ?? this.getPosition(owner, index),
      cache.tokenXProgram ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgram ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])

    const { positionAddress } = this.getPositionAddress(owner, index)
    const { tickAddress: lowerTickAddress } = this.getTickAddress(pair, position.lowerTickIndex)
    const { tickAddress: upperTickAddress } = this.getTickAddress(pair, position.upperTickIndex)

    return this.program.methods
      .claimFee(index, position.lowerTickIndex, position.upperTickIndex)
      .accounts({
        state: this.stateAddress.address,
        pool: pair.getAddress(this.program.programId),
        position: positionAddress,
        lowerTick: lowerTickAddress,
        upperTick: upperTickAddress,
        owner,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        accountX: userTokenX,
        accountY: userTokenY,
        reserveX: state.tokenXReserve,
        reserveY: state.tokenYReserve,
        programAuthority: this.programAuthority.address,
        tokenXProgram,
        tokenYProgram
      })
      .instruction()
  }

  async claimFeeTx(claimFee: ClaimFee, cache: ClaimFeeCache = {}) {
    const ix = await this.claimFeeIx(claimFee, cache)
    return new Transaction().add(ix)
  }

  async claimFee(claimFee: ClaimFee, signer: Keypair, cache: ClaimFeeCache = {}) {
    const tx = await this.claimFeeTx(claimFee, cache)

    await signAndSend(tx, [signer], this.connection)
  }

  async claimAllFees(params: ClaimAllFee, signer: Keypair) {
    const txs = await this.claimAllFeesTxs(params)
    for (const { tx, additionalSigner } of txs) {
      if (additionalSigner) {
        await signAndSend(tx, [signer, additionalSigner], this.connection)
      } else {
        await signAndSend(tx, [signer], this.connection)
      }
    }
  }

  async claimAllFeesTxs({
    owner,
    positions
  }: ClaimAllFee): Promise<{ tx: Transaction; additionalSigner?: Keypair }[]> {
    owner ??= this.wallet.publicKey

    const pools: Record<string, PoolStructure> = {}
    const ixs: TransactionInstruction[] = []
    const nativeIxs: TransactionInstruction[] = []
    const splPositions: ClaimAllFeePosition[] = []
    const nativePositions: ClaimAllFeePosition[] = []
    const atas: {
      keypair: Keypair
      createIx: TransactionInstruction
      initIx: TransactionInstruction
      unwrapIx: TransactionInstruction
    }[] = []

    const tokenPubkeys: PublicKey[] = Array.from(
      new Set(positions.map(p => [p.pair.tokenX, p.pair.tokenY]).flat())
    )
    const pairs: Pair[] = Array.from(new Set(positions.map(p => p.pair)))

    const promisedTokenPorgrams = await this.connection.getMultipleAccountsInfo(tokenPubkeys)

    const tokenPrograms: Record<string, PublicKey> = promisedTokenPorgrams.reduce(
      (acc: Record<string, PublicKey>, cur: any, idx: number) => {
        acc[tokenPubkeys[idx].toBase58()] = cur?.owner ?? TOKEN_2022_PROGRAM_ID
        return acc
      },
      {}
    )

    const poolStructures: [PublicKey, PoolStructure][] = await Promise.all([
      ...pairs.map(pair => {
        return new Promise(async res => {
          res([pair.getAddress(this.program.programId), await this.getPool(pair)])
        }) as Promise<[PublicKey, PoolStructure]>
      })
    ])

    poolStructures.forEach((p: [PublicKey, PoolStructure]) => (pools[p[0].toBase58()] = p[1]))

    for (const position of positions) {
      if (position.pair.tokenX.equals(NATIVE_MINT) || position.pair.tokenY.equals(NATIVE_MINT)) {
        nativePositions.push(position)
      } else {
        splPositions.push(position)
      }
    }

    if (nativePositions.length != 0) {
      const requiredAtas = Math.ceil(nativePositions.length / MAX_NATIVE_POSITION_FOR_CLAIM_ALL)

      for (let i = 0; i < requiredAtas; i++) {
        const nativeAta = Keypair.generate()
        const { createIx, initIx, unwrapIx } = createNativeAtaInstructions(
          nativeAta.publicKey,
          owner,
          this.network
        )
        atas.push({
          keypair: nativeAta,
          createIx,
          initIx,
          unwrapIx
        })
      }

      for (const [n, { index, pair }] of nativePositions.entries()) {
        const idx = Math.floor(n / MAX_NATIVE_POSITION_FOR_CLAIM_ALL)

        const poolPubkey = pair.getAddress(this.program.programId).toBase58()

        const userTokenX = pair.tokenX.equals(NATIVE_MINT)
          ? atas[idx].keypair.publicKey
          : getAssociatedTokenAddressSync(
              pair.tokenX,
              owner,
              false,
              tokenPrograms[pair.tokenX.toBase58()]
            )
        const userTokenY = pair.tokenY.equals(NATIVE_MINT)
          ? atas[idx].keypair.publicKey
          : getAssociatedTokenAddressSync(
              pair.tokenY,
              owner,
              false,
              tokenPrograms[pair.tokenY.toBase58()]
            )

        const claimIx = await this.claimFeeIx(
          {
            index,
            pair,
            userTokenX,
            userTokenY,
            owner
          },
          {
            pool: pools[poolPubkey],
            tokenXProgram: tokenPrograms[pair.tokenX.toBase58()],
            tokenYProgram: tokenPrograms[pair.tokenY.toBase58()]
          }
        )

        nativeIxs.push(claimIx)
      }
    }

    if (splPositions.length != 0) {
      for (const position of splPositions) {
        const { pair, index } = position

        const poolPubkey = pair.getAddress(this.program.programId).toBase58()

        const userTokenX = getAssociatedTokenAddressSync(
          pair.tokenX,
          owner,
          false,
          tokenPrograms[pair.tokenX.toBase58()]
        )
        const userTokenY = getAssociatedTokenAddressSync(
          pair.tokenY,
          owner,
          false,
          tokenPrograms[pair.tokenY.toBase58()]
        )

        const claimIx = await this.claimFeeIx(
          {
            index,
            pair,
            userTokenX,
            userTokenY,
            owner
          },
          {
            pool: pools[poolPubkey],
            tokenXProgram: tokenPrograms[pair.tokenX.toBase58()],
            tokenYProgram: tokenPrograms[pair.tokenY.toBase58()]
          }
        )

        ixs.push(claimIx)
      }
    }

    let txs: { tx: Transaction; additionalSigner?: Keypair }[] = []

    for (let i = 0; i < ixs.length; i += MAX_SPL_POSITION_FOR_CLAIM_ALL) {
      txs.push({ tx: new Transaction().add(...ixs.slice(i, i + MAX_SPL_POSITION_FOR_CLAIM_ALL)) })
    }

    for (let i = 0; i < nativeIxs.length; i += MAX_NATIVE_POSITION_FOR_CLAIM_ALL) {
      const idx = i === 0 ? 0 : Math.floor(i / MAX_SPL_POSITION_FOR_CLAIM_ALL)
      txs.push({
        tx: new Transaction()
          .add(atas[idx].createIx)
          .add(atas[idx].initIx)
          .add(...nativeIxs.slice(i, i + MAX_NATIVE_POSITION_FOR_CLAIM_ALL))
          .add(atas[idx].unwrapIx),
        additionalSigner: atas[idx].keypair
      })
    }

    return txs
  }

  async withdrawProtocolFeeIx(
    withdrawProtocolFee: WithdrawProtocolFee,
    cache: WithdrawProtocolFeeCache = {}
  ) {
    const { pair, accountX, accountY } = withdrawProtocolFee
    const admin = withdrawProtocolFee.admin ?? this.wallet.publicKey

    const [pool, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.pool ?? this.getPool(pair),
      cache.tokenXProgram ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgram ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])

    return this.program.methods
      .withdrawProtocolFee()
      .accounts({
        state: this.stateAddress.address,
        pool: pair.getAddress(this.program.programId),
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        reserveX: pool.tokenXReserve,
        reserveY: pool.tokenYReserve,
        accountX,
        accountY,
        authority: admin,
        programAuthority: this.programAuthority.address,
        tokenXProgram,
        tokenYProgram
      })
      .instruction()
  }

  async withdrawProtocolFeeTx(
    withdrawProtocolFee: WithdrawProtocolFee,
    cache: WithdrawProtocolFeeCache = {}
  ) {
    const ix = await this.withdrawProtocolFeeIx(withdrawProtocolFee, cache)
    return new Transaction().add(ix)
  }

  // Admin function
  async withdrawProtocolFee(
    withdrawProtocolFee: WithdrawProtocolFee,
    signer: Keypair,
    cache: WithdrawProtocolFeeCache = {}
  ) {
    const tx = await this.withdrawProtocolFeeTx(withdrawProtocolFee, cache)

    await signAndSend(tx, [signer], this.connection)
  }

  async removePositionIx(
    removePosition: RemovePosition,
    cache: RemovePositionCache = {}
  ): Promise<TransactionInstruction> {
    const { owner, pair, index, userTokenX, userTokenY } = removePosition
    const payer = removePosition.payer ?? owner

    const [positionList, state, position, tokenXProgram, tokenYProgram] = await Promise.all([
      cache.positionList ?? this.getPositionList(owner),
      cache.pool ?? this.getPool(pair),
      cache.position ?? this.getPosition(owner, index),
      cache.tokenXProgram ?? getTokenProgramAddress(this.connection, pair.tokenX),
      cache.tokenYProgram ?? getTokenProgramAddress(this.connection, pair.tokenY)
    ])

    const { positionListAddress } = this.getPositionListAddress(owner)
    const { positionAddress: removedPositionAddress } = this.getPositionAddress(owner, index)
    const { positionAddress: lastPositionAddress } = this.getPositionAddress(
      owner,
      positionList.head - 1
    )

    const { tickAddress: lowerTickAddress } = this.getTickAddress(pair, position.lowerTickIndex)
    const { tickAddress: upperTickAddress } = this.getTickAddress(pair, position.upperTickIndex)
    const poolAddress = pair.getAddress(this.program.programId)
    return this.program.methods
      .removePosition(index, position.lowerTickIndex, position.upperTickIndex)
      .accounts({
        state: this.stateAddress.address,
        owner,
        payer,
        removedPosition: removedPositionAddress,
        positionList: positionListAddress,
        lastPosition: lastPositionAddress,
        pool: poolAddress,
        tickmap: state.tickmap,
        lowerTick: lowerTickAddress,
        upperTick: upperTickAddress,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        accountX: userTokenX,
        accountY: userTokenY,
        reserveX: state.tokenXReserve,
        reserveY: state.tokenYReserve,
        programAuthority: this.programAuthority.address,
        tokenXProgram,
        tokenYProgram,
        eventOptAcc: this.getEventOptAccount(poolAddress).address
      })
      .instruction()
  }

  async removePositionTx(removePosition: RemovePosition, cache: RemovePositionCache = {}) {
    const ix = await this.removePositionIx(removePosition, cache)
    return new Transaction().add(ix)
  }

  async removePosition(
    removePosition: RemovePosition,
    signer: Keypair,
    cache: RemovePositionCache = {}
  ) {
    const tx = await this.removePositionTx(removePosition, cache)

    await signAndSend(tx, [signer], this.connection)
  }

  async transferPositionOwnershipIx(
    transferPositionOwnership: TransferPositionOwnership,
    cache: TransferPositionCache = {}
  ): Promise<TransactionInstruction> {
    const { index } = transferPositionOwnership
    const owner = transferPositionOwnership.owner ?? this.wallet.publicKey
    const recipient = transferPositionOwnership.recipient ?? this.wallet.publicKey

    const { positionListAddress: ownerListAddress } = this.getPositionListAddress(owner)
    const { positionListAddress: recipientListAddress } = this.getPositionListAddress(recipient)
    const [ownerPositionList, recipientPositionList] = await Promise.all([
      cache.ownerPositionList ?? (await this.getPositionList(owner)),
      cache.recipientPositionList ?? (await this.getPositionList(recipient))
    ])

    const { positionAddress: newPosition } = this.getPositionAddress(
      recipient,
      recipientPositionList.head
    )

    const { positionAddress: removedPosition } = this.getPositionAddress(owner, index)
    const { positionAddress: lastPosition } = this.getPositionAddress(
      owner,
      ownerPositionList.head - 1
    )

    return this.program.methods
      .transferPositionOwnership(index)
      .accounts({
        payer: owner,
        owner,
        recipient,
        ownerList: ownerListAddress,
        recipientList: recipientListAddress,
        lastPosition,
        removedPosition,
        newPosition,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async transferPositionOwnershipTx(
    transferPositionOwnership: TransferPositionOwnership,
    cache: TransferPositionCache = {}
  ) {
    const ix = await this.transferPositionOwnershipIx(transferPositionOwnership, cache)
    return new Transaction().add(ix)
  }

  async transferPositionOwnership(
    transferPositionOwnership: TransferPositionOwnership,
    signer: Keypair,
    cache: TransferPositionCache = {}
  ) {
    const tx = await this.transferPositionOwnershipTx(transferPositionOwnership, cache)

    await signAndSend(tx, [signer], this.connection)
  }

  async updateSecondsPerLiquidityIx(updateSecondsPerLiquidity: UpdateSecondsPerLiquidity) {
    const { pair, signer, lowerTickIndex, upperTickIndex, index } = updateSecondsPerLiquidity
    const owner = updateSecondsPerLiquidity.owner ?? this.wallet.publicKey

    const { tickAddress: lowerTickAddress } = this.getTickAddress(pair, lowerTickIndex)
    const { tickAddress: upperTickAddress } = this.getTickAddress(pair, upperTickIndex)
    const poolAddress = pair.getAddress(this.program.programId)
    const { positionAddress } = this.getPositionAddress(owner, index)

    return this.program.methods
      .updateSecondsPerLiquidity(lowerTickIndex, upperTickIndex, index)
      .accounts({
        pool: poolAddress,
        lowerTick: lowerTickAddress,
        upperTick: upperTickAddress,
        position: positionAddress,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        owner,
        signer: signer ?? owner,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async updateSecondsPerLiquidityTx(updateSecondsPerLiquidity: UpdateSecondsPerLiquidity) {
    const ix = await this.updateSecondsPerLiquidityIx(updateSecondsPerLiquidity)
    return new Transaction().add(ix)
  }

  async updateSecondsPerLiquidity(
    updateSecondsPerLiquidity: UpdateSecondsPerLiquidity,
    signer: Keypair
  ) {
    const tx = await this.updateSecondsPerLiquidityTx(updateSecondsPerLiquidity)

    await signAndSend(tx, [signer], this.connection)
  }

  async initializeOracle(pair: Pair, payer: Keypair) {
    const oracleKeypair = Keypair.generate()
    const tx = await this.initializeOracleTx(pair, oracleKeypair, payer)

    return signAndSend(tx, [payer, oracleKeypair], this.connection)
  }

  async initializeOracleTx(pair: Pair, oracleKeypair: Keypair, payer: Keypair) {
    const initAccount = await this.program.account.oracle.createInstruction(oracleKeypair)
    const initOracleIx = await this.initializeOracleIx(pair, oracleKeypair.publicKey, payer)

    const tx = new Transaction().add(initAccount).add(initOracleIx)
    return tx
  }

  async initializeOracleIx(pair: Pair, oraclePublicKey: PublicKey, payer: Keypair) {
    const poolAddress = pair.getAddress(this.program.programId)

    return this.program.methods
      .initializeOracle()
      .accounts({
        pool: poolAddress,
        oracle: oraclePublicKey,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        payer: payer.publicKey,
        rent: SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId
      })
      .instruction()
  }

  async getOracle(pair: Pair, pool?: { oracleAddress: PublicKey }) {
    pool = pool ?? (await this.getPool(pair))
    return this.program.account.oracle.fetch(pool.oracleAddress)
  }

  async changeProtocolFeeIx(changeProtocolFee: ChangeProtocolFee) {
    let { pair, admin, protocolFee } = changeProtocolFee
    admin = admin ?? this.wallet.publicKey

    const poolAddress = pair.getAddress(this.program.programId)

    return this.program.methods
      .changeProtocolFee({ v: protocolFee })
      .accounts({
        state: this.stateAddress.address,
        pool: poolAddress,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        admin,
        programAuthority: this.programAuthority.address
      })
      .instruction()
  }

  async changeProtocolFeeTx(changeProtocolFee: ChangeProtocolFee) {
    const ix = await this.changeProtocolFeeIx(changeProtocolFee)
    return new Transaction().add(ix)
  }

  async changeProtocolFee(changeProtocolFee: ChangeProtocolFee, signer: Keypair) {
    const tx = await this.changeProtocolFeeTx(changeProtocolFee)

    await signAndSend(tx, [signer], this.connection)
  }

  async changeFeeReceiverIx(changeFeeReceiver: ChangeFeeReceiver) {
    const { pair, feeReceiver } = changeFeeReceiver
    const adminPubkey = changeFeeReceiver.admin ?? this.wallet.publicKey
    const poolAddress = pair.getAddress(this.program.programId)

    return this.program.methods
      .changeFeeReceiver()
      .accounts({
        state: this.stateAddress.address,
        pool: poolAddress,
        tokenX: pair.tokenX,
        tokenY: pair.tokenY,
        admin: adminPubkey,
        feeReceiver: feeReceiver
      })
      .instruction()
  }

  async changeFeeReceiverTx(changeFeeReceiver: ChangeFeeReceiver) {
    const ix = await this.changeFeeReceiverIx(changeFeeReceiver)

    return new Transaction().add(ix)
  }

  async changeFeeReceiver(changeFeeReceiver: ChangeFeeReceiver, signer: Keypair) {
    const tx = await this.changeFeeReceiverTx(changeFeeReceiver)

    await signAndSend(tx, [signer], this.connection)
  }

  async getWholeLiquidity(pair: Pair) {
    const poolPublicKey = pair.getAddress(this.program.programId)
    const positions: Position[] = (
      await this.program.account.position.all([
        {
          memcmp: { bytes: bs58.encode(poolPublicKey.toBuffer()), offset: 40 }
        }
      ])
    ).map(a => parsePosition(a.account)) as Position[]
    let liquidity = new BN(0)
    for (const position of positions) {
      liquidity = liquidity.add(position.liquidity)
    }

    return liquidity
  }

  async getGlobalFee(pair: Pair, pool?: PoolStructure) {
    pool = pool ?? (await this.getPool(pair))
    const { feeProtocolTokenX, feeProtocolTokenY, protocolFee } = pool

    const feeX = feeProtocolTokenX.mul(DENOMINATOR).div(protocolFee)
    const feeY = feeProtocolTokenY.mul(DENOMINATOR).div(protocolFee)

    return { feeX, feeY }
  }

  async getVolume(pair: Pair, pool?: PoolStructure) {
    pool = pool ?? (await this.getPool(pair))
    const { feeProtocolTokenX, feeProtocolTokenY, protocolFee, fee } = pool

    const feeDenominator = protocolFee.mul(fee).div(DENOMINATOR)

    const volumeX = feeProtocolTokenX.mul(DENOMINATOR).div(feeDenominator)
    const volumeY = feeProtocolTokenY.mul(DENOMINATOR).div(feeDenominator)

    return { volumeX, volumeY }
  }

  async getAllPools() {
    return (await this.program.account.pool.all([])).map(({ account }) =>
      parsePool(account)
    ) as PoolStructure[]
  }

  async getPairLiquidityValues(pair: Pair, cachedPool?: PoolStructure) {
    const poolPublicKey = pair.getAddress(this.program.programId)
    const [pool, allPositions] = await Promise.all([
      cachedPool ?? this.getPool(pair),
      this.program.account.position.all([
        {
          memcmp: { bytes: bs58.encode(poolPublicKey.toBuffer()), offset: 40 }
        }
      ])
    ])
    const positions: Position[] = (allPositions.map(({ account }) => account) as RawPosition[]).map(
      v => {
        return parsePosition(v)
      }
    )

    let liquidityX = new BN(0)
    let liquidityY = new BN(0)
    for (const position of positions) {
      let xVal, yVal

      try {
        xVal = getX(
          position.liquidity,
          calculatePriceSqrt(position.upperTickIndex),
          pool.sqrtPrice,
          calculatePriceSqrt(position.lowerTickIndex)
        )
      } catch (error) {
        xVal = new BN(0)
      }

      try {
        yVal = getY(
          position.liquidity,
          calculatePriceSqrt(position.upperTickIndex),
          pool.sqrtPrice,
          calculatePriceSqrt(position.lowerTickIndex)
        )
      } catch (error) {
        yVal = new BN(0)
      }

      liquidityX = liquidityX.add(xVal)
      liquidityY = liquidityY.add(yVal)
    }

    return { liquidityX, liquidityY }
  }
}

export const parseTick = (tick: RawTick): Tick => {
  let parsedTick: Tick = {
    feeGrowthOutsideX: tick.feeGrowthOutsideX.v,
    feeGrowthOutsideY: tick.feeGrowthOutsideY.v,
    liquidityChange: tick.liquidityChange.v,
    liquidityGross: tick.liquidityGross.v,
    secondsPerLiquidityOutside: tick.secondsPerLiquidityOutside.v,
    sqrtPrice: tick.sqrtPrice.v,
    pool: tick.pool,
    sign: tick.sign,
    bump: tick.bump,
    index: tick.index
  }
  return parsedTick
}

export const parsePosition = (position: RawPosition): Position => {
  let parsedPosition: Position = {
    feeGrowthInsideX: position.feeGrowthInsideX.v,
    feeGrowthInsideY: position.feeGrowthInsideY.v,
    liquidity: position.liquidity.v,
    secondsPerLiquidityInside: position.secondsPerLiquidityInside.v,
    tokensOwedX: position.tokensOwedX.v,
    tokensOwedY: position.tokensOwedY.v,
    owner: position.owner,
    pool: position.pool,
    id: position.id,
    lowerTickIndex: position.lowerTickIndex,
    upperTickIndex: position.upperTickIndex,
    lastSlot: position.lastSlot,
    bump: position.bump
  }
  return parsedPosition
}

export const parsePool = (pool: RawPoolStructure): any => {
  let parsedPool: any = {
    tokenX: pool.tokenX,
    tokenY: pool.tokenY,
    tokenXReserve: pool.tokenXReserve,
    tokenYReserve: pool.tokenYReserve,
    positionIterator: pool.positionIterator,
    tickSpacing: pool.tickSpacing,
    fee: pool.fee.v,
    protocolFee: pool.protocolFee.v,
    liquidity: pool.liquidity.v,
    sqrtPrice: pool.sqrtPrice.v,
    currentTickIndex: pool.currentTickIndex,
    tickmap: pool.tickmap,
    feeGrowthGlobalX: pool.feeGrowthGlobalX.v,
    feeGrowthGlobalY: pool.feeGrowthGlobalY.v,
    feeProtocolTokenX: pool.feeProtocolTokenX,
    feeProtocolTokenY: pool.feeProtocolTokenY,
    secondsPerLiquidityGlobal: pool.secondsPerLiquidityGlobal.v,
    startTimestamp: pool.startTimestamp,
    lastTimestamp: pool.lastTimestamp,
    feeReceiver: pool.feeReceiver,
    oracleAddress: pool.oracleAddress,
    oracleInitialized: pool.oracleInitialized,
    bump: pool.bump
  }

  return parsedPool as unknown
}

export const parseFeeTier = (feeTier: RawFeeTierStructure): FeeTier => {
  let parsedFeeTier: FeeTier = {
    fee: feeTier.fee.v,
    tickSpacing: feeTier.tickSpacing
  }
  return parsedFeeTier
}

export interface AddressAndBump {
  address: PublicKey
  bump: number
}

export interface Decimal {
  v: BN
}

export interface State {
  admin: PublicKey
  nonce: number
  authority: PublicKey
  bump: number
}

export interface RawFeeTierStructure {
  fee: Decimal
  tickSpacing: number
  bump: number
}

export interface FeeTierStructure {
  fee: BN
  tickSpacing: number
  bump: number
}

export interface RawPoolStructure {
  tokenX: PublicKey
  tokenY: PublicKey
  tokenXReserve: PublicKey
  tokenYReserve: PublicKey
  positionIterator: BN
  tickSpacing: number
  fee: Decimal
  protocolFee: Decimal
  liquidity: Decimal
  sqrtPrice: Decimal
  currentTickIndex: number
  tickmap: PublicKey
  feeGrowthGlobalX: Decimal
  feeGrowthGlobalY: Decimal
  feeProtocolTokenX: BN
  feeProtocolTokenY: BN
  secondsPerLiquidityGlobal: Decimal
  startTimestamp: BN
  lastTimestamp: BN
  feeReceiver: PublicKey
  oracleAddress: PublicKey
  oracleInitialized: boolean
  bump: number
}

export interface PoolStructure {
  tokenX: PublicKey
  tokenY: PublicKey
  tokenXReserve: PublicKey
  tokenYReserve: PublicKey
  positionIterator: BN
  tickSpacing: number
  fee: BN
  protocolFee: BN
  liquidity: BN
  sqrtPrice: BN
  currentTickIndex: number
  tickmap: PublicKey
  feeGrowthGlobalX: BN
  feeGrowthGlobalY: BN
  feeProtocolTokenX: BN
  feeProtocolTokenY: BN
  secondsPerLiquidityGlobal: BN
  startTimestamp: BN
  lastTimestamp: BN
  feeReceiver: PublicKey
  oracleAddress: PublicKey
  oracleInitialized: boolean
  bump: number
}

export interface PoolData {
  currentTickIndex: number
  tickSpacing: number
  liquidity: BN
  fee: BN
  sqrtPrice: BN
}
export interface Tickmap {
  bitmap: number[]
}
export interface TickPosition {
  byte: number
  bit: number
}
export interface PositionList {
  head: number
  bump: number
}

export interface RawTick {
  pool: PublicKey
  index: number
  sign: boolean
  liquidityChange: Decimal
  liquidityGross: Decimal
  sqrtPrice: Decimal
  feeGrowthOutsideX: Decimal
  feeGrowthOutsideY: Decimal
  secondsPerLiquidityOutside: Decimal
  bump: number
}

export interface Tick {
  pool: PublicKey
  index: number
  sign: boolean
  liquidityChange: BN
  liquidityGross: BN
  sqrtPrice: BN
  feeGrowthOutsideX: BN
  feeGrowthOutsideY: BN
  secondsPerLiquidityOutside: BN
  bump: number
}

export interface RawPosition {
  owner: PublicKey
  pool: PublicKey
  id: BN
  liquidity: Decimal
  lowerTickIndex: number
  upperTickIndex: number
  feeGrowthInsideX: Decimal
  feeGrowthInsideY: Decimal
  secondsPerLiquidityInside: Decimal
  lastSlot: BN
  tokensOwedX: Decimal
  tokensOwedY: Decimal
  bump: number
}

export interface LockedPosition extends Omit<PositionStructure, 'lowerPrice' | 'upperPrice'> {
  pool: PublicKey
  id: BN
}
export interface Position {
  owner: PublicKey
  pool: PublicKey
  id: BN
  liquidity: BN
  lowerTickIndex: number
  upperTickIndex: number
  feeGrowthInsideX: BN
  feeGrowthInsideY: BN
  secondsPerLiquidityInside: BN
  lastSlot: BN
  tokensOwedX: BN
  tokensOwedY: BN
  bump: number
}

export interface PositionStructure {
  tokenX: PublicKey
  tokenY: PublicKey
  feeTier: FeeTier
  amountTokenX: BN
  amountTokenY: BN
  lowerPrice: BN
  upperPrice: BN
  unclaimedFeesX: BN
  unclaimedFeesY: BN
}

export interface FeeTier {
  fee: BN
  tickSpacing: number
}

export enum Errors {
  ZeroAmount = '0x12c', // 0
  ZeroOutput = '0x12d', // 1
  WrongTick = '0x12e', // 2
  WrongLimit = '0x12f', // 3
  InvalidTickSpacing = '0x130', // 4
  InvalidTickInterval = '0x131', // 5
  NoMoreTicks = '0x132 ', // 6
  TickNotFound = '0x133', // 7
  PriceLimitReached = '0x134', // 8
  RangeLimitReached = '0x135', // 9
  TickArrayIsEmpty = '0x136', // 10
  TickArrayAreTheSame = '0x137' // 11
}

export interface CreatePosition {
  pair: Pair
  owner?: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  lowerTick: number
  upperTick: number
  liquidityDelta: BN
  knownPrice: BN
  slippage: BN
}

export interface ChangeLiquidity {
  pair: Pair
  knownPrice: BN
  slippage: BN
  index: number
  lowerTickIndex?: number
  upperTickIndex?: number
  liquidityDelta: BN
  addLiquidity: boolean
  owner?: PublicKey
  accountX: PublicKey
  accountY: PublicKey
}

export interface CreatePoolAndPosition extends CreatePosition {
  initTick?: number
}

export interface CreatePoolTx {
  pair: Pair
  payer?: { publicKey: PublicKey }
  initTick?: number
}
export interface CreatePool extends CreatePoolTx {
  payer: Keypair
}

export interface CreatePoolWithSqrtPriceTx {
  pair: Pair
  payer?: { publicKey: PublicKey }
  initSqrtPrice?: BN
}
export interface CreatePoolWithSqrtPrice extends CreatePoolWithSqrtPriceTx {
  payer: Keypair
}

export interface ClaimAllFee {
  positions: ClaimAllFeePosition[]
  owner?: PublicKey
}

export interface ClaimAllFeePosition {
  pair: Pair
  index: number
  lowerTickIndex: number
  upperTickIndex: number
}

export interface ClaimFee {
  pair: Pair
  owner?: PublicKey
  userTokenX: PublicKey
  userTokenY: PublicKey
  index: number
}
export interface Swap {
  pair: Pair
  owner?: PublicKey
  xToY: boolean
  amount: BN
  estimatedPriceAfterSwap: BN
  slippage: BN
  accountX: PublicKey
  accountY: PublicKey
  byAmountIn: boolean
  referralAccount?: PublicKey
}

export interface UpdateSecondsPerLiquidity {
  pair: Pair
  owner?: PublicKey
  signer?: PublicKey
  lowerTickIndex: number
  upperTickIndex: number
  index: number
}

export interface ChangeProtocolFee {
  pair: Pair
  admin?: PublicKey
  protocolFee: BN
}
export interface CreateFeeTier {
  feeTier: FeeTier
  admin?: PublicKey
}
export interface CreateTick {
  pair: Pair
  index: number
  payer?: PublicKey
}
export interface WithdrawProtocolFee {
  pair: Pair
  accountX: PublicKey
  accountY: PublicKey
  admin?: PublicKey
}
export interface RemovePosition {
  pair: Pair
  owner: PublicKey
  payer?: PublicKey
  index: number
  userTokenX: PublicKey
  userTokenY: PublicKey
}
export interface TransferPositionOwnership {
  owner?: PublicKey
  recipient?: PublicKey
  index: number
}

export interface ChangeFeeReceiver {
  pair: Pair
  admin?: PublicKey
  feeReceiver: PublicKey
}

export interface PositionInitData {
  lowerTick: number
  upperTick: number
  liquidity: BN
  amountX: BN
  amountY: BN
}

export interface PositionWithAddress extends Position {
  address: PublicKey
}

export interface PositionListCache {
  initialized: boolean
  head: number
}

export interface CreatePositionInstructionCache {
  pool?: TickmapWithReserves
  positionList?: PositionListCache
  tokenXProgramAddress?: PublicKey
  tokenYProgramAddress?: PublicKey
}

export interface CreatePositionTransactionCache extends CreatePositionInstructionCache {
  lowerTickExists?: boolean
  upperTickExists?: boolean
}

export interface CreateTickInstructionCache {
  pool?: { tickmap: PublicKey }
  tokenXProgramAddress?: PublicKey
  tokenYProgramAddress?: PublicKey
}

export interface CreatePoolCache {
  tokenXProgramAddress?: PublicKey
  tokenYProgramAddress?: PublicKey
}

export interface CreatePoolAndPositionCache extends CreatePoolCache {
  positionList?: PositionListCache
}

export interface SwapCache {
  tickmap?: Tickmap
  pool?: PoolStructure
  tokenXProgram?: PublicKey
  tokenYProgram?: PublicKey
}

export interface ClaimFeeCache {
  position?: Position
  pool?: PoolStructure
  tokenXProgram?: PublicKey
  tokenYProgram?: PublicKey
}

export interface WithdrawProtocolFeeCache {
  pool?: PoolStructure
  tokenXProgram?: PublicKey
  tokenYProgram?: PublicKey
}

export interface RemovePositionCache {
  pool?: PoolStructure
  position?: Position
  positionList?: PositionListHead
  tokenXProgram?: PublicKey
  tokenYProgram?: PublicKey
}

export interface TransferPositionCache {
  ownerPositionList?: PositionListHead
  recipientPositionList?: PositionListHead
}

export interface TickmapWithReserves {
  tokenXReserve: PublicKey
  tokenYReserve: PublicKey
  tickmap: PublicKey
}

export interface PositionListHead {
  head: number
}

export interface RemovePositionEvent {
  owner: PublicKey
  pool: PublicKey
  id: BN
  liquidity: BN
  upperTick: number
  lowerTick: number
  currentTick: number
  upperTickSecondsPerLiquidityOutside: BN
  lowerTickSecondsPerLiquidityOutside: BN
  poolSecondsPerLiquidityGlobal: BN
  currentTimestamp: BN
}

export interface CreatePositionEvent {
  owner: PublicKey
  pool: PublicKey
  id: BN
  liquidity: BN
  upperTick: number
  lowerTick: number
  currentTimestamp: BN
  secondsPerLiquidityInsideInitial: BN
}

export interface SwapEvent {
  swapper: PublicKey
  tokenX: PublicKey
  tokenY: PublicKey
  xToY: boolean
  fee: BN
  priceBeforeSwap: BN
  priceAfterSwap: BN
}
type TickAddresses = {
  tickAddresses: PublicKey[]
  tickCrosses?: never
}

type TickIndexes = {
  tickIndexes: number[]
  tickCrosses?: never
}

type TickCrosses = {
  tickCrosses: number
  tickAddresses?: never
  tickIndexes?: never
}

type Ticks = NonNullable<TickAddresses | TickCrosses>
type TickIndexesOrCrosses = NonNullable<TickIndexes | TickCrosses>

export type SwapAndCreatePosition = Omit<CreatePosition, 'pair' | 'knownPrice'> &
  Pick<Swap, 'amount' | 'byAmountIn' | 'estimatedPriceAfterSwap' | 'xToY' | 'referralAccount'> & {
    swapPair: Pair
    minUtilizationPercentage: BN
    amountX: BN
    amountY: BN
    swapAndCreateOnDifferentPools?: {
      positionPair: Pair
      positionPoolPrice: BN
      positionSlippage: BN
    }
  }

export type SwapAndCreatePositionInstructionCache = {
  position?: CreatePositionInstructionCache
  swap?: Omit<SwapCache, 'tokenXProgram' | 'tokenYProgram'>
}

export type SwapAndCreatePositionTransactionCache = {
  position?: CreatePositionTransactionCache
  swap?: Omit<SwapCache, 'tokenXProgram' | 'tokenYProgram'>
}
