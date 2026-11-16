// The test networks' names, for the live checks that make sure a build, a page or the helper names none of them (card
// live-checks-read-mainnet-only). A listed check reads the mainnets only (scripts/ci/live-mainnet-only.mjs refuses a
// test network's provider, pool or record in its own code), so the names it must find absent come from here, and
// nothing here is ever read over the network by a listed check: each is a string to look for in a bundle, a CSP or an
// answer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { MAINNETS } from "./mainnet-venues.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The kit's EVM venues on the test networks (Base Sepolia, Robinhood testnet): evmPoolVenues() less the mainnets. */
export const testVenues = () => Object.freeze(Object.fromEntries(Object.entries(evmPoolVenues()).filter(([c]) => !MAINNETS.includes(c))));

/** The Solana devnet pool before its re-pin (card pool-senders-next-page-helper's move, DEVNET_MOVE at fd2f2a6e1). */
export const DEVNET_BEFORE = "2S5wpE7U7GoJRVqox1dXmTQm38SmseG8A4F9eReWwYwr";

/** Every test pool: each EVM test network's kit pin, and the Solana devnet pools (contracts/pool-solana/deployments/
 *  devnet.json's and the one before it), as { chain, network, pool }. */
export function testPools(root = ROOT, venues = testVenues()) {
  const dev = JSON.parse(readFileSync(path.join(root, "contracts/pool-solana/deployments/devnet.json"), "utf8"));
  const evm = Object.entries(venues)
    .filter(([, v]) => typeof v?.pool === "string")
    .map(([n, v]) => ({ chain: "evm", network: n, pool: v.pool.toLowerCase() }));
  return [...evm, ...[...new Set([String(dev.pool), DEVNET_BEFORE])].map((pool) => ({ chain: "solana", network: "devnet", pool }))];
}

/** Test networks' RPC origins a mainnet build or page must not name. */
export const TEST_HOSTS = Object.freeze({
  /** NEAR testnet: FastNEAR's, dRPC's and NEAR's own */
  near: Object.freeze(["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"]),
  /** Robinhood testnet's own operator */
  robinhood: "https://rpc.testnet.chain.robinhood.com",
});
