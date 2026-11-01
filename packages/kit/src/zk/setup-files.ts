// The six Privacy Pools v1 setup files of packages/kit/zk/, pinned by size and sha256 (docs/plan1/vault.md 2.6).
// The prover, the vault's key constants and the relayer's Groth16 check read these bytes, and each checks a file's
// sha256 against this list before it uses it. A file is served at /assets/zk/<sha256>.<ext>.
// Source: github.com/0xbow-io/privacy-pools-core, tag v1.3.0, under packages/circuits/ (licences: packages/kit/zk/NOTICE).

export const ZK_SETUP_SOURCE = {
  repo: "https://github.com/0xbow-io/privacy-pools-core",
  tag: "v1.3.0",
  commit: "c312dcd58f6ad085204be61923c49f8065e4e9ae",
  dir: "packages/circuits",
} as const;

export const ZK_SETUP_FILES = {
  "withdraw.wasm": { bytes: 2607967, sha256: "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10", path: "build/withdraw/withdraw_js/withdraw.wasm" },
  "withdraw.zkey": { bytes: 17793015, sha256: "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677", path: "trusted-setup/final-keys/withdraw.zkey" },
  "withdraw.vkey": { bytes: 4208, sha256: "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e", path: "trusted-setup/final-keys/withdraw.vkey" },
  "commitment.wasm": { bytes: 2380442, sha256: "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8", path: "build/commitment/commitment_js/commitment.wasm" },
  "commitment.zkey": { bytes: 901233, sha256: "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3", path: "trusted-setup/final-keys/commitment.zkey" },
  "commitment.vkey": { bytes: 3477, sha256: "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8", path: "trusted-setup/final-keys/commitment.vkey" },
} as const;

export type ZkSetupFileName = keyof typeof ZK_SETUP_FILES;
