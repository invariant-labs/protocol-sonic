import { AnchorProvider, BN } from '@coral-xyz/anchor'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { Network } from '@invariant-labs/sdk/src/network'
import { Market, Pair } from '@invariant-labs/sdk/src'
import { calculateClaimAmount } from '@invariant-labs/sdk/src/utils'
import { getBalance, parseLiquidityOnTicks } from '@invariant-labs/sdk/lib/utils'
import { bs58 } from '@coral-xyz/anchor/dist/cjs/utils/bytes'
import { PoolStructure, Position } from '@invariant-labs/sdk/src/market'
import { assert } from 'chai'
import { getDeltaX } from '@invariant-labs/sdk/lib/math'
import { calculatePriceSqrt } from '@invariant-labs/sdk'
import { getDeltaY } from '@invariant-labs/sdk/src/math'
import { parsePool, parsePosition } from '@invariant-labs/sdk/lib/market'
import { sleep } from '@invariant-labs/sdk'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMultipleAccounts,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const skipValidation: string[] = [
  '4G2nGTzgeADytq5Fm9GU1Yo1YN131eQShNK7LMMenvca' // BUBBLY_BEAR/ETH at 0.01%
]

const onlyValidation: string[] = []

const provider = AnchorProvider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})

export const addressTickerMap: { [key: string]: string } = {
  ETH: 'So11111111111111111111111111111111111111112',
  USDC: 'AKEWE7Bgh87GPp171b4cJPSSZfmZwQ3KaqYqXoKLNAEE',
  tETH: 'GU7NS9xCwgNPiAdJ69iusFrRfawjDDPjeMBovhV1d4kn',
  WIF: '841P4tebEgNux2jaWSjCoi9LhrVr9eHGjLc758Va3RPH',
  MOON: 'HgD4Dc6qYCj3UanMDiuC4qANheeTsAvk6DY91B3F8gnL',
  LAIKA: 'LaihKXA47apnS599tyEyasY2REfEzBNe4heunANhsMx',
  SOL: 'BeRUj3h7BqkbdfFU7FBNYbodgf8GCHodzKvF9aVjNNfL',
  USDT: 'CEBP3CqAbW4zdZA57H2wfaSG1QNdzQ72GiQEbQXyW9Tm',
  SOLAR: 'CwrZKtPiZJrAK3tTjNPP22rD9VzeoxQv8iHd6EeyNoze',
  kySOL: '8jN7xMDqJucigQphWHvqAPQPAmk7VJKKsqLmgCkE7XzP',
  BUBBLY_BEAR: '4Pn37WzDxeMkMA9UamcyK8jL1AW5oxYq5NjttDhLBVsF'
}

export const reversedAddressTickerMap = Object.fromEntries(
  Object.entries(addressTickerMap).map(([key, value]) => [value, key])
)

export const addressToTicker = (address: string): string => {
  return reversedAddressTickerMap[address] || address
}

const connection = provider.connection

const fetchAllTokenPrograms = async (pools: PoolStructure[]) => {
  console.log('Fetching tokens')
  const tokenToProgramId = new Map<string, PublicKey>()
  const tokens = [...pools.map(pool => [pool.tokenX.toString(), pool.tokenY.toString()]).flat(1)]
  const unique = Array.from(new Set(tokens))
  console.log(`Total amount of tokens: ${unique.length}`)
  const uniquePubkeys = unique.map(item => new PublicKey(item))
  const accountInfos = await connection.getMultipleParsedAccounts(uniquePubkeys)
  await sleep(500)
  console.log(`Fetched ${accountInfos.value.length} token accounts`)
  for (const [idx, val] of accountInfos.value.entries()) {
    if (!val) {
      throw new Error(`Error fetching Token Info for: ${uniquePubkeys[idx].toString()}`)
    }
    tokenToProgramId.set(uniquePubkeys[idx].toString(), val.owner)
  }
  return tokenToProgramId
}

const simulateWithdrawal = (position: Position, pool: PoolStructure) => {
  if (pool.currentTickIndex < position.lowerTickIndex) {
    return [
      getDeltaX(
        calculatePriceSqrt(position.lowerTickIndex),
        calculatePriceSqrt(position.upperTickIndex),
        position.liquidity,
        false
      ) ?? new BN(0),
      new BN(0)
    ]
  } else if (pool.currentTickIndex < position.upperTickIndex) {
    return [
      getDeltaX(
        pool.sqrtPrice,
        calculatePriceSqrt(position.upperTickIndex),
        position.liquidity,
        false
      ) ?? new BN(0),
      getDeltaY(
        calculatePriceSqrt(position.lowerTickIndex),
        pool.sqrtPrice,
        position.liquidity,
        false
      ) ?? new BN(0)
    ]
  } else {
    return [
      new BN(0),
      getDeltaY(
        calculatePriceSqrt(position.lowerTickIndex),
        calculatePriceSqrt(position.upperTickIndex),
        position.liquidity,
        false
      ) ?? new BN(0)
    ]
  }
}

const getAllPoolsNecessaryData = async (
  market: Market
): Promise<{ address: PublicKey; tokenXProgram: PublicKey; tokenYProgram: PublicKey }[]> => {
  if (onlyValidation.length > 0) {
    const pools: PoolStructure[] = (
      await market.program.account.pool.fetchMultiple(
        onlyValidation.map(item => new PublicKey(item))
      )
    ).map(item => parsePool(item as any))
    await sleep(500)
    const tokenPrograms = await fetchAllTokenPrograms(pools)
    await sleep(500)
    const data = pools.map((item, idx) => {
      const tokenXProgram = tokenPrograms.get(item.tokenX.toString())
      const tokenYProgram = tokenPrograms.get(item.tokenY.toString())
      if (!tokenXProgram || !tokenYProgram) {
        throw new Error(`No token program for ${item.tokenX} or ${item.tokenY}`)
      }
      return {
        address: new PublicKey(onlyValidation[idx]),
        tokenXProgram,
        tokenYProgram
      }
    })
    return data
  }
  const skipPublicKeys = new Set(skipValidation.map(address => address))

  const pools: { address: PublicKey; data: PoolStructure }[] = (
    await market.program.account.pool.all([])
  )
    .map(item => {
      return { address: item.publicKey, data: parsePool(item.account) }
    })
    .filter(item => !skipPublicKeys.has(item.address.toString()))
  await sleep(500)

  const poolDatas = pools.map(item => item.data)
  const tokenPrograms = await fetchAllTokenPrograms(poolDatas)
  await sleep(500)

  const data = pools.map(item => {
    const tokenXProgram = tokenPrograms.get(item.data.tokenX.toString())
    const tokenYProgram = tokenPrograms.get(item.data.tokenY.toString())
    if (!tokenXProgram || !tokenYProgram) {
      throw new Error(`No token program for ${item.data.tokenX} or ${item.data.tokenY}`)
    }
    return {
      address: item.address,
      tokenXProgram,
      tokenYProgram
    }
  })
  return data
}

const fetchAllPosition = async (market: Market, poolAddress: PublicKey) => {
  return (
    await market.program.account.position.all([
      {
        memcmp: { bytes: bs58.encode(poolAddress.toBuffer()), offset: 40 }
      }
    ])
  ).map(({ account }) => parsePosition(account)) as Position[]
}

const getLatestTxHash = async (programId: PublicKey) => {
  const [signature] = await connection.getSignaturesForAddress(programId, { limit: 1 }, 'finalized')
  return signature.signature
}

const getSinglePoolData = async (
  market: Market,
  poolAddress: PublicKey,
  tokenXProgram: PublicKey,
  tokenYProgram: PublicKey,
  previousTxHash: string
) => {
  let retries = 0
  let txHash = previousTxHash
  while (retries < 25) {
    try {
      const pool: PoolStructure = await market.getPoolByAddress(poolAddress)

      const pair = new Pair(pool.tokenX, pool.tokenY, {
        fee: pool.fee,
        tickSpacing: pool.tickSpacing
      })

      const sameTokenPrograms = tokenXProgram.equals(tokenYProgram)

      const [ticks, positions, reserveAccounts] = await Promise.all([
        market.getAllTicks(pair),
        fetchAllPosition(market, poolAddress),
        sameTokenPrograms
          ? getMultipleAccounts(
              connection,
              [pool.tokenXReserve, pool.tokenYReserve],
              'finalized',
              tokenXProgram
            )
          : Promise.all([
              getAccount(connection, pool.tokenXReserve, 'finalized', tokenXProgram),
              getAccount(connection, pool.tokenYReserve, 'finalized', tokenYProgram)
            ])
      ])

      const tokenXReserveAccount = reserveAccounts.find(acc =>
        acc.address.equals(pool.tokenXReserve)
      )!
      const tokenYReserveAccount = reserveAccounts.find(acc =>
        acc.address.equals(pool.tokenYReserve)
      )!

      const reserves = {
        x: new BN(tokenXReserveAccount.amount.toString()),
        y: new BN(tokenYReserveAccount.amount.toString())
      }

      const txHashesBetween = (
        await connection.getSignaturesForAddress(
          market.program.programId,
          { until: txHash },
          'finalized'
        )
      ).map(item => item.signature)
      await sleep(500)

      if (txHashesBetween.length === 0) {
        console.log(`Pool ${poolAddress}: consistency check passed with txHash ${txHash}`)
        await sleep(500)
        return { pool, ticks, positions, reserves, newTxHash: txHash }
      }

      console.log(`Txs during fetch: ${txHashesBetween.length}`)
      const parsedTxs = (
        await connection.getParsedTransactions(txHashesBetween, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0
        })
      ).filter(item => item !== null)

      console.log(`Parsed txs fetched: ${parsedTxs.length}`)

      const ignoreSet = new Set([
        market.program.programId.toBase58(),
        SystemProgram.programId.toBase58(),
        TOKEN_PROGRAM_ID.toBase58(),
        ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
        TOKEN_2022_PROGRAM_ID.toBase58()
      ])

      const pdaSet: Set<string> = new Set()
      for (let tx of parsedTxs) {
        const accountKeys = tx.transaction.message.accountKeys
        for (let acc of accountKeys) {
          const pubkeyStr = acc.pubkey.toBase58()
          if (ignoreSet.has(pubkeyStr)) continue
          if (!PublicKey.isOnCurve(acc.pubkey.toBytes())) {
            pdaSet.add(acc.pubkey.toString())
          }
        }
      }
      const pdaArray: string[] = Array.from(pdaSet)
      const refetchNeeded = pdaArray.some(pda => pda === poolAddress.toString())
      if (!refetchNeeded) {
        console.log(`Pool ${poolAddress}: consistency check passed, (tx did not affect pool state)`)
        await sleep(500)
        return { pool, ticks, positions, reserves, newTxHash: txHashesBetween[0] }
      } else {
        retries++
        console.log(
          `Pool ${poolAddress}: txHash mismatched and affected pools. Retrying ${retries}/25...`
        )
        await sleep(7000)
        txHash = await getLatestTxHash(market.program.programId)
        await sleep(3000)
      }
    } catch (e) {
      retries++
      console.log(`[ERROR]: ${e}. Retrying...`)
      await sleep(7000)
      txHash = await getLatestTxHash(market.program.programId)
      await sleep(3000)
    }
  }
  throw new Error(`Amount of retries exceeded`)
}

const printWrongPools = (
  xInvalid: { address: string; amount: BN; tokenX: PublicKey; tokenY: PublicKey; fee: BN }[],
  yInvalid: { address: string; amount: BN; tokenX: PublicKey; tokenY: PublicKey; fee: BN }[]
) => {
  for (const { address, amount, tokenX, tokenY, fee } of xInvalid) {
    console.log(
      `There is not enough x token at pool (${address.toString()}) ${addressToTicker(
        tokenX.toString()
      )}/${addressToTicker(tokenY.toString())} at ${
        Number(fee.divn(1e7).toString()) / 10e2
      }%, we are lacking ${amount.toString()}`
    )
  }
  for (const { address, amount, tokenX, tokenY, fee } of yInvalid) {
    console.log(
      `There is not enough y token at pool (${address.toString()}) ${addressToTicker(
        tokenX.toString()
      )}/${addressToTicker(tokenY.toString())} at ${
        Number(fee.divn(1e7).toString()) / 10e2
      }%, we are lacking ${amount.toString()}`
    )
  }
}

const main = async () => {
  const market = Market.build(Network.MAIN, provider.wallet, connection)
  let xInvalid: { address: string; amount: BN; tokenX: PublicKey; tokenY: PublicKey; fee: BN }[] =
    []
  let yInvalid: { address: string; amount: BN; tokenX: PublicKey; tokenY: PublicKey; fee: BN }[] =
    []
  const poolsData = await getAllPoolsNecessaryData(market)
  let txHash: string = await getLatestTxHash(market.program.programId)
  for (const [index, { address, tokenXProgram, tokenYProgram }] of poolsData.entries()) {
    console.log(`[${index + 1}] Pool address: ${address.toString()}`)
    const singlePoolData = await getSinglePoolData(
      market,
      address,
      tokenXProgram,
      tokenYProgram,
      txHash
    )
    const { pool, ticks, positions, reserves, newTxHash } = singlePoolData
    txHash = newTxHash
    console.log(
      `Token address: ${addressToTicker(pool.tokenX.toString())}/${addressToTicker(
        pool.tokenY.toString()
      )} at ${Number(pool.fee.divn(1e7).toString()) / 10e2}%`
    )

    const pair = new Pair(pool.tokenX, pool.tokenY, {
      fee: pool.fee,
      tickSpacing: pool.tickSpacing
    })

    const expectedAddress = pair.getAddress(market.program.programId)
    assert.equal(expectedAddress.toString(), address.toString())

    // checking liquidity
    const parsed = parseLiquidityOnTicks(ticks).map(({ index, liquidity }) => ({
      liquidity: liquidity.toString(),
      index
    }))
    if (parsed.length !== 0) {
      const lastBelow = parsed.reduce(
        (acc, { index, liquidity }) => (index <= pool.currentTickIndex ? liquidity : acc),
        parsed[0].liquidity
      )
      assert.ok(lastBelow, pool.liquidity.toString())
    }

    ticks.forEach(({ index, liquidityChange, sign }) => {
      const positionsAbove = positions.filter(({ lowerTickIndex }) => lowerTickIndex === index)
      const positionsBelow = positions.filter(({ upperTickIndex }) => upperTickIndex === index)

      const sumOnPositionsBelow = positionsBelow.reduce(
        (acc, { liquidity: v }) => acc.add(v),
        new BN(0)
      )
      const sumOnPositionsAbove = positionsAbove.reduce(
        (acc, { liquidity: v }) => acc.add(v),
        new BN(0)
      )

      assert.equal(
        sumOnPositionsAbove.sub(sumOnPositionsBelow).toString(),
        liquidityChange.muln(sign ? 1 : -1).toString()
      )
    })

    const sumOfPositions = positions.reduce(
      (acc, position) => {
        const result = simulateWithdrawal(position, pool)

        const tickLower = ticks.find(({ index }) => index === position.lowerTickIndex)
        const tickUpper = ticks.find(({ index }) => index === position.upperTickIndex)

        if (!tickLower || !tickUpper) {
          throw new Error('Didnt fetch all ticks')
        }
        const claim = calculateClaimAmount({
          position,
          tickLower,
          tickUpper,
          tickCurrent: pool.currentTickIndex,
          feeGrowthGlobalX: pool.feeGrowthGlobalX,
          feeGrowthGlobalY: pool.feeGrowthGlobalY
        })

        return [acc[0].add(result[0]).add(claim[0]), acc[1].add(result[1]).add(claim[1])]
      },
      [new BN(0), new BN(0)]
    )

    console.log('sumOfPositions:', ...sumOfPositions.map(i => i.toString()))

    console.log('reserve balances:', reserves.x.toString(), reserves.y.toString())
    if (!sumOfPositions[0].lte(reserves.x as any)) {
      xInvalid.push({
        address: address.toString(),
        amount: sumOfPositions[0].sub(reserves.x),
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        fee: pool.fee
      })
      console.log('**************')
      console.log('*X IS INVALID*')
      console.log('**************')
    }
    if (!sumOfPositions[1].lte(reserves.y as any)) {
      yInvalid.push({
        address: address.toString(),
        amount: sumOfPositions[1].sub(reserves.y),
        tokenX: pool.tokenX,
        tokenY: pool.tokenY,
        fee: pool.fee
      })
      console.log('**************')
      console.log('*Y IS INVALID*')
      console.log('**************')
    }

    console.log('---------------------\n')
  }

  if (xInvalid.length === 0 && yInvalid.length === 0) {
    console.log('All pools looking good!')
  } else {
    printWrongPools(xInvalid, yInvalid)
  }
}

// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
