import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/charge/client'
import { Mppx } from 'mppx/client'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import {
  RouteDockManifestError,
  httpStatusToError,
  wrapMppError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'

export class MppChargeClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    private readonly retryPolicy?: RetryPolicy,
  ) {}

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing['mpp-charge']
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.mpp-charge missing')
    }

    let txHash: string | null = null
    // The credential is created at most once per pay() call. Every retry after
    // the first reuses it, so the provider's idempotency store can replay the
    // cached settlement instead of charging a second time.
    let credential: string | undefined

    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        stellar.charge({
          keypair: this.keypair,
          mode: 'pull',
          onProgress(event) {
            if (event.type === 'paid') {
              txHash = event.hash
            }
          },
        }),
      ],
      onChallenge: async (_challenge, { createCredential }) => {
        credential ??= await createCredential()
        return credential
      },
    })

    return withRetry(async (): Promise<PaymentResult> => {
      let response: Response
      try {
        response = credential
          ? await mppx.rawFetch(url, { headers: { Authorization: credential } })
          : await mppx.fetch(url)
      } catch (err) {
        throw wrapMppError(err, 'MPP charge request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `MPP charge failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw new RouteDockManifestError(`MPP charge failed: HTTP ${response.status}`)
      }

      let data: unknown
      try {
        data = await response.json()
      } catch (cause) {
        throw new RouteDockManifestError(
          `Failed to parse JSON from response (HTTP ${response.status})`,
          { cause },
        )
      }
      return { data, txHash, mode: 'mpp-charge', amount: pricing.amount, timestamp: Date.now() }
    }, this.retryPolicy)
  }
}
