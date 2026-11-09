// node --test packages/signpage/scripts/build-network.test.mjs (card signpage-pool-flow): the signing page is built for
// one network. SIGN_HOST's build (mainnet, the default) is byte for byte the committed public/app.js and carries no
// testnet pin or provider; the testnet build carries the devnet pool's program and fee payer, the devnet RPCs and the
// EVM testnets' RPCs. A network other than the two is refused.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bundle, NETWORKS } from "./build-app.mjs";
import { signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)
const TESTNET_ONLY = [
  "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", // the devnet pool's program (pool-sol-deploy.devnet.json)
  "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb", // the helper's devnet fee payer
  "C2vLuah7VtGDTVnFkBpY7DkNf135Wwu6Uv57qCXPb9qJ", // the devnet pool's curve table (wallet SOL_POOL_TABLES.devnet)
  "4kG4g4fbSbwkxxdqT4G3cLeEbnvcbZTmBwJExK3ZGGAT", // the devnet pool's PumpSwap table (wallet SOL_POOL_TABLES.devnet)
  "api.devnet.solana.com",
  "/v1/rpc/solana-devnet", // the helper's devnet route, the second devnet provider (card pool-buy-send-fast)
  "base-sepolia-rpc.publicnode.com",
  "base-testnet.api.pocket.network", // Base Sepolia's second pool provider (card notes-per-pool-evm-base-hang)
  "rpc.testnet.chain.robinhood.com",
  "robinhood-sepolia-rpc.publicnode.com",
  "r-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow the testnet withdrawal relayer (card signpage-withdraw-handoff)
  "f-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow its fee recipient
];
/** The mainnet pin (packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet and SOL_MAINNET_DEPLOY, card
 *  sol-pools-mainnet-pin): the testnet build carries none of it. */
const MAINNET_ONLY = [
  "CPWhFyFL8naX5W8DEB5XTrEUR2XtkHv7kyXdavpqDTTU", // the helper's mainnet fee payer
  "EN1Wb2iWTw7ihNHTNW3SU2DkUCbw7yEEGR7ywWgWn8MF", // the mainnet pool program
  "BShWZ8FbDPYGpoc1ebj4TiELvVFmBQwW4XMYuLtQoHYZ", // its lookup table
];

test("SIGN_HOST's build is the committed public/app.js, byte for byte, with no testnet pin or provider", async () => {
  assert.deepEqual(NETWORKS, ["mainnet", "testnet"]);
  const { js } = await bundle();
  assert.ok(js.equals(readFileSync(join(PKG, "public/app.js"))), "the mainnet bundle is the one built in the package");
  const text = js.toString("utf8");
  for (const s of TESTNET_ONLY) assert.ok(!text.includes(s), `the mainnet bundle carries ${s}`);
  assert.ok(!text.includes("__SIGN_NETWORK__"), "the network is folded at build time");
});

test("SIGN_HOST's policy lets the mainnet build reach no testnet NEAR RPC (card signpage-withdraw-handoff)", () => {
  const headers = readFileSync(join(PKG, "public/_headers"), "utf8");
  const connect = /connect-src ([^;]*);/.exec(headers)?.[1] ?? "";
  for (const h of ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"]) assert.ok(!connect.split(" ").includes(h), `SIGN_HOST's connect-src names ${h}`);
  for (const h of ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"]) assert.ok(connect.split(" ").includes(h), `SIGN_HOST's connect-src lacks ${h}`);
  for (const h of ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"]) assert.ok(!connect.split(" ").includes(h), `SIGN_HOST's connect-src names ${h}`); // near-rpc-operators: one operator (testnet's archival list: on no mainnet policy)
});

test("the testnet build carries the devnet pool's pins and the testnet providers", async () => {
  const text = (await bundle(undefined, { network: "testnet" })).js.toString("utf8");
  for (const s of TESTNET_ONLY) assert.ok(text.includes(s), `the testnet bundle lacks ${s}`);
  for (const s of MAINNET_ONLY) assert.ok(!text.includes(s), `the testnet bundle carries the mainnet pin's ${s}`);
  assert.ok(!text.includes("__SIGN_NETWORK__"));
});

test("a network that is not mainnet or testnet is refused", async () => {
  await assert.rejects(bundle(undefined, { network: "devnet" }), /network: mainnet or testnet/);
});
