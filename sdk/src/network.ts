export enum Network {
  LOCAL,
  DEV,
  TEST,
  MAIN
}

export const getMarketAddress = (network: Network) => {
  switch (network) {
    case Network.LOCAL:
      return '8HJq6TfDVvZQJWu2RzjvV9W1yNkJNCng2iYQWCxkp7bL'
    case Network.DEV:
      return '8HJq6TfDVvZQJWu2RzjvV9W1yNkJNCng2iYQWCxkp7bL'
    case Network.TEST:
      return '8HJq6TfDVvZQJWu2RzjvV9W1yNkJNCng2iYQWCxkp7bL'
    case Network.MAIN:
      return '8HJq6TfDVvZQJWu2RzjvV9W1yNkJNCng2iYQWCxkp7bL'
    default:
      throw new Error('Unknown network')
  }
}

export const MOCK_TOKENS = {
  USDC: '5ihkgQGjKvWvmMtywTgLdwokZ6hqFv5AgxSyYoCNufQW',
  USDT: '4cZv7KgYNgmr3NZSDhT5bhXGGttXKTndqyXeeC1cB6Xm',
  SOL: 'BJVjNqQzM1fywLWzzKbQEZ2Jsx9AVyhSLWzko3yF68PH',
  MSOL: '4r8WDEvBntEr3dT69p7ua1rsaWcpTSHnKpY5JugDkcPQ',
  WSOL: 'So11111111111111111111111111111111111111112',
  BTC: '4gGKgUYvGkCT62Cu1zfPspuR7VPNPYrigXFmF9KTPji8',
  REN_DOGE: 'ArjgPxuQgaGXU16XSdBPDsCit7nxjAKR5Gvtvb2oFZUZ',
  USDH: '41dDByBv1Z6mCHCp4FJeZNP8MPiviUpFz2AdzJYRszzv',
  HBB: 'EBuKgNDiUonDYML2CZXCRQKnE982hnt6AhaxXVZZoCyo',
  S22: 'Bo6ufYtZ7rRtVX2VryazbYjZSgHExfpXST9Xo3Vd3CyA'
}

export const MAINNET_TOKENS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  UST: '9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i',
  UXD: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', //wormhole
  WSOL: 'So11111111111111111111111111111111111111112',
  BTC: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E', //sollet
  HBB: 'HBB111SCo9jkCejsZfz8Ec8nH7T6THF8KEKSnvwT6XK6',
  USDH: 'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX'
}
