// Replays pool-amounts-are-standard-sizes-evm.answers.json through the live check. `dry`: the rehearsal's recording
// (contracts/pool-evm/script/sell-delegate-2-rehearsal.sh: deploy.mjs --mainnet --only SellDelegate on anvil forks of
// Base and Robinhood mainnet, each read on two loopback names; after the owner's pastes, re-record on the mainnets);
// `today`: the mainnets before any paste, read on their own two RPCs. The good answers pass; the same recordings with
// one thing changed fail: the first set's code at the new delegate's address, WETH() answering another address, the
// run key keeping money, the kit pinning a delegate that is neither, and, before the paste, the kit pinning anything
// but the first set's delegate or that address holding no code. And the kit today pins the first set's delegate on
// both chains, so the terminal sells exactly as before until a later card moves the pin. A provider's no-answer is
// INCONCLUSIVE.
//   node --test scripts/live-checks/pool-amounts-are-standard-sizes-evm.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";
import { replayer } from "./evm-pool-pins.mjs";
import { checkChain, V1 } from "./pool-amounts-are-standard-sizes-evm.mjs";
import { BUILD, DUST, selector } from "./pool-evm-deploy.mjs";
import { RETRY } from "./provider-answer.mjs";

RETRY.ms = 0;
const A = JSON.parse(readFileSync(new URL("./pool-amounts-are-standard-sizes-evm.answers.json", import.meta.url), "utf8"));
const CHAINS = ["base", "robinhood"];
const lower = (s) => String(s).toLowerCase();
const v1At = (chain) => lower(BUILD.frozen[V1].at[chain]);

// a recorded answer's request and result
const req = (e) => JSON.parse(e.body);
const resultOf = (e) => JSON.parse(e.text).result;
const dry = (chain, o = {}) => {
  const r = A.dry[chain];
  return checkChain({ chain, deployment: r.deployments[chain], pin: o.pin ?? r.pins[chain], fetchFn: replayer(o.log ?? r.log), rpcs: r.rpcs[chain] });
};
const today = (chain, o = {}) => checkChain({ chain, deployment: null, pin: o.pin ?? A.today.pins[chain], fetchFn: replayer(o.log ?? A.today.log), rpcs: A.today.rpcs[chain] });
/** `log` with every answer `pick(request)` selects given result `f(result)`, on the chain's first RPC only */
function mutate(log, url, pick, f) {
  const out = structuredClone(log);
  let n = 0;
  for (const e of out)
    if (e.url === url && pick(req(e))) {
      const j = JSON.parse(e.text);
      j.result = f(j.result);
      e.text = JSON.stringify(j);
      n++;
    }
  assert.ok(n > 0, "the mutation found its answer");
  return out;
}
const fails = (r, re) => {
  assert.equal(r.verdict, "FAIL");
  assert.match(r.lines.filter((l) => l.startsWith("FAIL")).join("\n"), re);
};
const OTHER = "0x" + "ba".repeat(20);

test("the kit today pins the first set's delegate on both mainnets: sales sign and land as before until a later card moves the pin", () => {
  for (const chain of CHAINS) assert.equal(lower(evmPoolVenues()[chain].sellDelegate), v1At(chain), chain);
});

test("the rehearsal's recorded answers pass on both chains, every read on both RPCs; the mainnets' today's answers pass", async () => {
  for (const chain of CHAINS) {
    const r = await dry(chain);
    assert.equal(r.verdict, "PASS", r.lines.join("\n"));
    for (const u of A.dry[chain].rpcs[chain]) assert.ok(r.lines.some((l) => l.includes(`on ${u}`)), u);
    const t = await today(chain);
    assert.equal(t.verdict, "PASS", t.lines.join("\n"));
    for (const u of A.today.rpcs[chain]) assert.ok(t.lines.some((l) => l.includes(`holds that frozen build`) && l.endsWith(`on ${u}`)), u);
  }
});

test("bad: the first set's code at the new delegate's address fails (the current build, not a frozen one)", async () => {
  for (const chain of CHAINS) {
    const r = A.dry[chain];
    const v2 = lower(r.deployments[chain].contracts.SellDelegate.address);
    const v1Code = resultOf(A.today.log.find((e) => req(e).method === "eth_getCode" && lower(req(e).params[0]) === v1At(chain)));
    const bad = mutate(r.log, r.rpcs[chain][0], (q) => q.method === "eth_getCode" && lower(q.params[0]) === v2, () => v1Code);
    fails(await dry(chain, { log: bad }), /code is the current build/);
  }
});

test("bad: WETH() answering another address fails", async () => {
  for (const chain of CHAINS) {
    const r = A.dry[chain];
    const v2 = lower(r.deployments[chain].contracts.SellDelegate.address);
    const bad = mutate(r.log, r.rpcs[chain][0], (q) => q.method === "eth_call" && lower(q.params[0].to) === v2 && q.params[0].data === selector("WETH()"), () => "0x" + OTHER.slice(2).padStart(64, "0"));
    fails(await dry(chain, { log: bad }), /WETH\(\) returns/);
  }
});

test("bad: the run key keeping more than DUST fails", async () => {
  for (const chain of CHAINS) {
    const r = A.dry[chain];
    const key = lower(r.deployments[chain].deployer);
    const bad = mutate(r.log, r.rpcs[chain][0], (q) => q.method === "eth_getBalance" && lower(q.params[0]) === key, () => "0x" + (DUST + 1n).toString(16));
    fails(await dry(chain, { log: bad }), /keeps at most/);
  }
});

test("bad: the kit pinning a delegate that is neither the record's nor the first set's fails", async () => {
  for (const chain of CHAINS) fails(await dry(chain, { pin: OTHER }), /the kit pins/);
});

test("bad, before the paste: the kit pinning anything but the first set's delegate, or that address holding no code, fails", async () => {
  for (const chain of CHAINS) {
    fails(await today(chain, { pin: lower(A.dry[chain].deployments[chain].contracts.SellDelegate.address) }), /the kit pins the first set's delegate/);
    const empty = mutate(A.today.log, A.today.rpcs[chain][0], (q) => q.method === "eth_getCode" && lower(q.params[0]) === v1At(chain), () => "0x");
    fails(await today(chain, { log: empty }), /holds that frozen build/);
  }
});

test("a provider's no-answer is INCONCLUSIVE, never a FAIL or a PASS", async () => {
  for (const chain of CHAINS) {
    const url = A.today.rpcs[chain][0];
    const log = structuredClone(A.today.log);
    const e = log.find((x) => x.url === url && req(x).method === "eth_getCode");
    Object.assign(e, { status: 429, text: "Too Many Requests" });
    const r = await today(chain, { log });
    assert.equal(r.verdict, "INCONCLUSIVE", r.lines.join("\n"));
    assert.ok(r.lines.some((l) => l.startsWith("QUIET")), r.lines.join("\n"));
  }
});
