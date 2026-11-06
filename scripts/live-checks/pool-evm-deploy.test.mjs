// Replays pool-evm-deploy.answers.json through the live check: the recorded good answers (the dry run on anvil forks of
// Base Sepolia and Robinhood testnet, each read on two loopback URLs) pass; the same recording with one thing changed
// fails: other code bytes, an immutable that differs between its places, a getter's other answer, an EIP-1967 slot
// set, an owner() that answers, a PoolManager, router or WETH with other code, an upgraded WETH, a failed transaction,
// a run key that kept money or sent one more transaction, another chain id, and RPCs that are not two operators.
//   node --test scripts/live-checks/pool-evm-deploy.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILD, CHAINS, DUST, EIP1967, MAINNETS, MAINNET_IDS, chainOf, check, deploymentFile, gettersOf, operatorProblems, pinnedBuild, runRecord, runtimeOf, selector } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./pool-evm-deploy.answers.json", import.meta.url), "utf8"));

// answers served in recorded order by (url, method, params)
function replay(answers) {
  const used = new Set();
  return async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    const i = answers.findIndex((a, j) => !used.has(j) && a.url === url && a.method === method && JSON.stringify(a.params) === JSON.stringify(params));
    if (i < 0) throw new Error(`no recorded answer for ${method} ${JSON.stringify(params).slice(0, 80)} on ${url}`);
    used.add(i);
    const a = answers[i];
    return { ok: a.status === 200, status: a.status, json: async () => a.json };
  };
}
const run = (chain, answers = A.good[chain], d = A.deployments[chain], rpcs = A.rpcs[chain]) =>
  check({ deployment: d, fetchFn: replay(answers), rpcs, sleep: async () => {} });
/** the chain's recording with every answer that `pick(a)` selects changed by `f(a.json)`, on the first RPC only */
function mutate(chain, pick, f) {
  const out = structuredClone(A.good[chain]);
  let n = 0;
  for (const a of out) if (a.url === A.rpcs[chain][0] && pick(a)) (f(a.json), n++);
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.ok, false);
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
const lower = (s) => String(s).toLowerCase();
const isCall = (to, sig) => (a) => a.method === "eth_call" && lower(a.params[0].to) === lower(to) && a.params[0].data === selector(sig);
const isCode = (addr) => (a) => a.method === "eth_getCode" && lower(a.params[0]) === lower(addr);
const flip = (h, at) => h.slice(0, 2 + 2 * at) + (parseInt(h.slice(2 + 2 * at, 4 + 2 * at), 16) ^ 1).toString(16).padStart(2, "0") + h.slice(4 + 2 * at);
const CHAIN_NAMES = Object.keys(CHAINS);

test("the recorded good answers pass on both chains, every read on both RPCs", async () => {
  assert.deepEqual(Object.keys(A.deployments).sort(), CHAIN_NAMES.slice().sort());
  for (const chain of CHAIN_NAMES) {
    const d = A.deployments[chain];
    const r = await run(chain);
    assert.equal(r.ok, true, r.lines.join("\n"));
    assert.equal(d.dryRun, true);
    for (const u of A.rpcs[chain]) assert.ok(r.lines.some((l) => l.endsWith(`chain id ${CHAINS[chain].chainId} is ${chain}'s ${CHAINS[chain].chainId} on ${u}`)), u);
    assert.deepEqual(Object.keys(d.contracts), CHAINS[chain].contracts);
    assert.equal(d.txs.filter((t) => t.contract).length, CHAINS[chain].contracts.length);
    assert.ok(d.txs.some((t) => t.step.startsWith("sweep")), "the run swept");
  }
});

test("other code bytes fail, outside the immutables and in the code's length", async () => {
  const pool = A.deployments["base-sepolia"].contracts.PrivacyPoolSimple.address;
  fails(await run("base-sepolia", mutate("base-sepolia", isCode(pool), (j) => (j.result = flip(j.result, 10)))), /PrivacyPoolSimple \S+ code is the build's/);
  fails(await run("base-sepolia", mutate("base-sepolia", isCode(pool), (j) => (j.result += "00"))), /PrivacyPoolSimple \S+ code is the build's: 9442 bytes/);
});

test("an immutable that differs between its places fails, though the zeroed code and the getter agree", async () => {
  const del = A.deployments["robinhood-testnet"].contracts.SellDelegate.address;
  const at = BUILD.contracts.SellDelegate.immutables[0][1];
  fails(await run("robinhood-testnet", mutate("robinhood-testnet", isCode(del), (j) => (j.result = flip(j.result, at + 31)))), /SellDelegate's 2 immutable\(s\) each hold one word.*2 words/);
});

test("a getter's other answer fails: the adapter's PoolManager, the delegate's WETH, the pool's scope", async () => {
  const d = A.deployments["base-sepolia"].contracts;
  fails(await run("base-sepolia", mutate("base-sepolia", isCall(d.UniswapV4Adapter.address, "POOL_MANAGER()"), (j) => (j.result = flip(j.result, 31)))), /UniswapV4Adapter.POOL_MANAGER\(\) returns/);
  fails(await run("base-sepolia", mutate("base-sepolia", isCall(d.SellDelegate.address, "WETH()"), (j) => (j.result = flip(j.result, 31)))), /SellDelegate.WETH\(\) returns/);
  fails(await run("base-sepolia", mutate("base-sepolia", isCall(d.PrivacyPoolSimple.address, "SCOPE()"), (j) => (j.result = flip(j.result, 31)))), /PrivacyPoolSimple.SCOPE\(\) returns/);
});

test("an EIP-1967 slot set fails, and so does an owner() that answers", async () => {
  const pool = A.deployments["base-sepolia"].contracts.PrivacyPoolSimple.address;
  fails(await run("base-sepolia", mutate("base-sepolia", (a) => a.method === "eth_getStorageAt" && lower(a.params[0]) === lower(pool) && a.params[1] === EIP1967.admin, (j) => (j.result = "0x" + "11".repeat(32)))), /PrivacyPoolSimple's EIP-1967 admin slot is 0/);
  fails(await run("base-sepolia", mutate("base-sepolia", isCall(pool, "owner()"), (j) => (delete j.error, (j.result = "0x" + "00".repeat(12) + "ab".repeat(20))))), /PrivacyPoolSimple has no owner\(\)/);
});

test("a PoolManager, router or WETH with other code fails, and so does an upgraded Robinhood WETH", async () => {
  const b = CHAINS["base-sepolia"], h = CHAINS["robinhood-testnet"];
  fails(await run("base-sepolia", mutate("base-sepolia", isCode(b.poolManager.address), (j) => (j.result = flip(j.result, 5)))), /PoolManager \S+ code hash/);
  fails(await run("base-sepolia", mutate("base-sepolia", isCode(b.router.address), (j) => (j.result = "0x"))), /SwapRouter02 \S+ code hash \(no code\)/);
  fails(await run("robinhood-testnet", mutate("robinhood-testnet", isCall(h.weth.address, "symbol()"), (j) => (j.result = j.result.replace("57455448", "57455449")))), /WETH's symbol\(\) is "WETH"/);
  fails(await run("robinhood-testnet", mutate("robinhood-testnet", (a) => a.method === "eth_getStorageAt" && lower(a.params[0]) === h.weth.address && a.params[1] === EIP1967.implementation, (j) => (j.result = "0x" + "00".repeat(12) + "cd".repeat(20)))), /WETH's implementation slot holds the pinned/);
});

test("a failed transaction fails, and so does a deploy that made another address", async () => {
  const tx = A.deployments["robinhood-testnet"].txs[1].hash;
  const isTx = (a) => a.method === "eth_getTransactionReceipt" && a.params[0] === tx;
  fails(await run("robinhood-testnet", mutate("robinhood-testnet", isTx, (j) => (j.result.status = "0x0"))), /deploy PrivacyPoolSimple \S+ succeeded.*status 0x0/);
  fails(await run("robinhood-testnet", mutate("robinhood-testnet", isTx, (j) => (j.result.contractAddress = "0x" + "12".repeat(20)))), /made PrivacyPoolSimple/);
});

test("a run key that kept more than dust, or sent a transaction the record does not list, fails", async () => {
  const key = A.deployments["base-sepolia"].deployer;
  fails(await run("base-sepolia", mutate("base-sepolia", (a) => a.method === "eth_getBalance" && lower(a.params[0]) === key, (j) => (j.result = "0x" + (DUST + 1n).toString(16)))), /keeps at most 10000000000000 wei .*10000000000001 wei/);
  fails(await run("base-sepolia", mutate("base-sepolia", (a) => a.method === "eth_getTransactionCount" && lower(a.params[0]) === key, (j) => (j.result = "0x" + (BigInt(j.result) + 1n).toString(16)))), /sent exactly the record's/);
});

test("another chain id fails, and so do RPCs that are not two operators of the chain", async () => {
  fails(await run("base-sepolia", mutate("base-sepolia", (a) => a.method === "eth_chainId", (j) => (j.result = "0x2105"))), /chain id 0x2105 is base-sepolia's/);
  const real = { ...A.deployments["base-sepolia"], dryRun: false };
  assert.deepEqual(operatorProblems(CHAINS["base-sepolia"].rpcs, real), []);
  assert.deepEqual(operatorProblems(CHAINS["robinhood-testnet"].rpcs, { ...real, chain: "robinhood-testnet" }), []);
  assert.match(operatorProblems(["https://sepolia.base.org", "https://sepolia.base.org/"], real).join(), /only 1 known base-sepolia operator/);
  assert.match(operatorProblems(["https://mainnet.base.org", "https://base.drpc.org"], real).join(), /only 0 known/);
  assert.match(operatorProblems(CHAINS["base-sepolia"].rpcs, A.deployments["base-sepolia"]).join(), /dry-run record read on a non-loopback RPC/);
});

test("the run record lists every transaction as a testnet Tx line, and refuses a dry run", () => {
  const real = CHAIN_NAMES.map((c) => ({ ...A.deployments[c], dryRun: false }));
  const text = runRecord(real);
  assert.match(text, /^CARD pool-evm-deploy \/ live: PASS\nMoney path: yes\n/);
  const lines = text.split("\n").filter((l) => l.startsWith("Tx: "));
  assert.equal(lines.length, real.reduce((n, d) => n + d.txs.length, 0));
  for (const l of lines) assert.match(l, /^Tx: (base-sepolia|robinhood-testnet) 0x[0-9a-f]{64}$/);
  assert.throws(() => runRecord([A.deployments["base-sepolia"]]), /a dry run/);
});

test("the frozen v1 sell delegate is the build only at the addresses the build file pins it to; anywhere else its code fails", async () => {
  const f = BUILD.frozen.SellDelegate;
  for (const [chain, a] of Object.entries(f.at)) {
    assert.equal(pinnedBuild(chain, "SellDelegate", a), f, chain);
    assert.equal(pinnedBuild(chain, "SellDelegate", a.toUpperCase().replace("0X", "0x")), f, `${chain}, any case`);
    assert.deepEqual(gettersOf({ chain, contracts: { SellDelegate: { address: a } } }).SellDelegate.map(([s]) => s), ["WETH()"], `${chain}: v1 has no POOL_MANAGER`);
    for (const other of CHAIN_NAMES.filter((c) => c !== chain)) assert.equal(pinnedBuild(other, "SellDelegate", a), BUILD.contracts.SellDelegate, `${a} on ${other}`);
  }
  assert.equal(pinnedBuild("base-sepolia", "SellDelegate", "0x" + "12".repeat(20)), BUILD.contracts.SellDelegate);
  assert.equal(pinnedBuild("base-sepolia", "PrivacyPoolSimple", f.at["base-sepolia"]), BUILD.contracts.PrivacyPoolSimple);
  assert.notEqual(f.masked, BUILD.contracts.SellDelegate.masked, "the frozen build is not the current one");
  // the v1 delegate's code as deployed on Base Sepolia (sell-delegate-v1.code.json, read on both RPCs), served for the
  // dry run's delegate, an address the build file does not freeze: it fails
  const V = JSON.parse(readFileSync(new URL("./sell-delegate-v1.code.json", import.meta.url), "utf8"));
  assert.equal(lower(V.address), f.at["base-sepolia"]);
  const v1 = V.code;
  assert.equal(runtimeOf(v1, f.immutables).masked, f.masked, "the recorded code is the frozen v1 build");
  const del = A.deployments["base-sepolia"].contracts.SellDelegate.address;
  fails(await run("base-sepolia", mutate("base-sepolia", isCode(del), (j) => (j.result = v1))), /SellDelegate \S+ code is the build's: 4119 bytes/);
});

test("the mainnets (card pool-evm-deploy-mainnet): Base and Robinhood, both adapters and the sell delegate, each dependency's code hash as read on two operators, records in contracts/pool-evm/deployments/", () => {
  assert.deepEqual(Object.keys(MAINNETS), ["base", "robinhood"]);
  assert.deepEqual(MAINNET_IDS, { "0x2105": "base", "0x1237": "robinhood" });
  const all = ["WithdrawalVerifier", "PrivacyPoolSimple", "UniswapV4Adapter", "UniswapV3Adapter", "SellDelegate"];
  for (const n of ["base", "robinhood"]) {
    assert.deepEqual(MAINNETS[n].contracts, all, `${n}: mainnet keeps both adapters (M365)`);
    assert.deepEqual(operatorProblems(MAINNETS[n].rpcs, { chain: n }), [], n);
    assert.ok(deploymentFile(n).endsWith(`contracts/pool-evm/deployments/${n}.json`), deploymentFile(n));
    assert.equal(chainOf(n), MAINNETS[n]);
  }
  const b = MAINNETS.base, h = MAINNETS.robinhood;
  assert.deepEqual([b.poolManager.address, b.poolManager.codehash], ["0x498581ff718922c3f8e6a244956af099b2652b2b", "0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6"]);
  assert.deepEqual([b.router.address, b.router.codehash], ["0x2626664c2603336e57b271c5c0b26f421741e481", "0x38bd640f47df62b2fd5a6755a63f4976ad847dc9b946ae0d145d21d16bb124e4"]);
  assert.deepEqual([b.weth.address, b.weth.codehash, b.weth.symbol, b.weth.name, b.weth.implementation], ["0x4200000000000000000000000000000000000006", "0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c", "WETH", "Wrapped Ether", undefined]);
  assert.deepEqual([h.poolManager.address, h.poolManager.codehash], ["0x8366a39cc670b4001a1121b8f6a443a643e40951", "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626"]);
  assert.deepEqual([h.router.address, h.router.codehash], ["0xcaf681a66d020601342297493863e78c959e5cb2", "0x6f36c378e272c6324c48f045182bcb54bd8ad654cf9ebd42e8893d52c4cb25dc"]);
  assert.deepEqual([h.weth.address, h.weth.codehash, h.weth.symbol, h.weth.name], ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5706be52f64875fee65a2cec0d80e47a23d8793cbe85d214b48445e2d05f5353", "WETH", "WETH"]);
  assert.deepEqual(h.weth.implementation, { address: "0xc6b81b429797e0f555440b70cd99e032d7ae947e", codehash: "0xbe1295f37be34ffe03ad779bda0ef278907e1856b51a3be2f35ee541d75d4650" });
  // the testnets stay CHAINS' own; no other name resolves (a prototype key included)
  assert.equal(chainOf("base-sepolia"), CHAINS["base-sepolia"]);
  for (const n of ["ethereum", "__proto__", "constructor"]) assert.equal(chainOf(n), undefined, n);
  assert.ok(!Object.hasOwn(CHAINS, "base"), "the testnet loops never meet a mainnet");
});

test("a mainnet record never folds into this run record: runRecord refuses it, and --write-record refuses it before any read", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const M = JSON.parse(readFileSync(new URL("./pool-evm-deploy-mainnet.answers.json", import.meta.url), "utf8")).records.base;
  const real = { ...M, dryRun: false };
  assert.throws(() => runRecord([real]), /base is a mainnet: its run record is pool-evm-deploy-mainnet\.md/);
  const f = path.join(mkdtempSync(path.join(tmpdir(), "ped-")), "base.json");
  writeFileSync(f, JSON.stringify(real));
  const r = spawnSync(process.execPath, [new URL("./pool-evm-deploy.mjs", import.meta.url).pathname, "--deployment", f, "--write-record"], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /base is a mainnet: its run record is pool-evm-deploy-mainnet\.md/);
  assert.doesNotMatch(r.stdout, /live-check pool-evm-deploy base:/, "nothing was read");
});
