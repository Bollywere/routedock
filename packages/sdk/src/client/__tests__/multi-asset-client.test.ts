import assert from 'node:assert/strict'
import { describe, it, mock, afterEach } from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockTrustlineError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

function makeMultiAssetManifest(payeeKeypair: Keypair): RouteDockManifest {
  return signManifest(
    {
      routedock: '1.0',
      name: 'Multi-Asset Client Test Service',
      description: 'Provider for client mode-to-asset testing',
      modes: ['x402', 'mpp-charge'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['x402'],
        },
        {
          asset: 'XLM',
          asset_contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          modes: ['mpp-charge'],
        },
      ],
      payee: payeeKeypair.publicKey(),
      pricing: {
        x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: ['test'],
    },
    payeeKeypair.secret(),
  )
}

describe('RouteDockClient — multi-asset eligibility & trustline preflight', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('preflight without mode falls back to root asset (USDC)', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: TESTNET_USDC_ISSUER,
          balance: '100.0000000',
        },
      ],
    }))

    const client = new RouteDockClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const result = await client.preflight(manifest)
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'USDC')
  })

  it('preflight for mpp-charge checks and passes native XLM asset', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    // Account only has native XLM balance, NO USDC trustline
    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'native',
          balance: '50.0000000',
        },
      ],
    }))

    const client = new RouteDockClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    const result = await client.preflight(manifest, 'mpp-charge')
    assert.equal(result.hasTrustline, true)
    assert.equal(result.asset, 'XLM')
  })

  it('preflight for x402 throws RouteDockTrustlineError when account lacks USDC trustline', async () => {
    const payeeKeypair = Keypair.random()
    const payerKeypair = Keypair.random()
    const manifest = makeMultiAssetManifest(payeeKeypair)

    // Account only has native XLM balance
    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'native',
          balance: '50.0000000',
        },
      ],
    }))

    const client = new RouteDockClient({
      network: 'testnet',
      wallet: payerKeypair,
    })

    await assert.rejects(
      () => client.preflight(manifest, 'x402'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockTrustlineError)
        assert.equal(err.asset, 'USDC')
        return true
      },
    )
  })
})
