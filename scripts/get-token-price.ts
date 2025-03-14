import { Market, Network } from '@invariant-labs/sdk/src'
import { Provider } from '@coral-xyz/anchor'

require('dotenv').config()

const provider = Provider.local('https://api.testnet.sonic.game ', {
  skipPreflight: true
})
const connection = provider.connection

const main = async () => {
  const market = await Market.buildWithoutProvider(Network.MAIN, connection)

  const laika = await market.getCurrentTokenStats(
    'LaihKXA47apnS599tyEyasY2REfEzBNe4heunANhsMx',
    'So11111111111111111111111111111111111111112',
    2500
  )
  console.log(laika)

  const turbo = await market.getCurrentTokenStats(
    'trbts2EsWyMdnCjsHUFBKLtgudmBD7Rfbz8zCg1s4EK',
    'So11111111111111111111111111111111111111112',
    2500
  )
  console.log(turbo)
}

main()
