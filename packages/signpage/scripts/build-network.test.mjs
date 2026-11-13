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
import { evmTestnetVenues } from "../../kit/src/trade/evm/buy-unpinned.ts";

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
];
/** The EVM testnets' own values, read from the kit's testnet venues (packages/kit/src/trade/evm/buy-unpinned.ts
 *  evmTestnetVenues), never typed here: each testnet's chain id, and its pool's sell delegate, fee collector and buy
 *  adapters. SIGN_HOST's build carries none of them in any form. */
const TESTNET_EVM = Object.entries(evmTestnetVenues()).flatMap(([net, v]) => [
  { what: `${net}'s chain id`, id: BigInt(v.chainId) },
  ...[["sell delegate", v.sellDelegate], ["fee collector", v.feeCollector], ...Object.entries(v.adapters ?? {}).map(([k, a]) => [`${k} adapter`, a])]
    .filter(([, a]) => a !== undefined)
    .map(([what, a]) => ({ what: `${net}'s ${what}`, address: a })),
]);
/** What of TESTNET_EVM a bundle carries: a chain id in decimal (a number or a bigint literal) or in hex (any case, any
 *  leading zeros), never as part of a longer number; an address's 40 hex digits in any case, with or without 0x (a
 *  padded word holds them too). */
export function testnetEvmFaults(text) {
  const low = text.toLowerCase();
  return TESTNET_EVM.filter((t) => {
    if (t.address !== undefined) return low.includes(t.address.toLowerCase().replace(/^0x/, ""));
    const dec = new RegExp(`(?<![\\w$.])${t.id}n?(?![\\w$])`);
    const hex = new RegExp(`(?<![\\w$])0x0*${t.id.toString(16)}n?(?![\\w$])`);
    return dec.test(low) || hex.test(low);
  }).map((t) => t.what);
}
/** What both builds carry (card evm-deposit-on-mainnet): a Base and Robinhood pool deposit is open on a build only where
 *  its withdraw is in it (src/pool-testnet.ts poolWayOut), so SIGN_HOST's bundle carries the EVM withdraw's release and
 *  the EVM deposit's own words. */
const BOTH = [
  "withdraw((address,bytes),(uint256[2],", // the EVM pool withdraw's release (src/evm-send.ts EVM_WITHDRAW_SIGNATURE)
  "0xe2bbb158", // the EVM pool deposit's selector, deposit(uint256,uint256), held by its rule (src/rules/pool.ts checkEvmDeposit)
];
/** The EVM pool buy and sale in SIGN_HOST's build (src/pool-testnet.ts: open wherever the chain's withdraw is built,
 *  poolWayOut), each with its way back into the pool: a buy's signature only beside the carry of a refused buy's ETH
 *  on W (src/pool-carry-evm.ts EVM_CARRY_OPEN_KEY), the Sell typed data only beside the sale's open record, followed
 *  until its return lands (src/pool-sell-evm.ts EVM_OPEN_SELLS_KEY). */
const EVM_BUY = "buy((address,bytes),"; // the EVM pool buy's signature (src/evm-send.ts)
const EVM_SELL = "Sell(address token,uint256 amount,address target,bytes data,uint256 minOut,address pool,uint256 precommitment,uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)"; // the Sell typed data W signs, whole (packages/kit/src/trade/evm/sell-unpinned.ts)
const EVM_TRADE = [
  EVM_BUY,
  "owed/carry-evm-open", // the carry's open record (src/pool-carry-evm.ts EVM_CARRY_OPEN_KEY)
  "owed/carry-evm", // the carry's done Ws (EVM_CARRY_DONE_KEY)
  "uniswap-v4", // the EVM buy's route search
  "nonce()", // the sale's read of W's SellDelegate nonce (src/pool-sell-evm.ts)
  EVM_SELL,
  "owed/sell-evm", // the sale's open record (src/pool-sell-evm.ts EVM_OPEN_SELLS_KEY)
];
/** What a bundle lacks of the EVM trade's ways back: [] when it carries neither the buy nor the sale, or each with its
 *  own. A buy with no carry, or a sale with no open record, is named. */
export function evmWayBackFaults(text) {
  const out = [];
  if (text.includes(EVM_BUY) && !text.includes("owed/carry-evm-open")) out.push("the buy without the carry of a refused buy's ETH");
  if (text.includes(EVM_SELL) && !text.includes("owed/sell-evm")) out.push("the sale without its open record");
  return out;
}
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
  assert.deepEqual(testnetEvmFaults(text), [], "the mainnet bundle carries an EVM testnet's chain id or pool address");
  for (const s of BOTH) assert.ok(text.includes(s), `the mainnet bundle lacks ${s}`);
  assert.ok(!text.includes("__SIGN_NETWORK__"), "the network is folded at build time");
  for (const s of EVM_TRADE) assert.ok(text.includes(s), `the mainnet bundle lacks ${s}`);
  assert.deepEqual(evmWayBackFaults(text), []);
});

test("the EVM trade's way-back rule refuses a bundle with a buy and no carry, or a sale and no open record", () => {
  assert.deepEqual(evmWayBackFaults(""), [], "neither: nothing to bring back");
  assert.deepEqual(evmWayBackFaults(`${EVM_BUY} owed/carry-evm-open ${EVM_SELL} owed/sell-evm`), []);
  assert.deepEqual(evmWayBackFaults(`${EVM_BUY} owed/back-evm`), ["the buy without the carry of a refused buy's ETH"]);
  assert.deepEqual(evmWayBackFaults(`${EVM_BUY} owed/carry-evm-open ${EVM_SELL}`), ["the sale without its open record"]);
  assert.deepEqual(evmWayBackFaults(`${EVM_SELL} ${EVM_BUY}`), ["the buy without the carry of a refused buy's ETH", "the sale without its open record"]);
});

test("the EVM testnets' rule refuses a bundle naming a testnet chain id, in decimal or hex, or a testnet pool's delegate, fee collector or adapter", () => {
  const ids = TESTNET_EVM.filter((t) => t.id !== undefined);
  const addresses = TESTNET_EVM.filter((t) => t.address !== undefined);
  // read from the kit's testnet venues: both testnets, each with a delegate, a fee collector and an adapter at least
  assert.equal(ids.length, Object.keys(evmTestnetVenues()).length);
  assert.ok(ids.length >= 2 && ids.every((t) => t.id > 0n));
  for (const kind of ["sell delegate", "fee collector", "adapter"]) assert.equal(addresses.filter((t) => t.what.includes(kind)).length >= 2, true, kind);
  assert.deepEqual(testnetEvmFaults(""), []);
  // the mainnets' own ids, and numbers that hold a testnet id's digits inside a longer one: none is a testnet id
  const near = ids.flatMap((t) => [`1${t.id}`, `${t.id}1`, `0.${t.id}`, `0x${t.id.toString(16)}0`, `0x1${t.id.toString(16)}`, `x${t.id}`]);
  assert.deepEqual(testnetEvmFaults(`chainId:8453,chainId:4663,0x2105,0x1237,${near.join(",")}`), []);
  for (const t of ids) {
    const h = t.id.toString(16);
    for (const planted of [`{chainId:${t.id}}`, `[${t.id}n]`, `"${t.id}"`, `"0x${h}"`, `"0x${h.toUpperCase()}"`, `0x${h}n`, `"0x${h.padStart(8, "0")}"`, `(${t.id})`]) {
      assert.deepEqual(testnetEvmFaults(`var a=1;${planted};`), [t.what], planted);
    }
  }
  for (const t of addresses) {
    const body = t.address.slice(2);
    for (const planted of [`"${t.address}"`, `"0x${body.toUpperCase()}"`, `"${"0".repeat(24)}${body}"`]) {
      assert.deepEqual(testnetEvmFaults(`var a=1;${planted};`), [t.what], planted);
    }
  }
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
  // a W is named to no public provider on a restore (card near-holdings-restore): no FastNEAR API host on any build
  for (const t of [headers, signHeadersFor("testnet", headers)]) for (const h of ["https://api.fastnear.com", "https://test.api.fastnear.com"]) assert.ok(!(/connect-src ([^;]*);/.exec(t)?.[1] ?? "").split(" ").includes(h), `a build's connect-src names ${h}`);
});

test("the testnet build carries the devnet pool's pins and the testnet providers", async () => {
  const text = (await bundle(undefined, { network: "testnet" })).js.toString("utf8");
  for (const s of TESTNET_ONLY) assert.ok(text.includes(s), `the testnet bundle lacks ${s}`);
  // the rule reads the build's own forms: the testnet build carries every value it refuses on SIGN_HOST's
  assert.deepEqual(testnetEvmFaults(text), TESTNET_EVM.map((t) => t.what));
  for (const s of MAINNET_ONLY) assert.ok(!text.includes(s), `the testnet bundle carries the mainnet pin's ${s}`);
  for (const s of BOTH) assert.ok(text.includes(s), `the testnet bundle lacks ${s}`);
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
