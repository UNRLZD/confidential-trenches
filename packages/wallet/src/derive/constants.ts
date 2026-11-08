// The wallet's frozen identifiers (docs/plan1/wallet.md §2.2 at research ffcba5e; frozen with the kit at Nov 1 06:00Z).
// Changing SIGN_HOST or the PRF input changes every passkey user's seed (wallet.md:56, S-B8), so neither changes again.
// SIGN_HOST moved once, before any user (card hosts-main-on-top, owner 1 Nov 16:45Z, owner-decisions.md:357), from its
// child "sign." to this name: a passkey made there derives a different seed here, the typed 12 words do not.

// The signing page's permanent address and the passkey's rp.id (owner-decisions.md:263, :357; wallet.md:47, :54-56).
// It is the main address, the one the address bar shows while trading. WebAuthn lets a page on any child host claim a
// parent rp.id, so no name under it may serve anything else: the terminal's code is on ct-app.unrealized.trade and the
// helper on ct-api.unrealized.trade, siblings that cannot claim it (scripts/ci/host-children.mjs refuses a child in the
// tree, the live check hosts-main-on-top a child or wildcard in DNS).
export const SIGN_HOST = "confidential.unrealized.trade";

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
export const kindR = (c: Chain): number => {
  if (typeof c !== "string" || !Object.hasOwn(CHAINS, c)) throw new Error(`unknown chain tag ${String(c)}`);
  return 0x10 + CHAINS[c].tag;
};
