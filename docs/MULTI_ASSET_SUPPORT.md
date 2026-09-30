# Multi-Asset Support in RouteDock Manifests

This document describes the multi-asset manifest specification in RouteDock, enabling providers to advertise different payment assets and contracts for different payment modes and endpoints, while maintaining full backward compatibility with single-asset manifests.

---

## 1. Overview & Problem

RouteDock manifests historically exposed a single root-level asset pair:

```json
{
  "asset": "USDC",
  "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
}
```

This single-asset model prevented a provider from advertising different assets for different payment modes or endpoints. For instance:
- `x402` (facilitator-backed per-request) settled in `USDC`
- `mpp-charge` (direct settlement) settled in native `XLM`
- Different endpoints requiring distinct tokens

Autonomous agents holding only XLM had no way to discover eligibility before attempting payment, leading to unnecessary payment failures.

Multi-asset support solves this by introducing an optional `assets` array to the manifest schema, allowing fine-grained scoping per payment mode and per endpoint.

---

## 2. Manifest Schema

### Root Fields & Backward Compatibility

To preserve 100% backward compatibility for existing clients and tooling:
- Root `asset` (string) and `asset_contract` (string) remain **required**.
- An optional `assets` array is added: `assets?: AssetConfig[]`.
- `assets[0]` serves as the canonical primary asset and **must strictly match** the root `asset` and `asset_contract`.

```json
{
  "routedock": "1.0",
  "name": "Market Intelligence API",
  "description": "Multi-mode intelligence provider",
  "modes": ["x402", "mpp-charge"],
  "network": "testnet",
  "asset": "USDC",
  "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "assets": [
    {
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "modes": ["x402"],
      "endpoints": ["inference", "analytics"]
    },
    {
      "asset": "XLM",
      "asset_contract": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "modes": ["mpp-charge"],
      "endpoints": ["lookup"]
    }
  ],
  "payee": "G...",
  "pricing": {
    "x402": { "amount": "0.001", "per": "request" },
    "mpp-charge": { "amount": "0.0008", "per": "request" }
  },
  "endpoints": {
    "inference": { "method": "POST", "path": "/infer" },
    "analytics": { "method": "GET", "path": "/stats" },
    "lookup": { "method": "GET", "path": "/lookup" }
  },
  "tags": ["ai", "analytics"]
}
```

### `AssetConfig` Interface

```ts
export interface AssetConfig {
  /** Asset ticker symbol, e.g. "USDC" or "XLM" */
  asset: string
  /** Stellar Asset Contract (SAC) address for this payment asset */
  asset_contract: string
  /** Optional: restrict this asset to specific payment modes. If omitted, available for all modes. */
  modes?: PaymentMode[]
  /** Optional: restrict this asset to specific endpoints (by name). If omitted, available for all endpoints. */
  endpoints?: string[]
}
```

---

## 3. Validation Rules

Validation is enforced by `assertManifestValid()` in `@routedock/routedock/client`:

1. **Legacy manifests without `assets`**:
   Continue to validate successfully against the draft-07 JSON schema and semantic checks.
2. **Multi-asset manifests with `assets`**:
   - `assets` must be a non-empty array (`minItems: 1`).
   - Every entry must define non-empty `asset` and `asset_contract` strings.
   - `assets[0].asset` must equal root `asset`.
   - `assets[0].asset_contract` must equal root `asset_contract`.
   - Any mismatch causes `assertManifestValid()` to throw a typed `RouteDockManifestError`.

---

## 4. Normalization and Eligibility Utilities

RouteDock exports canonical helper functions:

```ts
import {
  normalizeManifestAssets,
  getEligibleAssets,
  selectAsset,
  isAssetEligible,
} from '@routedock/routedock'
```

### `normalizeManifestAssets(manifest)`
Normalizes any manifest to always produce an `AssetConfig[]` array. For legacy manifests without `assets`, returns a single-item array `[{ asset: manifest.asset, asset_contract: manifest.asset_contract }]`.

### `getEligibleAssets(manifest, mode, endpoint?)`
Filters assets for a given payment mode and optional endpoint (matched by endpoint key name, path, or full URL).

### `selectAsset(manifest, mode, endpoint?)`
Returns the first matching `AssetConfig` for the specified mode and endpoint. Throws `RouteDockManifestError` if no eligible assets exist.

### `isAssetEligible(manifest, assetIdentifier, mode, endpoint?)`
Checks whether a given asset ticker or contract address is accepted for the specified mode and endpoint.

---

## 5. Mode → Asset Selection in Provider Adapters

All three provider adapters automatically resolve the correct asset contract per mode using `selectAsset(manifest, mode).asset_contract`:

- **Express (`routedock`)**:
  `x402`, `mpp-charge`, and `mpp-session` handlers each receive the asset contract scoped to their payment mode.
- **Fastify (`routedockFastify`)**:
  Same per-mode asset resolution with automatic Fastify reply hijacking for challenge/settlement.
- **Hono (`routedockHono`)**:
  Cloudflare Workers and edge runtimes route each mode to its corresponding asset contract.

In all adapters, `asset` and `assetContract` middleware options are now optional when `manifest` is provided.

---

## 6. Client Trustline Preflight

`RouteDockClient` avoids blindly assuming the root asset:

- **`client.preflight(manifest, mode?, endpoint?)`**:
  Selects the eligible asset for `mode` and runs the trustline preflight against that asset. Native assets like `XLM` are verified against the account's native balance.
- **`client.pay(url, options?)`**:
  Resolves mode, determines the mode-scoped eligible asset, verifies the trustline for that asset, and executes payment.
- **`client.estimateCost(url, options?)`**:
  Returns `asset` matching the selected eligible asset for the chosen payment mode.

---

## 7. Manifest Signing & Security

RouteDock manifest signing v2 (`signManifest` / `verifyManifestSignature`) recursively sorts and canonicalizes object keys at every depth.

Because `canonicalize()` maps nested arrays and canonicalizes each inner object, all entries in the `assets` array are fully protected by the Ed25519 signature. Modifying any nested property (e.g. `assets[1].asset_contract`) causes `verifyManifestSignature()` to reject the manifest with `RouteDockSignatureError`.
