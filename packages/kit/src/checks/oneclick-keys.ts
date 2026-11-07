// The 1Click signing key set, apart from the check (src/checks/oneclick.ts) so a test can load its own key set in this
// module's place through a module hook (card kit-oneclick-pins-frozen) and nothing ever writes into the pin. The key is
// published only as an SDK constant (D3): every release of @defuse-protocol/one-click-sdk-typescript that carries one
// (0.1.23 to 0.1.26, the latest; npm tarballs read 2026-11-01T00:58Z and 01:40Z; 0.1.18-0.1.22 carry none) names this
// one key (0.1.26 dist/index.mjs:1593). A new release's key joins this list when read (D-R6; wallet.md's deposit quote
// row at research faacb62), never from a quote or a server. SIGN_HOST's deploy gate names the same bytes
// (scripts/live-checks/kit-oneclick-pins-frozen.mjs PINNED_KEYS) and refuses a build whose bundle holds any other
// "ed25519:" key literal; the check takes a key only in that form (oneclick.ts keyBytes). A key built from parts, or a
// writable copy of this set, is caught only by code review.
export const ONECLICK_SIGNING_KEYS: readonly string[] = Object.freeze(["ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc"]);
