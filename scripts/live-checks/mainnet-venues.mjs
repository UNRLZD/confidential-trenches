// The kit's EVM venues on the mainnets alone, for the live checks a deploy runs (card live-checks-read-mainnet-only).
// In Node the kit's evmPoolVenues() is the whole list, the test networks' half included (only SIGN_HOST's build folds
// that half away), so a check that walked it read Base Sepolia's and Robinhood testnet's providers after every deploy;
// robinhood-testnet's dRPC refusing eth_getBlockByNumber turned live run 43908276087 red. The mainnets are the helper's
// (apps/helper/src/pool/mainnet-only.ts MAINNET_POOL_NETWORKS), so a network added there is read here too.
// scripts/ci/live-mainnet-only.mjs refuses evmPoolVenues in a listed check.
// Runs: once, no check: a module the listed checks share for the mainnets' venues
import { MAINNET_POOL_NETWORKS } from "../../apps/helper/src/pool/mainnet-only.ts";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";

/** The mainnets' names, in the kit's order. */
export const MAINNETS = Object.freeze(Object.keys(evmPoolVenues()).filter((c) => MAINNET_POOL_NETWORKS.evm.includes(c)));

let venues;
/** evmPoolVenues() with the mainnets' entries alone, the same objects, frozen. */
export const mainnetVenues = () => (venues ??= Object.freeze(Object.fromEntries(MAINNETS.map((c) => [c, evmPoolVenues()[c]]))));
