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
import { bundle, NETWORKS, signHeadersFor, TESTNET_CONNECT } from "./build-app.mjs";
import { signBuilt } from "../../../scripts/signpage-built.mjs";

const PKG = signBuilt(); // the page's build, made from this tree's sources first (card signpage-generated-merge-free)
const TESTNET_ONLY = [
  "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8", // the devnet pool's program (pool-sol-deploy.devnet.json)
  "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb", // the helper's devnet fee payer
  "C2vLuah7VtGDTVnFkBpY7DkNf135Wwu6Uv57qCXPb9qJ", // the devnet pool's curve table (wallet SOL_POOL_TABLES.devnet)
  "4kG4g4fbSbwkxxdqT4G3cLeEbnvcbZTmBwJExK3ZGGAT", // the devnet pool's PumpSwap table, generation 1 (wallet SOL_POOL_TABLES.devnet)
  "J1R9px8LFg597sGfaME1qf7L5WGHGnn2YL2Vs2CwaWvU", // the devnet pool's PumpSwap table, generation 2
  "3uym947bDVPRHyzmzTAV8C4p4Du6s2wRjVr4AZpYQtBH", // the devnet pool's PumpSwap table, generation 3
  "api.devnet.solana.com",
  "/v1/rpc/solana-devnet", // the helper's devnet route, the second devnet provider (card pool-buy-send-fast)
  "base-sepolia-rpc.publicnode.com",
  "base-testnet.api.pocket.network", // Base Sepolia's second pool provider (card notes-per-pool-evm-base-hang)
  "rpc.testnet.chain.robinhood.com",
  "robinhood-sepolia-rpc.publicnode.com",
  "sepolia.base.org", // Base Sepolia's fee provider (src/pool-testnet.ts TESTNET_EVM_FEE_RPCS)
  "robinhood-testnet.drpc.org", // Robinhood testnet's fee provider (the same)
  "r-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow the testnet withdrawal relayer (card signpage-withdraw-handoff)
  "f-2b700409.bf-vt-20261102t071444.testnet", // gitleaks:allow its fee recipient
  "0x6c830ac1b22d96baf692af4dd17d822ba61c32ec", // the Base Sepolia pool's fee recipient (wallet EVM_POOLS, card evm-pool-pins)
  "0xe40f67e8502a3e2ebf4caf7bdee8ac8758b472a7", // the Robinhood testnet pool's fee recipient
  // the kit's testnet venues (packages/kit/src/trade/evm/buy-unpinned.ts evmTestnetVenues), folded out of SIGN_HOST's
  // build (card evm-pools-on-mainnet): each testnet pool
  "0xeb967dfc1b4ffb22942f833c76866ea85fc42266", // the Base Sepolia pool
  "0xed9fac860e6bc5e932455232eedca8b71c44da4d", // the Robinhood testnet pool
  // the EVM pool buy and sale, testnet only while mainnet keeps them closed (card evm-pools-on-mainnet, src/pool-testnet.ts)
  "buy((address,bytes),", // the EVM pool buy's signature (src/evm-send.ts)
  "owed/back-evm", // the EVM buy's owed-back record (src/pool-buy-evm.ts EVM_OWED_BACK_KEY)
  "withdraw((address,bytes),(uint256[2],", // the EVM pool withdraw's release (src/evm-send.ts EVM_WITHDRAW_SIGNATURE), folded as the buy
  "uniswap-v4", // the EVM buy's route search
  "nonce()", // the sale's read of W's SellDelegate nonce (src/pool-sell-evm.ts)
  // the Sell typed data W signs, whole (packages/kit/src/trade/evm/sell-unpinned.ts)
  "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)",
];
/** The mainnet pins (packages/wallet/src/pool/solana.ts SOL_POOLS.mainnet and SOL_MAINNET_DEPLOY, card
 *  sol-pools-mainnet-pin; packages/wallet/src/pool/evm.ts EVM_POOLS.base and .robinhood, card evm-pools-on-mainnet):
 *  the testnet build carries none of them. */
const MAINNET_ONLY = [
  // (each pool's address is also in the kit's venue table, which both builds carry: its fee recipient is the pin's own)
  "0x4611338bf66389a2d2d3e67301dbb7ac9fb1fb9d", // the Base mainnet pool's fee recipient
  "0x63c4b707b319d3f1643a7d0d61c188d76ec8f23d", // the Robinhood mainnet pool's fee recipient
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

test("SIGN_HOST's policy names no testnet EVM provider; a testnet build's server adds exactly those, where they were (card evm-pools-on-mainnet)", () => {
  const headers = readFileSync(join(PKG, "public/_headers"), "utf8");
  const connect = (t) => (/connect-src ([^;]*);/.exec(t)?.[1] ?? "").split(" ");
  assert.equal(TESTNET_CONNECT.length, 6);
  for (const h of TESTNET_CONNECT) assert.ok(!connect(headers).includes(h), `SIGN_HOST's connect-src names ${h}`);
  assert.equal(signHeadersFor("mainnet", headers), headers);
  const testnet = signHeadersFor("testnet", headers);
  for (const h of TESTNET_CONNECT) assert.ok(connect(testnet).includes(h), `the testnet build's connect-src lacks ${h}`);
  assert.deepEqual(connect(testnet).filter((h) => !connect(headers).includes(h)), [...TESTNET_CONNECT]);
  assert.throws(() => signHeadersFor("testnet", "connect-src 'self';"), /exactly once/);
  assert.throws(() => signHeadersFor("devnet", headers), /mainnet or testnet/);
});

test("SIGN_HOST's policy lets the mainnet build reach no testnet NEAR RPC (card signpage-withdraw-handoff)", () => {
  const headers = readFileSync(join(PKG, "public/_headers"), "utf8");
  const connect = /connect-src ([^;]*);/.exec(headers)?.[1] ?? "";
  for (const h of ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"]) assert.ok(!connect.split(" ").includes(h), `SIGN_HOST's connect-src names ${h}`);
  for (const h of ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://archival-rpc.mainnet.near.org", "https://archival-rpc.mainnet.fastnear.com"]) assert.ok(connect.split(" ").includes(h), `SIGN_HOST's connect-src lacks ${h}`);
  for (const h of ["https://archival-rpc.testnet.near.org", "https://archival-rpc.testnet.fastnear.com"]) assert.ok(!connect.split(" ").includes(h), `SIGN_HOST's connect-src names ${h}`); // near-rpc-operators: one operator (testnet's archival list: on no mainnet policy)
  // the NEAR FT list a restored W's token hint is asked of (card near-holdings-restore): mainnet's alone, on no build
  // testnet's (a testnet build's pass finds its hints refused and reads that W again on the next load)
  assert.ok(connect.split(" ").includes("https://api.fastnear.com"), "SIGN_HOST's connect-src lacks the mainnet FT list");
  for (const t of [headers, signHeadersFor("testnet", headers)]) assert.ok(!(/connect-src ([^;]*);/.exec(t)?.[1] ?? "").split(" ").includes("https://test.api.fastnear.com"), "a build's connect-src names the testnet FT list");
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
