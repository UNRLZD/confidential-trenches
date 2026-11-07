// What Verify checks on each NEAR network, as the release names it: the pair of RPCs it reads (one FastNEAR URL and the
// network's dRPC URL, the kit's nearPairRule) and the pins it judges against (read.ts VerifyPins). The build names its
// network (VITE_NEAR_NETWORK at build time, build/network.mjs; mainnet when unset). Each network's pins are its vault's
// deploy record, contracts/vault/deployments/<network>-v1.json (vault = account_id, asset = asset, release =
// code_hash), and null exactly while that record does not exist; scripts/live-checks/app-verify-mount.test.mjs holds
// them to it, and test/verify-mount.test.ts holds each pair to the kit's rule.
import { VAULT_TOKEN_CODE_HASH, type NearNetwork } from "@blindfill/kit";
import type { VerifyPins } from "./read.ts";

export type VerifyRelease = {
  network: NearNetwork;
  /** The two RPCs Verify reads, each by the exact URL the pair rule names. */
  rpcs: readonly [string, string];
  /** null until the release names a vault on this network: nothing is read and every check is Unverified. */
  pins: VerifyPins | null;
};

export const VERIFY_RELEASES: Readonly<Record<NearNetwork, VerifyRelease>> = {
  // mainnet: contracts/vault/deployments/mainnet-v1.json (the keyless vault deployed 7 Nov); its asset is Circle's USDC,
  // whose code is the kit's VAULT_TOKEN_CODE_HASH and whose ft_metadata reads USDC, 6 decimals (rpc.mainnet.fastnear.com
  // and near.drpc.org, blocks 223495331 and 223495333)
  mainnet: {
    network: "mainnet",
    rpcs: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
    pins: {
      vault: "vault.confidential.unrlzd.near", // gitleaks:allow (a public account id)
      asset: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // gitleaks:allow (a public account id)
      release: "C5fk3Fr9XZwSeDbu9Nc6pTMpYrWiKgBXVzJaK2mAzG3u", // gitleaks:allow (a public code hash)
      assetRelease: VAULT_TOKEN_CODE_HASH,
      assetSymbol: "USDC",
      assetDecimals: 6,
    },
  },
  testnet: {
    network: "testnet",
    rpcs: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"], // the kit's testnet pair
    pins: {
      vault: "vault.bf-vt-20261102t071444.testnet", // gitleaks:allow (a public account id)
      asset: "bf-usdc-20261101t022248.testnet", // gitleaks:allow (a public account id)
      release: "CXer6tYxd9w2Bgdcz1g2vGJTFoj927goSLscRCtgyEhc", // gitleaks:allow (a public code hash)
      assetRelease: VAULT_TOKEN_CODE_HASH,
      assetSymbol: "USDC",
      assetDecimals: 6,
    },
  },
};
// Frozen all the way down (as the kit's NEAR_NETWORKS), so no code on the page can point Verify at another vault or RPC.
for (const r of Object.values(VERIFY_RELEASES)) {
  Object.freeze(r.rpcs);
  if (r.pins) Object.freeze(r.pins);
  Object.freeze(r);
}
Object.freeze(VERIFY_RELEASES);

/** The network this build names: VITE_NEAR_NETWORK, set by the build (build/network.mjs refuses any other value). */
export function buildNetwork(value: unknown = import.meta.env?.VITE_NEAR_NETWORK): NearNetwork {
  return value === "testnet" ? "testnet" : "mainnet";
}
