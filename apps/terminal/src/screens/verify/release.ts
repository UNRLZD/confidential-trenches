// What Verify checks on each NEAR network, as the release names it: the pair of RPCs it reads (one FastNEAR URL and the
// network's dRPC URL, the kit's nearPairRule) and the pins it judges against (read.ts VerifyPins). The build names its
// network (VITE_NEAR_NETWORK at build time, build/network.mjs; mainnet when unset). Each network's pins are its vault's
// deploy record, contracts/vault/deployments/<network>-v1.json (vault = account_id, asset = asset, release =
// code_hash), and null exactly while that record does not exist; scripts/live-checks/app-verify-mount.test.mjs holds
// them to it, and test/verify-mount.test.ts holds each pair to the kit's rule.
//
// Each network's pools (card verify-pools): the pool program and the EVM pools as their deploy records name them, null
// exactly while a network names none. Mainnet: contracts/pool-solana/deployments/mainnet.json (program = program_id,
// programdata, codeLen = so_len, codeSha256 = so_sha256) and contracts/pool-evm/deployments/<chain>.json (address =
// contracts.PrivacyPoolSimple.address); each EVM code hash is the keccak256 of that address's eth_getCode in
// scripts/live-checks/pool-evm-deploy-mainnet.answers.json (the deploy's read-back), the same on both of its RPCs.
// scripts/live-checks/verify-pools.test.mjs holds every pin to those files. Each pair is two operators the kit lists
// for the chain: Solana's public RPC (the kit's SOLANA_PUBLIC_RPC_URL) and publicnode, the pair the pool's deploy check
// reads (pool-sol-deploy.mjs MAINNET_RPCS); each EVM chain's feeProviders (evmPoolVenues()), which keep state back.
import { VAULT_TOKEN_CODE_HASH, type NearNetwork } from "@blindfill/kit";
import type { PoolPins } from "./pools.ts";
import type { VerifyPins } from "./read.ts";

export type VerifyRelease = {
  network: NearNetwork;
  /** The two RPCs Verify reads, each by the exact URL the pair rule names. */
  rpcs: readonly [string, string];
  /** null until the release names a vault on this network: nothing is read and every check is Unverified. */
  pins: VerifyPins | null;
  /** Each pool the network names, or null on a chain where it names none (its row is Unverified, nothing read). */
  pools: PoolPins;
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
    pools: {
      solana: {
        chain: "solana",
        rpcs: ["https://api.mainnet-beta.solana.com", "https://solana-rpc.publicnode.com"],
        pin: {
          program: "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", // gitleaks:allow (a public program id)
          programdata: "EuoumSLYMugNL6TsEKRby4bYXH4EcEgwASFdWhWNBQxM", // gitleaks:allow (a public account id)
          codeLen: 79088,
          codeSha256: "c86fc7fc1b442851c660c5ec0c4f3c4ad8648a5965b5a0da59189fbf0fdb5162", // gitleaks:allow (a public code hash)
        },
      },
      base: {
        chain: "base",
        rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
        pin: {
          address: "0xaa080e74ec99cf5c684548c77ca145edfcf899cf", // gitleaks:allow (a public contract address)
          codeHash: "0xcac5a62a0ac95b9dd1323c57a2561fe3eb56292c82c5d3a5390c95e522ff786d", // gitleaks:allow (a public code hash)
        },
      },
      robinhood: {
        chain: "robinhood",
        rpcs: ["https://robinhood.drpc.org", "https://rpc.mainnet.chain.robinhood.com"],
        pin: {
          address: "0x9306359433127c4f3be426f6faeb00a3c41f66db", // gitleaks:allow (a public contract address)
          codeHash: "0x4052383ebda1543cc4e9d8f51a03cdc631f4562d763c60508ef870189f8747c7", // gitleaks:allow (a public code hash)
        },
      },
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
    // the testnet build names no pool yet: each row is Unverified and reads nothing
    pools: { solana: null, base: null, robinhood: null },
  },
};
// Frozen all the way down (as the kit's NEAR_NETWORKS), so no code on the page can point Verify at another vault or RPC.
for (const r of Object.values(VERIFY_RELEASES)) {
  Object.freeze(r.rpcs);
  if (r.pins) Object.freeze(r.pins);
  for (const p of Object.values(r.pools)) {
    if (!p) continue;
    Object.freeze(p.rpcs);
    Object.freeze(p.pin);
    Object.freeze(p);
  }
  Object.freeze(r.pools);
  Object.freeze(r);
}
Object.freeze(VERIFY_RELEASES);

/** The network this build names: VITE_NEAR_NETWORK, set by the build (build/network.mjs refuses any other value). */
export function buildNetwork(value: unknown = import.meta.env?.VITE_NEAR_NETWORK): NearNetwork {
  return value === "testnet" ? "testnet" : "mainnet";
}
