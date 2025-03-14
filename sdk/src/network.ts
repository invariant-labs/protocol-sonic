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

export const getInvariantAutoswapAddress = (network: Network) => {
  switch (network) {
    case Network.LOCAL:
      return 'BdexSTDwoK29CUbzi1arkAWEHG98owYY1DgeWiCpGHEh'
    case Network.DEV:
      return 'BdexSTDwoK29CUbzi1arkAWEHG98owYY1DgeWiCpGHEh'
    case Network.TEST:
      return 'BdexSTDwoK29CUbzi1arkAWEHG98owYY1DgeWiCpGHEh'
    case Network.MAIN:
      return 'BdexSTDwoK29CUbzi1arkAWEHG98owYY1DgeWiCpGHEh'
    default:
      throw new Error('Unknown network')
  }
}

export const MOCK_TOKENS = {
  USDC: '2QYThuyCoSHJH6ZEbbqj1ZHc397fQ5xnHCdeEAfu8nGL',
  SOL: '8bE8wsnfsjFvzJzQCTgPVEzVktWBVDpK1aisCvZAgPQw',
  BTC: 'CsHREb2WNe6zcUL9TxjRQmuvB1EUF9fDuPM3Qy8SqQBs',
  WSOL: 'So11111111111111111111111111111111111111112'
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
