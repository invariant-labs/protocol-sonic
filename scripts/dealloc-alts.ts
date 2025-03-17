import { AnchorProvider } from '@coral-xyz/anchor'
import { AddressLookupTableProgram, PublicKey, Transaction } from '@solana/web3.js'
import { signAndSend } from '@invariant-labs/sdk'

// trunk-ignore(eslint/@typescript-eslint/no-var-requires)
require('dotenv').config()

const provider = AnchorProvider.local('https://api.testnet.sonic.game', {
  skipPreflight: true
})
const connection = provider.connection
// @ts-expect-error
const wallet = provider.wallet.payer as Keypair
const ALTS_ADDRESSES: string[] = [
  //   '3PFDBtyAk1UdjxUSnXMLNfZH3HyyN6ejbUWdudpKrEw8',
  //   'FWpRSYA7pETYUWG1eWpatMbM3ZE9RZcJkjMFzyqR6dFx',
]
const authority = new PublicKey('7zwsfwpnrxLHA65hzWMZfRtRDva9VjDRrMFWMjp5ZtRi')
const main = async () => {
  //   for (const pubkey of ALTS_ADDRESSES) {
  //     const ix = AddressLookupTableProgram.deactivateLookupTable({
  //       authority,
  //       lookupTable: new PublicKey(pubkey)
  //     })

  //     const tx = new Transaction().add(ix)

  //     await signAndSend(tx, [wallet], connection)
  //   }

  for (const pubkey of ALTS_ADDRESSES) {
    console.log(pubkey)
    try {
      const ix = AddressLookupTableProgram.closeLookupTable({
        authority,
        lookupTable: new PublicKey(pubkey),
        recipient: authority
      })

      const tx = new Transaction().add(ix)

      await signAndSend(tx, [wallet], connection)
    } catch {
      console.log('Error closing table', pubkey)
    }
  }
}
// trunk-ignore(eslint/@typescript-eslint/no-floating-promises)
main()
