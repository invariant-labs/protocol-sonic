<div align="center">
    <h1>⚡Invariant protocol⚡</h1>
    <p>
        <a href="https://discord.com/invite/w6hTeWTJvG">DISCORD 🌐</a> |
    </p>
</div>

Invariant protocol is an AMM built on [Sonic](https://www.sonic.game/), leveraging high capital efficiency and the ability to list markets in a permissionless manner. At the core of the DEX is the Concentrated Liquidity mechanism, designed to handle tokens compatible with the [SPL token](https://spl.solana.com/token) and [Token 2022](https://spl.solana.com/token-2022) standards. The protocol is structured around a single contract architecture.

## 🔨 Getting Started

### Prerequisites

- Rust & Cargo ([rustup](https://www.rust-lang.org/tools/install))
- Solana & Anchor ([Solana & Anchor](https://solana.com/docs/intro/installation))

#### Rust & Cargo

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

#### Solana

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.18/install)"
```

#### Anchor

```bash
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.29.0
avm use 0.29.0
```

### Build protocol

- Clone repository

```bash
git clone git@github.com:invariant-labs/protocol-sonic.git
```

- Build contract

```bash
npm run program
```

- Run tests

```bash
cargo test
```

### Typescript SDK

Utilize the Invariant SDK from the npm registry by including it as a dependency. Alternatively, for a customized approach, build the SDK on your own using the commands provided below:

To begin, navigate to the directory dedicated to the [SDK](https://github.com/invariant-labs/protocol-sonic/tree/main/sdk)

- Build SDK

```bash
cd ./sdk
npm i
npm run build
```

- Run e2e tests

```bash
npm run test:all
```

Check out the [sdk usage guide](https://github.com/invariant-labs/protocol-sonic/tree/main/tests/integration-example.spec.ts)
