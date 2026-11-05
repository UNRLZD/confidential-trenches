// node --test packages/signpage/scripts/build-network.test.mjs (card signpage-pool-flow): the signing page is built for
// one network. SIGN_HOST's build (mainnet, the default) is byte for byte the committed public/app.js and carries no
// testnet pin or provider; the testnet build carries the devnet pool's program and fee payer, the devnet RPCs and the
// EVM testnets' RPCs. A network other than the two is refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bundle, NETWORKS } from "./build-app.mjs";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTNET_ONLY = [
  "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", // the devnet pool's program (pool-sol-deploy.devnet.json)
  "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb", // the helper's devnet fee payer
  "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy", // the devnet pool's lookup table (src/pool-testnet.ts DEVNET_TABLE)
  "api.devnet.solana.com",
  "/v1/rpc/solana-devnet", // the helper's devnet route, the second devnet provider (card pool-buy-send-fast)
  "sepolia.base.org",
  "base-sepolia-rpc.publicnode.com",
  "rpc.testnet.chain.robinhood.com",
  "robinhood-sepolia-rpc.publicnode.com",
];

test("SIGN_HOST's build is the committed public/app.js, byte for byte, with no testnet pin or provider", async () => {
  assert.deepEqual(NETWORKS, ["mainnet", "testnet"]);
  const { js } = await bundle();
  assert.ok(js.equals(readFileSync(join(PKG, "public/app.js"))), "the mainnet bundle is the committed one");
  const text = js.toString("utf8");
  for (const s of TESTNET_ONLY) assert.ok(!text.includes(s), `the mainnet bundle carries ${s}`);
  assert.ok(!text.includes("__SIGN_NETWORK__"), "the network is folded at build time");
});

test("the testnet build carries the devnet pool's pins and the testnet providers", async () => {
  const text = (await bundle(undefined, { network: "testnet" })).js.toString("utf8");
  for (const s of TESTNET_ONLY) assert.ok(text.includes(s), `the testnet bundle lacks ${s}`);
  assert.ok(!text.includes("__SIGN_NETWORK__"));
});

test("a network that is not mainnet or testnet is refused", async () => {
  await assert.rejects(bundle(undefined, { network: "devnet" }), /network: mainnet or testnet/);
});
