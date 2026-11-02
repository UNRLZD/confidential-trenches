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
  // mainnet: until the mainnet vault is deployed and its record written, Verify reads nothing there
  mainnet: { network: "mainnet", rpcs: ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"], pins: null },
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
