// The wallet's frozen identifiers (docs/plan1/wallet.md §2.2 at research ffcba5e; frozen with the kit at Nov 1 06:00Z).
// Changing SIGN_HOST or the PRF input changes every passkey user's seed (wallet.md:56, S-B8), so neither ever changes.

// The signing page's permanent address and the passkey's rp.id (owner-decisions.md:263; wallet.md:47, :54-56).
export const SIGN_HOST = "sign.confidential.unrealized.trade";

// The passkey PRF input, and the step from the PRF output to the 16 bytes of entropy (wallet.md:47):
// entropy = HKDF-SHA256(PRF output, salt "confidential-trenches/v1", info "wallet/entropy", 16 B).
export const PRF_INPUT = "confidential-trenches/v1/seed";
export const PRF_SALT = "confidential-trenches/v1";
export const PRF_INFO = "wallet/entropy";

// Every derivation from the 12 words: HKDF-SHA512(ikm = seed64, salt = ASCII "blindfill/v1", info, L) (wallet.md:71).
export const HKDF_SALT = "blindfill/v1";

// The BN254 scalar field (wallet.md §A.8).
export const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

// Chain tags, 1 byte each (wallet.md:91-100): the tag, its SLIP-44 coin type and curve.
export const CHAINS = {
  sol: { tag: 0x01, coin: 501, curve: "ed25519" },
  evm: { tag: 0x02, coin: 60, curve: "secp256k1" },
  near: { tag: 0x03, coin: 397, curve: "ed25519" },
  "hop-sol": { tag: 0x04, coin: 501, curve: "ed25519" },
  "hop-evm": { tag: 0x05, coin: 60, curve: "secp256k1" },
  "hop-near": { tag: 0x06, coin: 397, curve: "ed25519" },
} as const;
export type Chain = keyof typeof CHAINS;

// Second-arrival kind tags (wallet.md:111-114): U 0x01, V 0x02, A 0x03, R 0x10 + c.
export const KIND_U = 0x01;
export const KIND_V = 0x02;
export const KIND_A = 0x03;
export const kindR = (c: Chain): number => 0x10 + CHAINS[c].tag;
