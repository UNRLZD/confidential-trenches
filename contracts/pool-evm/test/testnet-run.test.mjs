// node --test contracts/pool-evm/test/testnet-run.test.mjs: the pure parts of script/testnet-run.mjs. Each call's data
// is byte for byte what `cast calldata` (Foundry 1.7.1) gives for the same signature and values
// (fixtures/testnet-run-calldata.json, recorded 4 Nov); the Withdraw digest is cast's (cast keccak of 0x1901 ‖ the
// domain ‖ the struct, recorded below); a type 4 transaction's signature recovers to its sender and carries the
// authorization as signed; a revert's custom error is named.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bytes, hex, keccak, selector } from "../../../scripts/live-checks/pool-evm-deploy.mjs";
import { intBytes, rlp } from "../script/deploy.mjs";
import { WITHDRAW_TRIES, authJson, buyData, depositData, revertName, sellData, signTx7702, stopper, v3QuoteData, v4QuoteData, withdrawData, withdrawDigest, withdrawLeft } from "../script/testnet-run-lib.mjs";

const V = JSON.parse(readFileSync(new URL("./fixtures/testnet-run-calldata.json", import.meta.url), "utf8"));
const { secp256k1 } = await import(createRequire(new URL("../../../packages/kit/package.json", import.meta.url)).resolve("@noble/curves/secp256k1.js"));
const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222", Z = "0x0000000000000000000000000000000000000000";
const PROOF = [[1n, 2n], [[3n, 4n], [5n, 6n]], [7n, 8n], [9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n]];

test("each call's data is cast calldata's, byte for byte", () => {
  assert.equal(depositData(5n, 6n), V.deposit);
  assert.equal(withdrawData(A, "0xaabbcc", PROOF, 17n, `0x${"ab".repeat(65)}`), V.withdraw);
  assert.equal(buyData(A, "0xaabbcc", PROOF, 17n, { adapter: B, data: "0x0102", minOut: 18n, token: A }, `0x${"cd".repeat(65)}`), V.buy);
  assert.equal(sellData({ token: A, amount: 1n, target: B, data: "0x0a0b0c", minOut: 2n, pool: A, precommitment: 3n, feeCap: 4n, feeRecipient: B, deadline: 5n, nonce: 6n }, 7n, `0x${"ef".repeat(65)}`), V.sell);
  assert.equal(v4QuoteData({ currency0: Z, currency1: A, fee: 100, tickSpacing: 1, hooks: Z }, true, 1000n), V.v4Quote);
  assert.equal(v3QuoteData(A, B, 1000n, 3000), V.v3Quote);
  // a changed value changes the data (the encoder reads every field)
  assert.notEqual(withdrawData(A, "0xaabbcc", PROOF, 18n, `0x${"ab".repeat(65)}`), V.withdraw);
});

test("the Withdraw digest is cast's for PrivacyPool.sol's typehash and domain", () => {
  assert.equal(hex(withdrawDigest(84532n, A, 1n, 2n, 3n)), "0xc849cd960be74eaa7edad7412b1ffdebfd3aaa01cda677dfa8905046afaeddf1");
  assert.notEqual(hex(withdrawDigest(84533n, A, 1n, 2n, 3n)), "0xc849cd960be74eaa7edad7412b1ffdebfd3aaa01cda677dfa8905046afaeddf1");
});

test("a type 4 transaction: its signature recovers to the sender, over 0x04 ‖ rlp of the fields and the authorization", () => {
  const sk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const auth = { chainId: 84532, address: B, nonce: 0n, yParity: 1, r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}` };
  const t = { chainId: 84532n, nonce: 3n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gas: 100_000n, to: A, value: 0n, data: "0xdeadbeef", authorizations: [auth] };
  const { raw, hash } = signTx7702(sk, t);
  assert.equal(raw.slice(0, 4), "0x04");
  assert.equal(hash, keccak(raw));
  const unsigned = [...[84532n, 3n, 1n, 2n, 100_000n].map(intBytes), bytes(A), intBytes(0n), bytes("0xdeadbeef"), [], [[intBytes(84532), bytes(B), intBytes(0n), intBytes(1), intBytes(BigInt(auth.r)), intBytes(BigInt(auth.s))]]];
  const body = rlp(unsigned);
  // the signed list is the unsigned one plus yParity, r, s: its payload starts with the unsigned list's payload
  const signed = bytes(raw).subarray(1);
  const payloadOf = (b) => (b[0] <= 0xf7 ? b.subarray(1) : b.subarray(1 + b[0] - 0xf7));
  assert.deepEqual(payloadOf(signed).subarray(0, payloadOf(body).length), payloadOf(body));
  const tail = payloadOf(signed).subarray(payloadOf(body).length);
  // yParity (1 byte), r and s (0xa0 + 32 bytes each, as neither starts with a zero byte here)
  const v = tail[0] === 0x80 ? 0 : tail[0];
  const r = tail.subarray(2, 34), s = tail.subarray(35, 67);
  const sig = new secp256k1.Signature(BigInt(hex(r)), BigInt(hex(s))).addRecoveryBit(v);
  const pub = sig.recoverPublicKey(bytes(keccak(Uint8Array.of(4, ...body)))).toBytes(false);
  assert.deepEqual(pub, secp256k1.getPublicKey(sk, false));
});

test("a revert names its custom error; unknown data is kept", () => {
  assert.equal(revertName(selector("PartialFill()")), "PartialFill()");
  assert.equal(revertName(`${selector("InvalidSignature()")}`), "InvalidSignature()");
  assert.equal(revertName("0x12345678"), "0x12345678");
  assert.equal(revertName(undefined), "no revert data");
});

// The stop path: the deployed pool has no ragequit (src/PrivacyPool.sol), so a note is only ever got out by a withdraw.
// A withdraw that cannot land (run 1's DeadlineExpired: an epoch read before a slow sync) is tried again, each try a
// fresh release (new trees, epoch, bind and proof), so a stopped run no longer leaves its notes in the pool.
const deadline = new Error("withdraw: the simulation reverts (DeadlineExpired()): execution reverted");
test("a withdraw that reverts DeadlineExpired is tried again with a fresh release, and lands", async () => {
  const notes = [{ ref: { kind: "deposit" }, value: 3n, spent: false }, { ref: { kind: "change" }, value: 0n, spent: false }];
  const calls = [], said = [];
  const ok = await withdrawLeft(notes, async (n) => { calls.push(n.ref.kind); if (calls.length === 1) throw deadline; n.spent = true; }, (m) => said.push(m));
  assert.equal(ok, true);
  assert.deepEqual(calls, ["deposit", "deposit"]); // the empty note is left alone
  assert.match(said[0], /withdraw of the deposit note \(3 wei\), try 1 of 3, failed: withdraw: the simulation reverts \(DeadlineExpired\(\)\)/);
});
test("a withdraw that never lands is tried WITHDRAW_TRIES times, the run is not done and the log names the note left", async () => {
  const notes = [{ ref: { kind: "change" }, value: 7n, spent: false }];
  let n = 0;
  const said = [];
  assert.equal(await withdrawLeft(notes, async () => { n++; throw deadline; }, (m) => said.push(m)), false);
  assert.equal(n, WITHDRAW_TRIES);
  assert.match(said.at(-1), /the change note \(7 wei\) stays in the pool after 3 tries/);
});
test("a note spent by a try that landed late is not tried again", async () => {
  const notes = [{ ref: { kind: "deposit" }, value: 2n, spent: false }];
  let n = 0;
  // the send throws after the withdraw landed (as a receipt read that times out would), and release marked it spent
  assert.equal(await withdrawLeft(notes, async (x) => { n++; x.spent = true; throw new Error("receipt: timed out"); }, () => {}), true);
  assert.equal(n, 1);
});

// Every name the run takes from the kit and the wallet is one they export (card evm-sell-v4-kit: from 1343935 on, the run
// called kit.evmPoolBuild, which the kit's index no longer exported, and failed only at its first buy). The run loads
// them with imp(path) at run time, so nothing checks a name before it is called: this test does, for each
// `const { a, b } = await imp(path)` and each `kit.<name>` of the kit's index.
const RUN = readFileSync(new URL("../script/testnet-run.mjs", import.meta.url), "utf8");
const REPO = new URL("../../../", import.meta.url);
async function unexported(src) {
  const missing = [];
  const named = [...src.matchAll(/const \{([^}]+)\} = await imp\("([^"]+)"\)/g)];
  for (const [, names, p] of named) {
    const m = await import(new URL(p, REPO).href);
    // a name as exported, before any rename (`evmNow: evmNowOnce`)
    for (const n of names.split(",").map((s) => s.split(":")[0].trim()).filter(Boolean)) if (!(n in m)) missing.push(`${n} from ${p}`);
  }
  const ns = [...src.matchAll(/const (\w+) = await imp\("([^"]+)"\)/g)];
  for (const [, bind, p] of ns) {
    const m = await import(new URL(p, REPO).href);
    for (const n of new Set([...src.matchAll(new RegExp(`\\b${bind}\\.(\\w+)`, "g"))].map((x) => x[1]))) if (!(n in m)) missing.push(`${bind}.${n} from ${p}`);
  }
  return { missing, named: named.length, ns: ns.length };
}
test("every name the run takes from the kit and the wallet is exported there", async () => {
  const r = await unexported(RUN);
  assert.deepEqual(r.missing, []);
  assert.equal(r.named, 6); // the dry run's quotes on the fork, and the wallet's pool, restore, notes, derive and queue
  assert.equal(r.ns, 1); // the kit's index as kit
  // planted: the name the run called from 1343935 on, and a destructured name the module does not export
  assert.deepEqual((await unexported(RUN.replace("kit.evmPoolBuildQuoted(adapters", "kit.evmPoolBuild(adapters"))).missing, ["kit.evmPoolBuild from packages/kit/src/index.ts"]);
  assert.deepEqual((await unexported(RUN.replace("{ evmPoolBuyQuoteWith, evmPoolSellQuoteWith }", "{ evmPoolBuyQuoteWith, evmPoolSellQuoteWith, evmPoolBuild }"))).missing, ["evmPoolBuild from packages/kit/src/checks/evm/quote.ts"]);
});

/** The builders and signers the run calls: the kit index's only, each buy and sell from a device quote. */
const pathOf = (src) => ({
  // a builder or signer that takes a route or a minOut from its caller, or any pinned or unpinned one under the index
  bypass: [...new Set([...src.matchAll(/\b(pinned\w+|evmPool\w*Unpinned|evmPoolRouteData\w*)\b/g)].map((m) => m[1]))],
  buy: /kit\.evmPoolBuildQuoted\(adapters\[[^\]]+\], q\)/.test(src) && /kit\.evmPoolBuyQuote\(q\)/.test(src) && /kit\.evmPoolSignBuy\(/.test(src),
  sell: /kit\.evmPoolBuildSell\(q, \{/.test(src) && /kit\.evmPoolSellQuote\(q\)/.test(src) && /kit\.evmPoolSignSell\(/.test(src),
});
test("the run buys and sells only through the device's quotes, as a user's device does (card evm-sell-device-quote)", () => {
  assert.deepEqual(pathOf(RUN), { bypass: [], buy: true, sell: true });
  // planted: the pinned buy builder and signer the run used before this card, and a sell that names its own route
  assert.deepEqual(pathOf(RUN.replace("kit.evmPoolBuildQuoted(adapters", "pinnedBuild(kit.evmPoolVenues(), chain, adapters")), { bypass: ["pinnedBuild"], buy: false, sell: true });
  assert.deepEqual(pathOf(RUN.replace("kit.evmPoolSignBuy(W.secretKey", "pinnedSignBuy(kit.evmPoolVenues(), W.secretKey")).bypass, ["pinnedSignBuy"]);
  assert.equal(pathOf(RUN.replace("kit.evmPoolBuildSell(q, {", "pinnedBuildSell(kit.evmPoolVenues(), chain, { route, ")).sell, false);
  assert.equal(pathOf(RUN.replace("kit.evmPoolSellQuote(q)", "evmPoolSellQuoteWith(q, rpcs, Date.now())")).sell, false);
});

test("an authorization's r and s go to eth_estimateGas as quantities: no leading zero digit (Robinhood testnet refused one, 4 Nov 14:2xZ)", () => {
  const a = { chainId: 46630n, address: "0x" + "11".repeat(20), nonce: 0n, yParity: 0, r: "0x00" + "ab".repeat(31), s: "0x0" + "c".repeat(63) };
  const j = authJson(a);
  assert.equal(j.r, "0x" + "ab".repeat(31));
  assert.equal(j.s, "0x" + "c".repeat(63));
  for (const k of ["chainId", "nonce", "yParity", "r", "s"]) assert.match(j[k], /^0x(0|[1-9a-f][0-9a-f]*)$/, k);
});

// ---- the run's wiring (card evm-buy-hookdata-fee, fold 4) ----

const run = await import("../script/testnet-run.mjs");
const kitIndex = await import("../../../packages/kit/src/index.ts");

test("--bind-from-s: a bind waits until the pool's time is at least s seconds into its epoch, reading it again after each wait, and binds that epoch", async () => {
  const E = 1_800_000_000_000n; // an epoch's start (60 s)
  // the pool's time is its newest block's: 2 s blocks, the newest 2.5 s behind the clock
  let clock = E + 3_000n;
  const pool = async () => ((clock - 2_500n) / 2_000n) * 2_000n;
  const sleeps = [];
  const r = await run.bindEpoch(25, pool, async (ms) => (sleeps.push(ms), (clock += BigInt(ms))));
  // 0 s in: a wait of 25 s, then the pool reads 24 s, a wait of 1 s, then 26 s
  assert.deepEqual(sleeps, [25_000, 1_000]);
  assert.deepEqual(r, { epochStartMs: E, into: 26_000n });
  // already past it: no wait, this epoch; at 0 s: at once
  let t = E + 40_000n;
  sleeps.length = 0;
  assert.deepEqual(await run.bindEpoch(25, async () => t, async (ms) => void sleeps.push(ms)), { epochStartMs: E, into: 40_000n });
  assert.deepEqual(sleeps, []);
  t = E + 1n;
  assert.deepEqual(await run.bindEpoch(0, async () => t, async () => assert.fail("no wait at 0 s")), { epochStartMs: E, into: 1n });
  // an s past an epoch is refused before any read
  for (const s of ["60", "-1", "2.5", "x"]) {
    await assert.rejects(run.main(["--chain", "base-sepolia", "--return", "0x00000000000000000000000000000000000a11ce", "--bind-from-s", s], { fetchFn: () => assert.fail("no read") }), /--bind-from-s/);
  }
});

test("the fee's state reads go to the kit pin's providers, the sync to the run's pair, and the device takes both (Robinhood's PublicNode keeps 15 s of state)", () => {
  // the kit pin's fee pair, as the device's (card notes-per-pool-evm-base-hang: the pool pair is the sync's)
  for (const chain of ["base-sepolia", "robinhood-testnet"]) assert.deepEqual(run.feeProviders(chain, undefined), kitIndex.evmPoolVenues()[chain].feeProviders, chain);
  assert.notDeepEqual(run.feeProviders("robinhood-testnet", undefined), run.NETS["robinhood-testnet"].rpcs, "not the sync's pair");
  assert.deepEqual(run.feeProviders("base-sepolia", "http://127.0.0.1:1,http://127.0.0.1:2"), ["http://127.0.0.1:1", "http://127.0.0.1:2"], "a dry run's fork for both");
  // the device gets the run's fee pair as its feeRpcs: a pair that is not two providers is refused at once
  const r = (url) => Object.assign(async () => assert.fail("no read"), { url });
  const pin = { network: "base-sepolia", pool: "0x00000000000000000000000000000000b1f1f001", feeRecipient: "0x000000000000000000000000000000000000fee1", fromBlock: 1n };
  const rpcs = [r("https://a.example"), r("https://b.example")];
  assert.ok(run.deviceOf({ pin, rpcs, feeRpcs: [r("https://c.example"), r("https://d.example")], relayFee: async () => null }));
  assert.throws(() => run.deviceOf({ pin, rpcs, feeRpcs: [r("https://c.example")], relayFee: async () => null }), /feeRpcs: two or more/);
  assert.throws(() => run.deviceOf({ pin, rpcs, feeRpcs: [r("https://c.example"), r("https://c.example")], relayFee: async () => null }), /one provider twice/);
});

test("main takes its fee providers, its bind seconds and the device's arguments from wiringOf: the fee's reads on the kit pin's pair, the sync on the run's, each bind at --bind-from-s", async () => {
  assert.equal(typeof run.wiringOf, "function", "testnet-run.mjs wiringOf");
  const chain = "robinhood-testnet";
  const pinned = kitIndex.evmPoolVenues()[chain].feeProviders;
  assert.notDeepEqual(pinned, run.NETS[chain].rpcs, "the fee pair is not the sync's pair");
  const asked = [];
  const fetchFn = async (u, init) => (asked.push([u, JSON.parse(init.body).method]), new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0xb626" })));
  let clock = 1_800_000_000_000n + 3_000n; // 3 s into an epoch
  const sleeps = [];
  const sleep = async (ms) => (sleeps.push(ms), (clock += BigInt(ms)));
  const w = run.wiringOf(["--chain", chain, "--return", "0x00000000000000000000000000000000000a11ce", "--bind-from-s", "25"], { fetchFn, sleep });
  const urlsOf = (rs) => rs.map((r) => r.url);
  assert.deepEqual(w.feeUrls, pinned, "the fee's providers: the kit pin's");
  assert.deepEqual(urlsOf(w.feeRpcs), pinned);
  assert.deepEqual(urlsOf(w.rpcs), run.NETS[chain].rpcs, "the sync: the run's pair");
  assert.notDeepEqual(urlsOf(w.feeRpcs), urlsOf(w.rpcs));
  // each fee RPC reads through the run's fetch, at its own URL
  assert.equal(await w.feeRpcs[1]("eth_chainId", []), "0xb626");
  assert.deepEqual(asked, [[pinned[1], "eth_chainId"]]);
  // the device's arguments: the run's pair for the sync, the fee pair for the fee's reads, the pin and relayFee as given
  const pin = { network: chain, pool: "0x00000000000000000000000000000000b1f1f001", feeRecipient: "0x000000000000000000000000000000000000fee1", fromBlock: 1n };
  const relayFee = async () => null;
  const a = w.deviceArgs(pin, relayFee);
  assert.deepEqual([a.pin, a.relayFee, urlsOf(a.rpcs), urlsOf(a.feeRpcs)], [pin, relayFee, run.NETS[chain].rpcs, pinned]);
  assert.ok(run.deviceOf(a));
  // a bind at --bind-from-s 25: 3 s in, it waits 22 s and binds that epoch
  assert.deepEqual(await w.bind(async () => clock), { epochStartMs: 1_800_000_000_000n, into: 25_000n });
  assert.deepEqual(sleeps, [22_000]);
  // a dry run's fork for both pairs
  const d = run.wiringOf(["--chain", "base-sepolia", "--return", "0x00000000000000000000000000000000000a11ce", "--rpc", "http://127.0.0.1:1,http://localhost:2", "--out", "/dev/null"], { fetchFn, sleep });
  assert.deepEqual([urlsOf(d.rpcs), d.feeUrls, d.dryRun, d.bindFromS], [["http://127.0.0.1:1", "http://localhost:2"], ["http://127.0.0.1:1", "http://localhost:2"], true, 0]);
  // and main builds its device and binds through it, never with its own wiring
  assert.match(RUN, /export async function main\(args, io = \{\}\) \{\n  const w = wiringOf\(args, io\);\n/);
  assert.match(RUN, /const device = deviceOf\(w\.deviceArgs\(pin, relayFee\)\);/);
  assert.match(RUN, /await w\.bind\(\(\) => evmNow\(rpcs\)\);/);
  const body = RUN.split("export async function main(")[1];
  assert.doesNotMatch(body, /\b(feeProviders|bindEpoch|evmPool)\(|bindFromS|--rpc"|--bind-from-s"/, "no second source of the fee's providers, the bind seconds or the device");
});

test("every sell signs the chain's FeeCollector, the kit's feeCollector pin, as its fee recipient, never the helper's fee answer; --sell-fee-to is gone (card evm-testnet-delegate-review3)", () => {
  const base = ["--chain", "base-sepolia", "--return", "0x00000000000000000000000000000000000a11ce"];
  const io = { fetchFn: async () => new Response("{}"), sleep: async () => {} };
  assert.equal(run.wiringOf(base, io).sellFeeTo, undefined);
  assert.doesNotMatch(RUN, /--sell-fee-to|sellFeeTo|fee_recipient\)/);
  assert.doesNotMatch(RUN, /\/v1\/pool\/fee\?pool=/, "the run reads no fee recipient from the helper");
  assert.match(RUN, /const feeTo = lower\(kit\.evmPoolVenues\(\)\[chain\]\.feeCollector \?\? ""\);\n/);
  assert.match(RUN, /kit\.evmPoolBuildSell\(q, \{ feeRecipient: feeTo,/);
  assert.match(RUN, /coin: token, feeTo \};/);
});

test("the run's restore reads each W's Transfers on the wallet's own EVM_TRANSFER_RPCS, never a provider of the run's pool pair: one in both lists is dropped from the W reads, two or more left (cards wallet-restore-transfer-rpcs, evm-transfer-rpc-spares)", async () => {
  const { EVM_TRANSFER_RPCS } = await import("../../../packages/wallet/src/pool/evm.ts");
  const host = (u) => new URL(u).hostname;
  // Robinhood testnet's own RPC is both the run's pool provider and the Transfer list's third there, and Base Sepolia's
  // Pocket both the kit's pool pair's second (the run's pair since card evm-testnet-delegate-review3, fold 7, as on the
  // device) and the Transfer list's second: neither ever gets a W
  const shared = { "base-sepolia": ["base-testnet.api.pocket.network"], "robinhood-testnet": ["rpc.testnet.chain.robinhood.com"] };
  for (const chain of ["base-sepolia", "robinhood-testnet"]) {
    assert.equal(run.NETS[chain].walletRpcs, EVM_TRANSFER_RPCS[chain], `${chain}: one source`);
    const pool = run.NETS[chain].rpcs.map(host);
    assert.deepEqual(run.NETS[chain].walletRpcs.map(host).filter((h) => pool.includes(h)), shared[chain], chain);
    assert.ok(run.NETS[chain].walletRpcs.filter((u) => !pool.includes(host(u))).length >= 2, `${chain}: two W providers left`);
  }
});

// a SIGTERM during the syncs' walk (Base Sepolia, 6 Nov 18:46Z: sepolia.base.org's 200-block log cap made it hours long)
// ends the wait at once, so the run goes to its sweep, and the run awaits the walk only through the stop
test("a stop ends a wait that never ends at once, and a wait that ends first gives its answer", async () => {
  const s = stopper();
  const never = new Promise(() => {});
  const t = s.until(never);
  setTimeout(() => s.fire("SIGTERM"), 10);
  assert.equal(await t, s.STOPPED);
  assert.equal(await s.until(never), s.STOPPED, "a wait begun after the stop ends at once");
  const s2 = stopper();
  assert.equal(await s2.until(Promise.resolve(7)), 7);
  await assert.rejects(s2.until(Promise.reject(new Error("walk failed"))), /walk failed/);
  const src = readFileSync(new URL("../script/testnet-run.mjs", import.meta.url), "utf8");
  assert.match(src, /await stop\.until\(warm\);\n\s*go\(\);/, "the run awaits the syncs only through the stop, then checks it");
  assert.doesNotMatch(src, /await warm\b/, "no bare wait on the syncs");
  assert.match(src, /stopped = s;\n\s*stop\.fire\(s\);/, "the signal fires the stop");
});

// card evm-testnet-delegate-review3, fold 7: the run syncs and sends on the kit's pinned providers for each testnet, the
// pair the device's pool sync pages the pool's logs on; never sepolia.base.org, whose 200-block eth_getLogs cap held
// Base Sepolia run 1's syncs 2134 s
test("each testnet's run pair is the kit's pinned providers, never sepolia.base.org", async () => {
  const { NETS } = await import("../script/testnet-run.mjs");
  const { evmPoolVenues } = await import("../../../packages/kit/src/index.ts");
  for (const c of ["base-sepolia", "robinhood-testnet"]) {
    assert.deepEqual(NETS[c].rpcs, [...evmPoolVenues()[c].providers], c);
    assert.equal(NETS[c].rpcs.length, 2, c);
    assert.ok(!NETS[c].rpcs.some((u) => new URL(u).hostname === "sepolia.base.org"), c);
  }
});

test("the run funds each buy for the kit's G(depth) at every tree depth: its limit, the estimate x 13/10, is at most ceil(G x 13/12) (card evm-buy-gas-depth)", () => {
  const { evmPoolGas, EVM_POOL_MAX_DEPTH } = kitIndex;
  for (let d = 0; d <= EVM_POOL_MAX_DEPTH; d++) {
    // G holds the helper's limit (the estimate x 12/10), so the estimate is at most G x 10/12
    const runLimit = (((evmPoolGas(d) * 10n) / 12n) * 13n) / 10n;
    assert.ok(run.GAS.buy >= runLimit, `depth ${d}: GAS.buy ${run.GAS.buy} under the run's limit ${runLimit}`);
  }
  // the heaviest estimate the kit measures at depth 32 (test/evm-pool-fee.test.ts: forge least 1,732,470, plus 59,464
  // intrinsic and calldata, x 1000/985) at the run's x 13/10
  assert.ok(run.GAS.buy >= (1_819_223n * 13n) / 10n);
  assert.equal(run.GAS.buy, (evmPoolGas(EVM_POOL_MAX_DEPTH) * 13n + 11n) / 12n);
  assert.equal(run.GAS.buy, 2_377_227n);
  // and the need carries it, one per venue
  const maxFee = 2_000_000_000n;
  const { parts } = run.needOf({ venues: ["a", "b"], maxFee, l1: 5n });
  assert.equal(Object.fromEntries(parts).buys, 2n * (2_377_227n * maxFee + 5n));
});
