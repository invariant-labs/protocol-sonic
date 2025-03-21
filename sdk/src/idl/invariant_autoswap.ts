export type InvariantAutoswap = {
  "version": "0.1.0",
  "name": "invariant_autoswap",
  "instructions": [
    {
      "name": "swapAndCreatePosition",
      "accounts": [
        {
          "name": "invariant",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "state",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "position",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionPool",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapPool",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionList",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "lowerTick",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "upperTick",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionTickmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapTickmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenX",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenY",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "accountX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "accountY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionReserveX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionReserveY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapReserveX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapReserveY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "programAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenXProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenYProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "rent",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "eventOptAcc",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "lowerTickIndex",
          "type": "i32"
        },
        {
          "name": "upperTickIndex",
          "type": "i32"
        },
        {
          "name": "swapAmount",
          "type": "u64"
        },
        {
          "name": "xToY",
          "type": "bool"
        },
        {
          "name": "sqrtPriceLimit",
          "type": {
            "defined": "PriceInterface"
          }
        },
        {
          "name": "byAmountIn",
          "type": "bool"
        },
        {
          "name": "amountX",
          "type": "u64"
        },
        {
          "name": "amountY",
          "type": "u64"
        },
        {
          "name": "minLiquidityDelta",
          "type": {
            "defined": "LiquidityInterface"
          }
        },
        {
          "name": "slippageLimitLower",
          "type": {
            "defined": "PriceInterface"
          }
        },
        {
          "name": "slippageLimitUpper",
          "type": {
            "defined": "PriceInterface"
          }
        }
      ]
    }
  ],
  "types": [
    {
      "name": "PriceInterface",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "v",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "LiquidityInterface",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "v",
            "type": "u128"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "InvalidTokenAccount",
      "msg": "Provided token account is different than expected"
    },
    {
      "code": 6001,
      "name": "InvalidOwner",
      "msg": "Admin address is different than expected"
    },
    {
      "code": 6002,
      "name": "InvalidMint",
      "msg": "Provided token account mint is different than expected mint token"
    },
    {
      "code": 6003,
      "name": "InvalidTickmap",
      "msg": "Provided tickmap is different than expected"
    },
    {
      "code": 6004,
      "name": "InvalidTickmapOwner",
      "msg": "Provided tickmap owner is different than program ID"
    },
    {
      "code": 6005,
      "name": "LiquidityBelowMinimum",
      "msg": "Position liquidity would be lower than provided limit"
    },
    {
      "code": 6006,
      "name": "SwapDisabled",
      "msg": "Swapping with swap and create position was not enabled for this pool"
    },
    {
      "code": 6007,
      "name": "InvalidTokenAmountAfterSwap",
      "msg": "Not enough tokens to create a position after swap"
    },
    {
      "code": 6008,
      "name": "CreatePositionDisabled",
      "msg": "Creating a position with swap and create position was disabled for this pool"
    },
    {
      "code": 6009,
      "name": "InvalidAuthority",
      "msg": "Provided authority is different than expected"
    }
  ]
};

export const IDL: InvariantAutoswap = {
  "version": "0.1.0",
  "name": "invariant_autoswap",
  "instructions": [
    {
      "name": "swapAndCreatePosition",
      "accounts": [
        {
          "name": "invariant",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "state",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "position",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionPool",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapPool",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionList",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "owner",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "lowerTick",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "upperTick",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionTickmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapTickmap",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "tokenX",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenY",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "accountX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "accountY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionReserveX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "positionReserveY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapReserveX",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "swapReserveY",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "programAuthority",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenXProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenYProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "rent",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "eventOptAcc",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "lowerTickIndex",
          "type": "i32"
        },
        {
          "name": "upperTickIndex",
          "type": "i32"
        },
        {
          "name": "swapAmount",
          "type": "u64"
        },
        {
          "name": "xToY",
          "type": "bool"
        },
        {
          "name": "sqrtPriceLimit",
          "type": {
            "defined": "PriceInterface"
          }
        },
        {
          "name": "byAmountIn",
          "type": "bool"
        },
        {
          "name": "amountX",
          "type": "u64"
        },
        {
          "name": "amountY",
          "type": "u64"
        },
        {
          "name": "minLiquidityDelta",
          "type": {
            "defined": "LiquidityInterface"
          }
        },
        {
          "name": "slippageLimitLower",
          "type": {
            "defined": "PriceInterface"
          }
        },
        {
          "name": "slippageLimitUpper",
          "type": {
            "defined": "PriceInterface"
          }
        }
      ]
    }
  ],
  "types": [
    {
      "name": "PriceInterface",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "v",
            "type": "u128"
          }
        ]
      }
    },
    {
      "name": "LiquidityInterface",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "v",
            "type": "u128"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "InvalidTokenAccount",
      "msg": "Provided token account is different than expected"
    },
    {
      "code": 6001,
      "name": "InvalidOwner",
      "msg": "Admin address is different than expected"
    },
    {
      "code": 6002,
      "name": "InvalidMint",
      "msg": "Provided token account mint is different than expected mint token"
    },
    {
      "code": 6003,
      "name": "InvalidTickmap",
      "msg": "Provided tickmap is different than expected"
    },
    {
      "code": 6004,
      "name": "InvalidTickmapOwner",
      "msg": "Provided tickmap owner is different than program ID"
    },
    {
      "code": 6005,
      "name": "LiquidityBelowMinimum",
      "msg": "Position liquidity would be lower than provided limit"
    },
    {
      "code": 6006,
      "name": "SwapDisabled",
      "msg": "Swapping with swap and create position was not enabled for this pool"
    },
    {
      "code": 6007,
      "name": "InvalidTokenAmountAfterSwap",
      "msg": "Not enough tokens to create a position after swap"
    },
    {
      "code": 6008,
      "name": "CreatePositionDisabled",
      "msg": "Creating a position with swap and create position was disabled for this pool"
    },
    {
      "code": 6009,
      "name": "InvalidAuthority",
      "msg": "Provided authority is different than expected"
    }
  ]
};
