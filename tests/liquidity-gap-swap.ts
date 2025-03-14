import { PoolData, Tick } from '@invariant-labs/sdk/lib/market'
import { SimulateSwapInterface, toPercent } from '@invariant-labs/sdk/src/utils'
import { BN } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'

const ticks: Map<number, Tick> = new Map([
  [
    -3010,
    {
      pool: Keypair.generate().publicKey,
      index: -3010,
      sign: true,
      liquidityChange: new BN('20008000000000'),
      liquidityGross: new BN('20008000000000'),
      sqrtPrice: new BN('860284203230000000000000'),
      feeGrowthOutsideX: new BN(0),
      feeGrowthOutsideY: new BN(0),
      secondsPerLiquidityOutside: new BN(0),
      bump: 255
    }
  ],
  [
    -2990,
    {
      pool: Keypair.generate().publicKey,
      index: -2990,
      sign: false,
      liquidityChange: new BN('20008000000000'),
      liquidityGross: new BN('20008000000000'),
      sqrtPrice: new BN('861144874664000000000000'),
      feeGrowthOutsideX: new BN(0),
      feeGrowthOutsideY: new BN(0),
      secondsPerLiquidityOutside: new BN(0),
      bump: 255
    }
  ],
  [
    -10,
    {
      pool: Keypair.generate().publicKey,
      index: -10,
      sign: true,
      liquidityChange: new BN('20006000000000') ,
      liquidityGross: new BN('20006000000000') ,
      sqrtPrice: new BN('999500149965000000000000'),
      feeGrowthOutsideX: new BN(0),
      feeGrowthOutsideY: new BN(0),
      secondsPerLiquidityOutside: new BN(0),

      bump: 255
    }
  ],
  [
    10,
    {
      pool: Keypair.generate().publicKey,
      index: 10,
      sign: false,
      liquidityChange: new BN('20006000000000') ,
      liquidityGross: new BN('20006000000000'),
      sqrtPrice: new BN('1000500100010000000000000'),
      feeGrowthOutsideX: new BN(0) ,
      feeGrowthOutsideY: new BN(0) ,
      secondsPerLiquidityOutside: new BN(0),
      bump: 255
    }
  ]
])

const poolData: PoolData = {
  currentTickIndex: -10,
  tickSpacing: 10,
  liquidity: new BN('20006000000000'),
  fee: new BN('6000000000') ,
  sqrtPrice: new BN('999500149965000000000000')
}

const bitmap = new Array(11091).fill(0)
bitmap[5507] = 128
bitmap[5508] = 2
bitmap[5545] = 40

export const swapParameters: SimulateSwapInterface = {
  xToY: true,
  byAmountIn: true,
  swapAmount: new BN(5000),
  priceLimit: new BN('999500149965000000000000'),
  slippage: toPercent(3, 1),
  ticks: ticks,
  tickmap: { bitmap },
  pool: poolData,
}
