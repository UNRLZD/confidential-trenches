// node --test packages/signpage/scripts/build-network.test.mjs (card signpage-pool-flow): the signing page is built for
// one network. SIGN_HOST's build (mainnet, the default) is byte for byte the committed public/app.js and carries no
// testnet pin or provider; the testnet build carries the devnet pool's program and fee payer, the devnet RPCs and the
// EVM testnets' RPCs. A network other than the two is refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundle, NETWORKS } from "./build-app.mjs";
import { signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)
const TESTNET_ONLY = [
  "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", // the devnet pool's program (pool-sol-deploy.devnet.json)
  "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb", // the helper's devnet fee payer
  "6bbfV79efN889c4iRTSTf4htv6EnurCJuz5CjMftjsyZ", // the devnet pool's lookup table (src/pool-testnet.ts DEVNET_TABLE)
  "api.devnet.solana.com",
  "/v1/rpc/solana-devnet", // the helper's devnet route, the second devnet provider (card pool-buy-send-fast)
  "base-sepolia-rpc.publicnode.com",
  "base-testnet.api.pocket.network", // Base Sepolia's second pool provider (card notes-per-pool-evm-base-hang)
  "rpc.testnet.chain.robinhood.com",
  "robinhood-sepolia-rpc.publicnode.com",
  "r-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow the testnet withdrawal relayer (card signpage-withdraw-handoff)
  "f-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow its fee recipient
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
  assert.ok(!text.includes("__SIGN_NETWORK__"));
});

test("a network that is not mainnet or testnet is refused", async () => {
  await assert.rejects(bundle(undefined, { network: "devnet" }), /network: mainnet or testnet/);
});

// The CLI's --network (card app-a2-e2e, a devnet browser run in H-app): with no flag, --out holds SIGN_HOST's build byte
// for byte; only --network testnet gives the testnet build, and only into --out, never the package's public/.
const CLI = join(import.meta.dirname, "build-app.mjs");
const cli = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
test("build-app's CLI builds mainnet unless --network testnet is named, and testnet only into --out", () => {
  const plain = mkdtempSync(join(tmpdir(), "ct-build-net-"));
  const testnet = mkdtempSync(join(tmpdir(), "ct-build-net-"));
  try {
    assert.equal(cli(["--out", plain]).status, 0);
    assert.ok(readFileSync(join(plain, "app.js")).equals(readFileSync(join(PKG, "public/app.js"))), "no flag: the mainnet bundle, byte for byte");
    assert.equal(cli(["--out", testnet, "--network", "testnet"]).status, 0);
    const text = readFileSync(join(testnet, "app.js"), "utf8");
    for (const s of TESTNET_ONLY) assert.ok(text.includes(s), `--network testnet lacks ${s}`);
    const into = cli(["--network", "testnet"]);
    assert.equal(into.status, 2, "--network testnet with no --out is refused");
    assert.match(into.stderr, /--network testnet needs --out/);
    assert.ok(readFileSync(join(PKG, "public/app.js")).toString("utf8").includes(TESTNET_ONLY[0]) === false, "the package's public/app.js is still the mainnet build");
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(testnet, { recursive: true, force: true });
  }
});
