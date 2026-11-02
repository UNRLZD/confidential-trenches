// What Verify checks on each NEAR network, as the release names it: the pair of RPCs it reads (one FastNEAR URL and the
// network's dRPC URL, the kit's nearPairRule) and the pins it judges against (read.ts VerifyPins). The build names its
// network (VITE_NEAR_NETWORK at build time, build/network.mjs; mainnet when unset). test/verify-mount.test.ts holds the
// testnet pins to contracts/vault/deployments/testnet-v1.json and testnet-usdc.json, and each pair to the kit's rule.
import { VAULT_TOKEN_CODE_HASH, type NearNetwork } from "@blindfill/kit";
import type { VerifyPins } from "./read.ts";

export type VerifyRelease = {
  network: NearNetwork;
  /** The two RPCs Verify reads, each by the exact URL the pair rule names. */
  rpcs: readonly [string, string];
  /** null until the release names a vault on this network: nothing is read and every check is Unverified. */
  pins: VerifyPins | null;
};

export const VERIFY_RELEASES: Readonly<Record<NearNetwork, VerifyRelease>> = Object.freeze({
  // mainnet: the vault is deployed at the freeze (Nov 7); until the release names it, Verify reads nothing
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
});

/** The network this build names: VITE_NEAR_NETWORK, set by the build (build/network.mjs refuses any other value). */
export function buildNetwork(value: unknown = import.meta.env?.VITE_NEAR_NETWORK): NearNetwork {
  return value === "testnet" ? "testnet" : "mainnet";
}
