// Replays evm-mainnet-senders.answers.json through the live check. `good`: the kit's two mainnet pins, the helper
// box's sell senders, with no code on Base's and Robinhood's two RPCs (real reads, before either paste), with the
// paste's plan as pool-evm-deploy.mjs MAINNETS has it: PASS. `bad_today`: the kit and the plan at
// f99ba2df (no mainnet pin, no FeeCollector in either set): FAIL. `bad_code`: each chain's WETH as the pin, real reads
// of its code: FAIL. Made from good: one pin on both mainnets, a testnet's pin, a plan without FeeCollector: FAIL. After
// the paste (constructed records): a collector whose runtime is the Base Sepolia collector's real code with the pin
// set at its sink word passes; that code as recorded (another sink), a record whose sink is not the pin, and a kit
// feeCollector pin off the record each FAIL.
//   node --test scripts/live-checks/evm-mainnet-senders.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { check } from "./evm-mainnet-senders.mjs";
import { MAINNETS } from "./pool-evm-deploy.mjs";

const A = JSON.parse(readFileSync(new URL("./evm-mainnet-senders.answers.json", import.meta.url), "utf8"));
const FC = JSON.parse(readFileSync(new URL("./evm-fee-collector.answers.json", import.meta.url), "utf8"));
const kit = evmPoolVenues();
const sleep = async () => {};

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
const withPins = (pins, extra = {}) => {
  const v = { ...kit };
  for (const c of ["base", "robinhood"]) {
    const { sellSender, ...rest } = kit[c];
    v[c] = { ...rest, ...(pins[c] ? { sellSender: pins[c] } : {}), ...(extra[c] ?? {}) };
  }
  return v;
};
const run = ({ pins = A.good.pins, answers = A.good.answers, plans = MAINNETS, records, extra } = {}) =>
  check({ venues: withPins(pins, extra), plans, records, fetchFn: replay(answers), sleep });
const fails = (r, re) => assert.ok(r.lines.some((l) => l.startsWith("FAIL") && re.test(l)), `${re} fails:\n${r.lines.join("\n")}`);

test("the recorded good answer passes: both pins codeless on two RPCs, the paste's plan deploys FeeCollector", async () => {
  const r = await run();
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => /has no code/.test(l)).length, 4);
});

test("the recorded bad answers fail: the kit and plan at f99ba2df; a pin with code", async () => {
  const today = await run({ pins: A.bad_today.pins, answers: A.bad_today.answers, plans: Object.fromEntries(Object.entries(MAINNETS).map(([c, m]) => [c, { ...m, contracts: A.bad_today.contracts }])) });
  assert.equal(today.ok, false);
  fails(today, /base: the kit pins a sell sender: none/);
  fails(today, /robinhood: the paste deploys FeeCollector/);
  const code = await run({ pins: A.bad_code.pins, answers: A.bad_code.answers });
  assert.equal(code.ok, false);
  fails(code, /base: the pin 0x4200000000000000000000000000000000000006 has no code/);
  fails(code, /robinhood: the pin 0x0bd7d308f8e1639fab988df18a8011f41eacad73 has no code/);
});

test("made from good: an RPC answering another chain's id fails and its code is read no further", async () => {
  const answers = A.good.answers.map((a) => (a.method === "eth_chainId" && a.url === A.rpcs.robinhood[1] ? { ...a, json: { ...a.json, result: "0x2105" } } : a));
  const r = await run({ answers });
  fails(r, /robinhood: chain id 0x2105 is robinhood's 0x1237 on robinhood-rpc.publicnode.com/);
  assert.equal(r.lines.filter((l) => /robinhood: the pin .* has no code/.test(l)).length, 1, "the code read on that RPC only");
});

test("made from good: one pin on both mainnets, a testnet's pin, a plan without FeeCollector each fail", async () => {
  fails(await run({ pins: { base: A.good.pins.base, robinhood: A.good.pins.base }, answers: [...A.good.answers, ...A.good.answers.filter((a) => a.method === "eth_getCode").map((a) => ({ ...a, params: [A.good.pins.base, "latest"] }))] }), /robinhood: its pin is its own/);
  fails(await run({ pins: { ...A.good.pins, base: kit["base-sepolia"].sellSender }, answers: [...A.good.answers, ...A.good.answers.filter((a) => a.method === "eth_getCode").map((a) => ({ ...a, params: [kit["base-sepolia"].sellSender, "latest"] }))] }), /base: its pin is its own/);
  const plans = { ...MAINNETS, base: { ...MAINNETS.base, contracts: MAINNETS.base.contracts.filter((n) => n !== "FeeCollector") } };
  fails(await run({ plans }), /base: the paste deploys FeeCollector/);
});

// After the paste: a constructed record at a constructed address, its code the Base Sepolia collector's real runtime
// (evm-fee-collector.answers.json), with its one immutable word (offset 64, pool-evm-deploy.build.json) set to the pin
const COLLECTOR = "0x" + "c0".repeat(20);
const testnetCode = FC.good["base-sepolia"].find((a) => a.method === "eth_getCode" && a.params[0] === FC.deployments["base-sepolia"].contracts.FeeCollector.address).json.result;
const withSink = (code, sink) => code.slice(0, 2 + 128) + sink.slice(2).padStart(64, "0") + code.slice(2 + 128 + 64);
const codeAnswers = (code) => ["base", "robinhood"].flatMap((c) => A.rpcs[c].map((url) => ({ url, method: "eth_getCode", params: [COLLECTOR, "latest"], status: 200, json: { jsonrpc: "2.0", id: 1, result: code(c) } })));
const record = (c, sink = A.good.pins[c]) => ({ chain: c, contracts: { FeeCollector: { address: COLLECTOR, sink } } });

test("after the paste: the collector holding the pin passes; another sink in its code or its record, or a kit collector pin off the record, fails", async () => {
  assert.equal(withSink(testnetCode, FC.deployments["base-sepolia"].contracts.FeeCollector.sink), testnetCode, "the sink word sits at offset 64");
  const records = { base: record("base"), robinhood: record("robinhood") };
  const good = await run({ records, answers: [...A.good.answers, ...codeAnswers((c) => withSink(testnetCode, A.good.pins[c]))] });
  assert.equal(good.ok, true, good.lines.join("\n"));
  fails(await run({ records, answers: [...A.good.answers, ...codeAnswers(() => testnetCode)] }), /base: FeeCollector 0xc0c0.* is the build's code with the pin/);
  const other = "0x" + "ab".repeat(20);
  fails(await run({ records: { ...records, robinhood: record("robinhood", other) }, answers: [...A.good.answers, ...codeAnswers((c) => withSink(testnetCode, A.good.pins[c]))] }), /robinhood: the record's FeeCollector sink is the pin: 0xabab/);
  fails(await run({ records, extra: { base: { feeCollector: other } }, answers: [...A.good.answers, ...codeAnswers((c) => withSink(testnetCode, A.good.pins[c]))] }), /base: the kit's feeCollector pin is the record's/);
});
