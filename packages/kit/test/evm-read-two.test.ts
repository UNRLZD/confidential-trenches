// One read on two operators from a list (card device-evm-fee-read-walks-operators): a fake chain whose first operator
// refuses state for a whole period, hangs or answers HTTP 400, and the cases the walk must refuse: two seats of one
// operator, two answers that differ, one operator alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmOperatorsDiffer, EvmOperatorsUnanswered, evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, type EvmReadSeat } from "../src/index.ts";

type Fake = { calls: number; answer: (signal: AbortSignal) => Promise<string> };
const ok = (v: string): Fake => ({ calls: 0, answer: async () => v });
const refuses = (m: string): Fake => ({ calls: 0, answer: async () => Promise.reject(new Error(m)) });
// a seat that never answers until its call is cut
const hangs = (): Fake => ({ calls: 0, answer: (signal) => new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true })) });
const seats = (list: [string, Fake][]): EvmReadSeat<Fake>[] => list.map(([url, rpc]) => ({ url, rpc }));
const f = (rpc: Fake, signal: AbortSignal) => (rpc.calls++, rpc.answer(signal));
const eq = (a: string, b: string) => a === b;

const RH = "https://rpc.mainnet.chain.robinhood.com";
const PN = "https://robinhood-rpc.publicnode.com";
const PK = "https://robinhood.api.pocket.network";
const DR = "https://robinhood.drpc.org";
const STATE = 'HTTP 400 {"message":"Unknown state. First available state is 1","code":27}';

test("two operators answer and agree: both answers, side 0's first, and no other seat asked", async () => {
  const [a, b, c] = [ok("0x1"), ok("0x1"), ok("0x1")];
  const r = await evmTwoOperators(seats([[RH, a], [PN, b], [PK, c]])).read("fee", f, eq);
  assert.deepEqual(r.map((x) => [x.host, x.value]), [["rpc.mainnet.chain.robinhood.com", "0x1"], ["robinhood-rpc.publicnode.com", "0x1"]]);
  assert.deepEqual([a.calls, b.calls, c.calls], [1, 1, 0]);
});

test("the first operator refuses state for a whole period (60 reads): every read binds on the next two operators", async () => {
  const [d, a, b, c] = [refuses(STATE), ok("0x2"), ok("0x2"), ok("0x2")];
  const two = evmTwoOperators(seats([[DR, d], [RH, a], [PN, b], [PK, c]]));
  for (let i = 0; i < 60; i++) {
    const r = await two.read("fee", f, eq);
    assert.notEqual(r[0].operator, r[1].operator);
    assert.ok(!r.some((x) => x.operator === "drpc.org"));
  }
  // asked once, then rested: later reads start on the two that answer
  assert.equal(d.calls, 1);
  assert.deepEqual([a.calls, b.calls, c.calls], [60, 60, 0]);
});

test("the first operator hangs: its call is cut, the side walks on, and later reads ask it last", async () => {
  const [h, a, b] = [hangs(), ok("0x3"), ok("0x3")];
  const two = evmTwoOperators(seats([[DR, h], [RH, a], [PN, b]]), { callMs: 30 });
  const r = await two.read("fee", f, eq);
  assert.deepEqual(r.map((x) => x.operator).sort(), ["publicnode.com", "robinhood.com"]);
  await two.read("fee", f, eq);
  assert.equal(h.calls, 1);
});

test("the first operator answers HTTP 400 (not a value): the side walks on to the third", async () => {
  const [x, a, b] = [refuses("HTTP 400"), ok("0x4"), ok("0x4")];
  const r = await evmTwoOperators(seats([[DR, x], [RH, a], [PN, b]])).read("fee", f, eq);
  assert.deepEqual(r.map((y) => y.host), ["robinhood-rpc.publicnode.com", "rpc.mainnet.chain.robinhood.com"]);
});

test("two that answer and differ: refused, both answers carried, and a third is never asked", async () => {
  const [a, b, c] = [ok("0x5"), ok("0x6"), ok("0x5")];
  await assert.rejects(evmTwoOperators(seats([[RH, a], [PN, b], [PK, c]])).read("fee", f, eq), (e: unknown) => {
    assert.ok(e instanceof EvmOperatorsDiffer);
    assert.deepEqual(e.answers.map((x) => x.value), ["0x5", "0x6"]);
    return true;
  });
  assert.equal(c.calls, 0);
});

test("one operator alone never passes: every other operator refusing is a refusal, never one answer twice", async () => {
  const [a, b, c] = [ok("0x7"), refuses("HTTP 503"), refuses(STATE)];
  await assert.rejects(evmTwoOperators(seats([[RH, a], [PN, b], [DR, c]])).read("fee", f, eq), EvmOperatorsUnanswered);
  assert.equal(a.calls, 1);
});

test("two seats of one operator are one: a list of them is refused, and a side never takes the other's operator's second seat", async () => {
  assert.throws(() => evmTwoOperators(seats([[DR, ok("0x8")], ["https://lb.drpc.live/robinhood/x", ok("0x8")]])), /two operators at least/);
  assert.throws(() => evmTwoOperators(seats([[RH, ok("0x8")], ["https://customer-origin.offchainlabs.com", ok("0x8")]])), /two operators at least/);
  // side 1's first seat (dRPC) refuses; dRPC's second seat is its own operator's, so side 1 asks it; side 0 never does
  const [a, d1, d2] = [ok("0x9"), refuses("HTTP 400"), ok("0x9")];
  const r = await evmTwoOperators(seats([[RH, a], [DR, d1], ["https://lb.drpc.live/robinhood/x", d2]])).read("fee", f, eq);
  assert.deepEqual(r.map((x) => x.operator), ["robinhood.com", "drpc.org"]);
  // with only those two operators, side 1 out of seats refuses: Robinhood's own never stands on both sides
  const [b, e1, e2] = [ok("0x9"), refuses("HTTP 400"), refuses("HTTP 400")];
  await assert.rejects(evmTwoOperators(seats([[RH, b], [DR, e1], ["https://lb.drpc.live/robinhood/x", e2]])).read("fee", f, eq), EvmOperatorsUnanswered);
  assert.equal(b.calls, 1);
});

test("messages name a seat by host, never its URL's path or key", async () => {
  const keyed = "https://lb.drpc.live/robinhood/AkEySeCrEt0123456789";
  const leak = refuses(`upstream ${keyed} said no`);
  await assert.rejects(evmTwoOperators(seats([[RH, ok("0x1")], [keyed, leak]])).read("fee", f, eq), (e: unknown) => {
    const m = String((e as Error).message);
    assert.ok(!m.includes("AkEySeCrEt"), m);
    assert.ok(m.includes("lb.drpc.live"), m);
    return true;
  });
});

test("the caller's abort ends the read at once, and no seat is rested for it", async () => {
  const ac = new AbortController();
  const [h, a] = [hangs(), hangs()];
  const p = evmTwoOperators(seats([[RH, h], [PN, a]]), { callMs: 10_000 }).read("fee", f, eq, ac.signal);
  ac.abort(new Error("gone"));
  await assert.rejects(p, /gone/);
});

test("safety rule: of four operators one answers a wrong value: the read refuses (it was one of the two) or returns the honest value, never the wrong one, and no third seat is asked after two answers", async () => {
  const URLS = [RH, PN, PK, DR];
  for (let liar = 0; liar < 4; liar++) {
    // the first operator refusing too, so the walk reaches the liar wherever it sits
    for (const blind of [null, ...[0, 1, 2, 3].filter((i) => i !== liar)]) {
      const fakes = URLS.map((_, i) => (i === liar ? ok("0xbad") : i === blind ? refuses(STATE) : ok("0x600d")));
      const two = evmTwoOperators(seats(URLS.map((u, i) => [u, fakes[i]!] as [string, Fake])));
      const asked = () => fakes.map((x) => x.calls);
      let got: string[] | null = null;
      try {
        got = (await two.read("fee", f, eq)).map((x) => x.value);
      } catch (e) {
        assert.ok(e instanceof EvmOperatorsDiffer || e instanceof EvmOperatorsUnanswered, String(e));
        if (e instanceof EvmOperatorsDiffer) assert.ok(e.answers.some((x) => x.value === "0xbad"), "a refusal names the liar's answer");
      }
      if (got !== null) assert.deepEqual(got, ["0x600d", "0x600d"], `liar ${liar}, blind ${blind}`);
      // exactly two answered, each asked once, the rest never asked once two answered
      const answered = asked().filter((n, i) => n > 0 && i !== blind).length;
      assert.equal(answered, 2, `liar ${liar}, blind ${blind}: ${asked()}`);
      assert.ok(asked().every((n) => n <= 1));
    }
  }
});

test("a well-formed value is an answer and is compared: only an error or a malformed body walks on", async () => {
  // the caller's read throws only for a body it cannot read; a value it parsed is returned, and then compared
  const parse = (rpc: Fake, signal: AbortSignal) =>
    f(rpc, signal).then((v) => {
      if (!/^0x[0-9a-f]+$/.test(v)) throw new Error(`not a quantity: ${v.slice(0, 20)}`);
      return v;
    });
  const [a, b, c] = [ok("<html>502</html>"), ok("0x1"), ok("0x2")];
  // the malformed body walks on; the two that answered differ on their merits: refused
  await assert.rejects(evmTwoOperators(seats([[DR, a], [RH, b], [PN, c]])).read("fee", parse, eq), EvmOperatorsDiffer);
  assert.deepEqual([a.calls, b.calls, c.calls], [1, 1, 1]);
});

test("each mainnet's read list holds its helper pair and three operators at least; a testnet's is its pair (two: no walk)", () => {
  const v = evmPoolVenues();
  for (const chain of ["base", "robinhood"] as const) {
    const list = evmReadProvidersOf(v[chain]!)!;
    for (const u of v[chain]!.feeProviders!) assert.ok(list.includes(u), `${chain}: ${u} on the read list`);
    assert.ok(new Set(list.map(evmRpcOperator)).size >= 3, `${chain}: three operators at least`);
  }
  for (const chain of ["base-sepolia", "robinhood-testnet"] as const) assert.deepEqual(evmReadProvidersOf(v[chain]!), v[chain]!.feeProviders);
});

test("each venue's read list: two operators at least, one seat each, Base and Robinhood mainnet four", () => {
  const v = evmPoolVenues();
  for (const [chain, venue] of Object.entries(v)) {
    const list = evmReadProvidersOf(venue);
    if (list === undefined) continue;
    const ops = list.map(evmRpcOperator);
    assert.equal(new Set(ops).size, list.length, `${chain}: one seat an operator`);
    assert.ok(list.length >= 2, chain);
  }
  assert.deepEqual(evmReadProvidersOf(v.robinhood!), [RH, PK, PN, DR]);
  assert.deepEqual(evmReadProvidersOf(v.base!)!.map(evmRpcOperator), ["base.org", "publicnode.com", "pocket.network", "drpc.org"]);
});
