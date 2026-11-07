// node --test scripts/live-checks/helper-pool-senders.test.mjs: the live check replays recorded runs
// (helper-pool-senders.answers.json). good: apps/helper at this card with a devnet pool set: PASS. bad: the same helper
// with no pool set, as the deployed helper is before this card: FAIL. Made from the good run: a planted transaction
// carried, two callers given two fees, a fee other than the kit's for the rent read (2,000,000 for both callers, M362
// (2)), rent reads missing or disagreeing, another pool answered: each FAIL.
// The planted transactions are checked against the helper's own checks, so the check plants what the route reads.
// EVM pools (card helper-evm-sender-2): evm_bad, the deployed helper before the card on both testnet pools: FAIL; each
// plant carried, refused with another code or missing, and the code reads wrong: each FAIL; the encoder and W's
// signatures equal cast's (helper-pool-senders.cast.json); read() posts each plant as its line says.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkSolanaPoolTx } from "../../apps/helper/src/pool/solana.ts";
import { evmPoolVenues, solanaDecodeTransaction, solanaPoolPriorityBudget } from "../../packages/kit/src/index.ts";
import { b58decode, b58encode, EVM, EVM_PLANTS, judge, kitFee, MAINNET_PLANTS, plant, PLANTS, plantsFor, read, readEvm, RENT_RPCS } from "./helper-pool-senders.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = JSON.parse(readFileSync(path.join(HERE, "helper-pool-senders.answers.json"), "utf8"));
const bad = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const edit = (run, asked, f) => ({ ...run, reads: run.reads.map((x, i) => (x.asked === asked ? f(x, i) : x)) });
const body = (x, f) => ({ ...x, body: JSON.stringify(f(JSON.parse(x.body))) });

test("recorded good run: the fee published the same to two callers, both planted transactions refused: PASS", () => {
  const r = judge(A.good);
  assert.equal(r.ok, true, r.lines.join("\n"));
});

test("recorded bad run: a helper with no pool (404): FAIL", () => {
  const r = judge(A.bad_unconfigured);
  assert.equal(r.ok, false);
  assert.ok(bad(r).includes("BAD [fee APP_HOST] GET /v1/pool/fee answers 404"), bad(r).join("\n"));
});

test("made from the good run: a planted transaction carried, two fees, a fee under cost or off step, another pool: each FAIL", () => {
  const g = A.good;
  assert.equal(judge(edit(g, "changed", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  assert.equal(judge(edit(g, "fee_off", (x) => ({ ...x, status: 422, body: '{"error":{"code":"simulation_failed"}}' }))).ok, false);
  let n = 0;
  assert.equal(judge(edit(g, "fee", (x) => (n++ === 1 ? body(x, (b) => ({ ...b, fee: "2100000" })) : x))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "1000000" })))).ok, false);
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "2000001" })))).ok, false);
  assert.equal(judge({ ...g, pool: "11111111111111111111111111111111" }).ok, false);
  // M362 (2): a fee on its step and above the cost, the same for both callers, but not the kit's for the rent read
  const two = judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "2000000" }))));
  assert.equal(two.ok, false);
  assert.ok(bad(two).some((l) => l.includes('fee "2000000"') && l.includes("the kit's fee for the rent read 1300000")), bad(two).join("\n"));
  assert.equal(judge(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "1100000" })))).ok, false);
  // the rent reads: missing, one only, from other RPCs, or disagreeing
  assert.equal(judge({ ...g, rent: undefined }).ok, false);
  assert.equal(judge({ ...g, rent: g.rent.slice(0, 1) }).ok, false);
  assert.equal(judge({ ...g, rent: [g.rent[1], g.rent[0]] }).ok, false);
  const r17 = Buffer.alloc(17);
  r17.writeBigUInt64LE(3_480n, 0);
  r17.writeDoubleLE(1, 8);
  r17[16] = 50;
  const other = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [r17.toString("base64"), "base64"] } } });
  assert.equal(judge({ ...g, rent: [g.rent[0], { ...g.rent[1], body: other }] }).ok, false, "the two RPCs disagree");
  for (const [asked] of PLANTS) {
    assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== asked) }).ok, false, `${asked} missing`);
    assert.equal(judge(edit(g, asked, (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false, `${asked} carried`);
  }
});

test("plant() builds what the helper's checks read: each plant gets its own code from the bytes alone, as is: ok", () => {
  const f = JSON.parse(A.good.reads[0].body);
  const kit = kitFee(A.good, f.cluster);
  assert.ok(kit);
  const fee = BigInt(f.fee);
  assert.equal(fee, kit.fee);
  const budget = solanaPoolPriorityBudget(kit.rent, fee);
  assert.equal(kit.budget, budget);
  const cfg = { program: f.program, pool: f.pool, feePayer: f.fee_payer, budget };
  const nowMs = 1_800_000_000_000;
  // M369 (M2): every plant as a devnet helper (no Jito) and as a mainnet one (Jito on) checks it
  for (const jito of [false, true]) {
    const at = (wire) => {
      const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee, budget, nowMs, jito });
      return c.ok ? "ok" : c.code;
    };
    for (const [asked, code] of plantsFor(jito ? "mainnet" : "devnet")) assert.equal(at(asked === "fee_off" ? plant({ ...cfg, relayFee: fee + 100_000n, nowMs }) : plant({ ...cfg, relayFee: fee, kind: asked, nowMs })), code, `${asked}, Jito ${jito ? "on" : "off"}`);
    assert.equal(at(plant({ ...cfg, relayFee: fee, nowMs })), "ok", `the good tag 2, Jito ${jito ? "on" : "off"}`);
    assert.equal(at(plant({ ...cfg, relayFee: fee, kind: "tip_low", nowMs })), jito ? "tip_low" : "ok", "tip_low: refused only where a bundle is sent, so it is planted only on mainnet");
  }
  assert.deepEqual(plantsFor("mainnet"), [...PLANTS, ...MAINNET_PLANTS]);
  assert.deepEqual(plantsFor("devnet"), PLANTS);
  const at = (wire) => {
    const c = checkSolanaPoolTx(new Uint8Array(wire), { ...cfg, fee, budget, nowMs });
    return c.ok ? "ok" : c.code;
  };
  assert.equal(b58encode(b58decode(f.pool)), f.pool);
  // M362 (4): fee_below_cost's priority is exactly the budget plus one lamport, so a helper whose budget lost even the
  // page reserve (budget + 715) would carry it and fail the check; at the budget itself the helper carries it
  const pr = (wire) => {
    const m = solanaDecodeTransaction(new Uint8Array(wire)).message;
    const ixs = m.instructions.filter((i) => m.staticKeys[i.programIndex] === "ComputeBudget111111111111111111111111111111");
    const limit = ixs.find((i) => i.data[0] === 2);
    const price = ixs.find((i) => i.data[0] === 3);
    const l = BigInt(Buffer.from(limit.data).readUInt32LE(1));
    const p = Buffer.from(price.data).readBigUInt64LE(1);
    return (p * l + 999_999n) / 1_000_000n;
  };
  assert.equal(pr(plant({ ...cfg, relayFee: fee, kind: "fee_below_cost", nowMs })), budget + 1n);
  assert.equal(at(plant({ ...cfg, budget: budget - 1n, relayFee: fee, kind: "fee_below_cost", nowMs })), "ok", "a priority of exactly the budget is carried");
  const looser = checkSolanaPoolTx(new Uint8Array(plant({ ...cfg, relayFee: fee, kind: "fee_below_cost", nowMs })), { ...cfg, fee, budget: budget + 715n, nowMs });
  assert.equal(looser.ok, true, "a budget without the page reserve would let the plant through, so the check catches it");
});

test("read() asks the fee twice and plants two transactions for the pool (replayed helper)", async () => {
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const rent = A.good.rent.find((x) => x.url === url);
    asked.push(rent ? `rent ${url}` : `${init.method ?? "GET"} ${u.pathname}`);
    if (rent) return new Response(rent.body, { status: rent.status });
    const r = u.pathname === "/v1/pool/fee" ? A.good.reads[0] : A.good.reads.find((x) => x.asked === "changed");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", A.good.pool, fetchFn);
  const cluster = JSON.parse(A.good.reads[0].body).cluster;
  assert.deepEqual(asked, ["GET /v1/pool/fee", "GET /v1/pool/fee", ...RENT_RPCS[cluster].map((u) => `rent ${u}`), ...PLANTS.map(() => "POST /v1/pool/solana/send")]);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...PLANTS.map(([a]) => a)]);
  assert.equal(run.rent.length, 2);
});

// M369 (M2): a mainnet helper, made from the good run (the same rent on mainnet's two RPCs, the cluster mainnet, and the
// mainnet plant tip_low refused): PASS; without the tip_low read, or with it carried: FAIL. And read() plants it there.
const mainnetRun = () => {
  const g = A.good;
  const urls = RENT_RPCS.mainnet;
  return {
    ...g,
    rent: g.rent.map((x, i) => ({ ...x, url: urls[i] })),
    reads: [
      ...g.reads.map((x) => (x.asked === "fee" ? body(x, (b) => ({ ...b, cluster: "mainnet" })) : x)),
      { ...g.reads.find((x) => x.asked === "inner_program"), asked: "tip_low", body: '{"error":{"code":"tip_low"}}' },
    ],
  };
};
test("M369 (M2): a mainnet helper refusing every plant and tip_low: PASS; tip_low missing or carried: FAIL", () => {
  const m = mainnetRun();
  const r = judge(m);
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(judge({ ...m, reads: m.reads.filter((x) => x.asked !== "tip_low") }).ok, false);
  assert.equal(judge(edit(m, "tip_low", (x) => ({ ...x, status: 200, body: '{"signature":"x"}' }))).ok, false);
  // a mainnet answer for a plant other than its own code (the bug M369 (M2) found: tip_low for every tag 3): FAIL
  assert.equal(judge(edit(m, "inner_program", (x) => ({ ...x, body: '{"error":{"code":"tip_low"}}' }))).ok, false);
});

test("M369 (M2): read() plants tip_low on a mainnet pool (replayed helper)", async () => {
  const m = mainnetRun();
  const asked = [];
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    const rent = m.rent.find((x) => x.url === url);
    asked.push(rent ? "rent" : `${init.method ?? "GET"} ${u.pathname}`);
    if (rent) return new Response(rent.body, { status: rent.status });
    const r = u.pathname === "/v1/pool/fee" ? m.reads[0] : m.reads.find((x) => x.asked === "changed");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const run = await read("http://h.invalid", m.pool, fetchFn);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...plantsFor("mainnet").map(([a]) => a)]);
  assert.ok(run.reads.some((x) => x.asked === "tip_low"));
});

// ---- card helper-evm-sender-2: the EVM pools (POST /v1/pool/evm/send) ----
// evm_bad: the deployed helper before this card (it does not check W's signature or decode a buy), recorded live
// against both testnet pools: FAIL. The encoder and W's signatures are held to cast (helper-pool-senders.cast.json,
// made by helper-pool-senders.cast.mjs from the contracts' type strings), never to the helper's code.
const CAST = JSON.parse(readFileSync(path.join(HERE, "helper-pool-senders.cast.json"), "utf8"));
const SOL = (f) => readFileSync(path.join(HERE, "../../contracts/pool-evm/src", f), "utf8");

test("EVM: the encoder's RelayData, withdraw and buy calldata and W's Withdraw and Buy signatures equal cast's", () => {
  const c = CAST.release;
  assert.equal(EVM.WITHDRAW_TYPE, CAST.withdrawString);
  assert.equal(EVM.BUY_TYPE, CAST.buyString);
  // the type strings the fixture was made from are the contracts' today
  assert.ok(SOL("PrivacyPool.sol").includes(`'${CAST.withdrawString}'`) && SOL("PrivacyPool.sol").includes(`'${CAST.domainString}'`));
  assert.ok(SOL("PrivacyPoolSimple.sol").includes(`'${CAST.buyString}'`));
  const key = EVM.anvilKey();
  assert.equal(EVM.addressOf(key), CAST.w, "m/44'/60'/0'/0/0 of the test mnemonic is cast's anvil account 0");
  assert.equal(EVM.addressOf(key), EVM.ANVIL0);
  const big = (x) => BigInt(x);
  const proof = { pA: c.pA.map(big), pB: c.pB.map((r) => r.map(big)), pC: c.pC.map(big), pubSignals: c.pubSignals.map(big) };
  const rd = EVM.relayData({ recipient: CAST.w, feeRecipient: c.feeRecipient, feeCap: big(c.feeCap), deadlineMs: big(c.deadlineMs), refundPrecommitment: big(c.refundPrecommitment), salt: c.salt });
  assert.equal(rd, CAST.relayData);
  assert.equal((rd.length - 2) / 2, 192, "exactly abi.encode(RelayData)");
  const at = { chainId: c.chainId, pool: c.pool, nullifier: proof.pubSignals[1], value: proof.pubSignals[2], context: proof.pubSignals[7] };
  const buy = { adapter: c.buy.adapter, data: c.buy.data, minOut: big(c.buy.minOut), token: c.buy.token };
  assert.equal(EVM.withdrawDigest(at), CAST.withdrawDigest);
  assert.equal(EVM.buyDigest({ ...at, buy }), CAST.buyDigest);
  const ws = EVM.sign65(key, EVM.withdrawDigest(at));
  const bs = EVM.sign65(key, EVM.buyDigest({ ...at, buy }));
  assert.equal(ws, CAST.withdrawSignature);
  assert.equal(bs, CAST.buySignature);
  assert.equal(EVM.withdrawCalldata({ processooor: c.pool, data: rd, proof, fee: big(c.fee), signature: ws }), CAST.withdrawCallData);
  assert.equal(EVM.buyCalldata({ processooor: c.pool, data: rd, proof, fee: big(c.fee), buy, signature: bs }), CAST.buyCallData);
  assert.equal(CAST.withdrawCallData.slice(0, 10), "0x94374b2b");
  assert.equal(CAST.buyCallData.slice(0, 10), "0x3edadd79");
  assert.equal(EVM.recover(EVM.withdrawDigest(at), ws), CAST.w);
});

test("EVM: recorded bad run, the deployed helper before this card (no W signature check, no buy decode): FAIL", () => {
  for (const run of A.evm_bad) {
    const r = judge(run);
    assert.equal(r.ok, false, run.pool);
    const b = bad(r);
    assert.ok(b.some((l) => l.includes("planted evm_bad_signature") && l.includes("want 422 bad_signature")), b.join("\n"));
    assert.ok(b.some((l) => l.includes("planted evm_buy_bad_signature") && l.includes("want 422 bad_signature")), b.join("\n"));
    // what the fee answer, the code reads and the headers say is right, so only the plants fail
    assert.ok(b.every((l) => /planted evm_/.test(l)), b.join("\n"));
  }
});

test("EVM: each recorded run is stripped to what the judge reads (no full answers)", () => {
  for (const run of [...A.evm_bad, ...(A.evm_good ?? [])]) {
    for (const x of run.reads) assert.deepEqual(Object.keys(x.headers).filter((h) => !["x-helper-commit", "access-control-allow-origin"].includes(h)), [], run.pool);
    for (const x of run.code) assert.ok(x.body.length < 300, x.url);
  }
});

// Made from the good runs (from the bad ones while no good run is recorded: each mutation is held to its own BAD line,
// so it shows the judge catches that defect whatever else the run has wrong).
const evmBase = () => A.evm_good ?? A.evm_bad;
const badLine = (run, re) => {
  const r = judge(run);
  return !r.ok && bad(r).some((l) => re.test(l));
};
test("EVM made from the recorded runs: each plant carried, refused with another code, or missing; the code reads missing, one, reordered, empty or an error; a fee off; a header wrong: each FAIL on its own line", () => {
  for (const g of evmBase()) {
    for (const [asked, code] of EVM_PLANTS) {
      const want = new RegExp(`^BAD planted ${asked}: .*want 422 ${code}`);
      assert.ok(badLine(edit(g, asked, (x) => ({ ...x, status: 200, body: '{"hash":"0x01"}' })), want), `${asked} carried`);
      assert.ok(badLine(edit(g, asked, (x) => ({ ...x, status: 422, body: '{"error":{"code":"simulation_failed"}}' })), want), `${asked} refused as simulation_failed`);
      assert.ok(badLine(edit(g, asked, (x) => ({ ...x, status: 400, body: `{"error":{"code":"${code}"}}` })), want), `${asked} with its code but 400`);
      assert.ok(badLine({ ...g, reads: g.reads.filter((x) => x.asked !== asked) }, want), `${asked} missing`);
    }
    const codeBad = /^BAD eth_getCode of anvil's account 0/;
    assert.ok(badLine({ ...g, code: undefined }, codeBad), "no code reads");
    assert.ok(badLine({ ...g, code: g.code.slice(0, 1) }, codeBad), "one code read");
    assert.ok(badLine({ ...g, code: [g.code[1], g.code[0]] }, codeBad), "the two providers out of order");
    assert.ok(badLine({ ...g, code: [g.code[0], { ...g.code[0] }] }, codeBad), "one provider read twice");
    const empty = (x) => ({ ...x, body: '{"jsonrpc":"2.0","id":1,"result":"0x"}' });
    const e1 = judge({ ...g, code: [g.code[0], empty(g.code[1])] });
    assert.ok(!e1.ok && bad(e1).some((l) => codeBad.test(l) && l.includes(`no code on ["${g.code[1].url}"]`)), bad(e1).join("\n"));
    assert.ok(badLine({ ...g, code: g.code.map(empty) }, codeBad), "no code on either: never not applicable, anvil 0 has code on every network");
    assert.ok(badLine({ ...g, code: [g.code[0], { ...g.code[1], status: 429, body: "Too Many Requests" }] }, codeBad), "a provider's error");
    assert.ok(badLine({ ...g, code: [g.code[0], { ...g.code[1], body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32000}}' }] }, codeBad), "an RPC error");
    // the fee answers
    assert.ok(badLine({ ...g, pool: "0x000000000000000000000000000000000000beef" }, /^BAD \[fee APP_HOST\] chain "evm"/), "another pool answered");
    assert.ok(badLine(edit(g, "fee", (x) => body(x, (b) => ({ ...b, fee: "10000000000001" }))), /fee "10000000000001" wei on its step/), "a fee off its step");
    assert.ok(badLine(edit(g, "fee", (x) => body(x, (b) => ({ ...b, chain: "solana" }))), /chain "solana"/), "the chain not evm");
    assert.ok(badLine(edit(g, "fee", (x) => body(x, (b) => ({ ...b, extra: 1 }))), /fields:/), "a field more");
    assert.ok(badLine(edit(g, "fee", (x) => body(x, (b) => ({ ...b, network: "nowhere" }))), /the kit's venue for network "nowhere"/), "a network the kit has no venue for");
    let n = 0;
    assert.ok(badLine(edit(g, "fee", (x) => (n++ === 1 ? body(x, (b) => ({ ...b, fee: (BigInt(b.fee) + 10_000_000_000_000n).toString() })) : x)), /the same fee recipient for both callers, and the same fee within one epoch/), "two fees within one epoch");
    n = 0;
    assert.ok(!badLine(edit(g, "fee", (x) => (n++ === 1 ? body(x, (b) => ({ ...b, epoch_start_ms: b.epoch_start_ms + 60_000, fee: (BigInt(b.fee) + 10_000_000_000_000n).toString() })) : x)), /the same fee recipient for both callers/), "two epochs may have two fees");
    assert.equal(judge({ ...g, reads: g.reads.filter((x) => x.asked !== "fee" || x.origin) }).ok, false, "one fee read");
    // the headers
    assert.ok(badLine(edit(g, "evm_recipient_code", (x) => ({ ...x, headers: { ...x.headers, "x-helper-commit": "63c9022" } })), /^BAD \[evm_recipient_code\] X-Helper-Commit/));
    assert.ok(badLine(edit(g, "fee", (x) => ({ ...x, headers: { ...x.headers, "access-control-allow-origin": "*" } })), /^BAD \[fee\] Access-Control-Allow-Origin: "\*"/));
  }
});

// a solc-style reader of the plants' calldata, written apart from the encoder: it follows each offset
function decodeRelease(hexData) {
  const b = Buffer.from(hexData.slice(2), "hex");
  const sel = b.subarray(0, 4).toString("hex");
  const args = b.subarray(4);
  const word = (buf, at) => BigInt(`0x${buf.subarray(at, at + 32).toString("hex")}`);
  const addr = (buf, at) => `0x${buf.subarray(at + 12, at + 32).toString("hex")}`;
  const bytesAt = (buf, at) => {
    const len = Number(word(buf, at));
    return buf.subarray(at + 32, at + 32 + len);
  };
  const w = Number(word(args, 0));
  const withdrawal = { processooor: addr(args, w), data: bytesAt(args, w + Number(word(args, w + 32))) };
  const words = Array.from({ length: 16 }, (_, i) => word(args, 32 + 32 * i));
  const fee = word(args, 32 * 17);
  const isBuy = sel === "3edadd79";
  let buy;
  if (isBuy) {
    const o = Number(word(args, 32 * 18));
    buy = { adapter: addr(args, o), data: `0x${bytesAt(args, o + Number(word(args, o + 32))).toString("hex")}`, minOut: word(args, o + 64), token: addr(args, o + 96) };
  }
  const sig = `0x${bytesAt(args, Number(word(args, 32 * (isBuy ? 19 : 18)))).toString("hex")}`;
  const d = withdrawal.data;
  const relay = { recipient: addr(d, 0), feeRecipient: addr(d, 32), feeCap: word(d, 64), deadlineMs: word(d, 96), length: d.length };
  return { sel, withdrawal, pubSignals: words.slice(8), words, fee, buy, sig, relay };
}

test("EVM: read() asks the fee twice and anvil 0's code on the venue's two fee providers, then posts the four plants, each the release its line says (replayed helper)", async () => {
  const g = evmBase()[0];
  const f = JSON.parse(g.reads[0].body);
  const asked = [];
  const posted = [];
  const fetchFn = async (url, init) => {
    const c = g.code.find((x) => x.url === url);
    if (c) {
      asked.push(`code ${url} ${JSON.parse(init.body).method} ${JSON.parse(init.body).params.join(" ")}`);
      return new Response(c.body, { status: c.status });
    }
    const u = new URL(url);
    asked.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === "/v1/pool/evm/send") posted.push(JSON.parse(init.body));
    const r = u.pathname === "/v1/pool/fee" ? g.reads[0] : g.reads.find((x) => x.asked === "evm_recipient_code");
    return new Response(r.body, { status: r.status, headers: r.headers });
  };
  const now = f.epoch_start_ms + 25_000;
  const run = await readEvm("http://h.invalid", g.pool, fetchFn, { nowMs: () => now });
  const venue = evmPoolVenues()[f.network];
  assert.deepEqual(asked, ["GET /v1/pool/fee", "GET /v1/pool/fee", ...venue.feeProviders.map((u) => `code ${u} eth_getCode ${EVM.ANVIL0} latest`), ...EVM_PLANTS.map(() => "POST /v1/pool/evm/send")]);
  assert.deepEqual(run.reads.map((x) => x.asked), ["fee", "fee", ...EVM_PLANTS.map(([a]) => a)]);
  assert.equal(run.code.length, 2);
  const P = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
  const plants = Object.fromEntries(EVM_PLANTS.map(([a], i) => [a, posted[i]]));
  const nullifiers = new Set();
  for (const [a, p] of Object.entries(plants)) {
    assert.deepEqual(Object.keys(p), ["pool", "data", "epoch"], a);
    assert.equal(p.pool, g.pool, a);
    assert.ok(Number.isSafeInteger(p.epoch) && p.epoch % 60_000 === 0, a);
    const r = decodeRelease(p.data);
    assert.equal(r.sel, a === "evm_buy_bad_signature" ? "3edadd79" : "94374b2b", a);
    assert.equal(r.withdrawal.processooor, g.pool, a);
    assert.equal(r.relay.length, 192, `${a}: exactly abi.encode(RelayData)`);
    assert.equal(r.relay.feeRecipient, f.fee_recipient, a);
    assert.equal(r.fee, BigInt(f.fee), `${a}: the published fee`);
    assert.ok(r.relay.feeCap >= r.fee, `${a}: a cap at least the fee`);
    assert.ok(r.words.every((x) => x < P), `${a}: every proof word under the field`);
    assert.equal(r.sig.length, 132, `${a}: 65 bytes`);
    assert.ok([27, 28].includes(Number.parseInt(r.sig.slice(-2), 16)), `${a}: v 27 or 28`);
    nullifiers.add(r.pubSignals[1]);
    const at = { chainId: venue.chainId, pool: g.pool, nullifier: r.pubSignals[1], value: r.pubSignals[2], context: r.pubSignals[7] };
    const signer = EVM.recover(EVM.withdrawDigest(at), r.sig);
    if (a === "evm_bad_signature") {
      assert.notEqual(signer, r.relay.recipient, "not W's Withdraw of this value");
      assert.equal(EVM.recover(EVM.withdrawDigest({ ...at, value: at.value + 1n }), r.sig), r.relay.recipient, "W's Withdraw of value + 1");
    } else if (a === "evm_buy_bad_signature") {
      assert.ok(r.buy.minOut > 0n);
      assert.notEqual(EVM.recover(EVM.buyDigest({ ...at, buy: r.buy }), r.sig), r.relay.recipient, "not W's Buy");
      assert.equal(signer, r.relay.recipient, "W's Withdraw of the same proof");
    } else assert.equal(signer, r.relay.recipient, `${a}: signed by W`);
    if (a === "evm_deadline_expired") {
      const d = Number(r.relay.deadlineMs);
      assert.ok(d < now, "the deadline is past");
      assert.ok(p.epoch >= d - 600_000 && p.epoch < d, "the epoch inside [deadline - 600 s, deadline)");
      assert.ok(p.epoch >= now - 600_000 && p.epoch <= EVM.epochStartOf(now), "the epoch within a proof's life of now");
    } else {
      assert.equal(p.epoch, f.epoch_start_ms, `${a}: the answer's epoch`);
      assert.ok(Number(r.relay.deadlineMs) - now >= 280_000 && Number(r.relay.deadlineMs) - now <= 300_000, `${a}: a deadline about 5 min out`);
    }
    if (a === "evm_recipient_code") assert.equal(r.relay.recipient, EVM.ANVIL0);
    else assert.notEqual(r.relay.recipient, EVM.ANVIL0);
  }
  assert.equal(nullifiers.size, 4, "a fresh nullifier per plant");
});
