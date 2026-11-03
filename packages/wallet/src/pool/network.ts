// The network a build of the signing page runs on (card signpage-pool-flow). packages/signpage/scripts/build-app.mjs
// sets __SIGN_NETWORK__ at build time: "mainnet" for SIGN_HOST's build, "testnet" for the testnet build (Solana devnet,
// Base Sepolia, Robinhood testnet). The minifier folds the test below, so SIGN_HOST's bundle carries no testnet pin and
// stays byte for byte what it was. Where nothing sets it (Node, the tests, any other build) it is mainnet.
declare const __SIGN_NETWORK__: string | undefined;

/** Whether this build is the testnet build. */
export const POOL_TESTNET: boolean = typeof __SIGN_NETWORK__ !== "undefined" && __SIGN_NETWORK__ === "testnet";
