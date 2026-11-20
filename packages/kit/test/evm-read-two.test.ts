// One read on two operators from a list (card device-evm-fee-read-walks-operators): a fake chain whose first operator
// refuses state for a whole period, hangs or answers HTTP 400, and the cases the walk must refuse: two seats of one
// operator, two answers that differ, one operator alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { untilAborted } from "../src/abort.ts";
import { EVM_READ_BUDGET_MS, EVM_READ_CALL_MS, EVM_READ_REST_MS, EvmOperatorsDiffer, EvmOperatorsUnanswered, evmPoolVenues, evmReadProvidersOf, evmRpcOperator, evmTwoOperators, secretScrubber, SECRET_SCRUB_MAX, type EvmReadSeat } from "../src/index.ts";

type Fake = { calls: number; answer: (signal: AbortSignal) => Promise<string> };
const ok = (v: string): Fake => ({ calls: 0, answer: async () => v });
const refuses = (m: string): Fake => ({ calls: 0, answer: async () => Promise.reject(new Error(m)) });
// a seat that never answers until its call is cut
const hangs = (): Fake => ({ calls: 0, answer: (signal) => untilAborted(signal) });
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

test("Robinhood's order, dRPC second: refusing costs side 1 one call and then a rest; hanging, one cut (EVM_READ_CALL_MS) and then a rest", async () => {
  // refuses: one call, then every read of the rest binds on Robinhood's own and Pocket, dRPC not asked again
  const [a, d, k, n] = [ok("0xa"), refuses(STATE), ok("0xa"), ok("0xa")];
  const two = evmTwoOperators(seats([[RH, a], [DR, d], [PK, k], [PN, n]]));
  for (let i = 0; i < 5; i++) assert.deepEqual((await two.read("fee", f, eq)).map((x) => x.operator), ["robinhood.com", "pocket.network"]);
  assert.deepEqual([a.calls, d.calls, k.calls, n.calls], [5, 1, 5, 0]);
  // hangs: the first read waits out one cut (a hang ends only by it, so it answered on Pocket after the cut) (callMs here, EVM_READ_CALL_MS = 4 s live, inside the 8 s budget), and the
  // next reads never ask it while it rests
  const [b, h, q, m] = [ok("0xb"), hangs(), ok("0xb"), ok("0xb")];
  const slow = evmTwoOperators(seats([[RH, b], [DR, h], [PK, q], [PN, m]]), { callMs: 40 });
  assert.deepEqual((await slow.read("fee", f, eq)).map((x) => x.operator), ["robinhood.com", "pocket.network"]);
  for (let i = 0; i < 4; i++) await slow.read("fee", f, eq);
  assert.deepEqual([b.calls, h.calls, q.calls, m.calls], [5, 1, 5, 0]);
  assert.ok(EVM_READ_CALL_MS < EVM_READ_BUDGET_MS && EVM_READ_REST_MS >= 60_000);
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

test("a provider's words lose every URL path: any case, a port, no scheme, a key", async () => {
  const keyed = "https://lb.drpc.live/robinhood/AkEySeCrEt0123456789";
  for (const said of ["HTTPS://LB.DRPC.LIVE/robinhood/AkEySeCrEt0123456789", "https://lb.drpc.live:443/robinhood/AkEySeCrEt0123456789", "lb.drpc.live/robinhood/AkEySeCrEt0123456789", "upstream https://user:AkEySeCrEt@other.example/x/AkEySeCrEt?k=AkEySeCrEt", `\u0130${"\u0130".repeat(5000)} ${keyed}`]) {
    await assert.rejects(evmTwoOperators(seats([[RH, ok("0x1")], [keyed, refuses(said)]])).read("fee", f, eq), (e: unknown) => {
      const m = String((e as Error).message);
      assert.ok(!/AkEySeCrEt/i.test(m), m);
      return true;
    });
  }
});

test("the budget ends a side: no seat is asked once the read's time is spent", async () => {
  let t = 0;
  const [a, x, b, c] = [ok("0x1"), { calls: 0, answer: async () => ((t = 10_000), Promise.reject(new Error("HTTP 503"))) } as Fake, ok("0x1"), ok("0x1")];
  await assert.rejects(evmTwoOperators(seats([[RH, a], [DR, x], [PK, b], [PN, c]]), { now: () => t }).read("fee", f, eq), /no two operators answered in 8000 ms/);
  assert.deepEqual([x.calls, b.calls, c.calls], [1, 0, 0]);
});

test("a rest ends: an operator that refused is asked first again once EVM_READ_REST_MS has passed", async () => {
  let t = 0;
  let blind = true;
  const d: Fake = { calls: 0, answer: async () => (blind ? Promise.reject(new Error(STATE)) : "0x1") };
  const [a, b] = [ok("0x1"), ok("0x1")];
  const two = evmTwoOperators(seats([[RH, a], [DR, d], [PK, b]]), { now: () => t });
  await two.read("fee", f, eq);
  t = 1_000;
  await two.read("fee", f, eq);
  assert.equal(d.calls, 1, "resting: asked last, so not asked");
  (t = 1 + EVM_READ_REST_MS), (blind = false);
  assert.deepEqual((await two.read("fee", f, eq)).map((x) => x.operator), ["robinhood.com", "drpc.org"]);
  assert.equal(d.calls, 2);
});

test("a refusal carries every seat error of the side that refused, in its walk's order", async () => {
  const [a, x, y] = [ok("0x1"), refuses("first"), refuses("second")];
  await assert.rejects(evmTwoOperators(seats([[RH, a], [DR, x], [PK, y]])).read("fee", f, eq), (e: unknown) => {
    assert.ok(e instanceof EvmOperatorsUnanswered);
    assert.deepEqual(e.errors.map((z) => (z as Error).message), ["first", "second"]);
    assert.equal((e.cause as Error).message, "second");
    return true;
  });
});

// card evm-device-reads-need-no-old-state: with dRPC out, three of Robinhood's four operators refuse a block's state
// 55 s back (2 of 15 fee reads at +55 s, read 2026-11-10 21:50Z), so no read at that block binds, whatever the order; the
// device holds the period's read from the turn instead (wallet src/pool/evm.ts holdFee)
test("three of four operators refusing an old block's state: no read binds, every refusal carried, one answer never enough", async () => {
  for (const order of [[RH, DR, PK, PN], [DR, PK, PN, RH], [PK, RH, PN, DR]]) {
    const fakes = new Map(order.map((u) => [u, u === RH ? ok("0x2a") : refuses(STATE)] as const));
    await assert.rejects(evmTwoOperators(seats(order.map((u) => [u, fakes.get(u)!]))).read("fee at an old block", f, eq), (e: unknown) => {
      assert.ok(e instanceof EvmOperatorsUnanswered, String(e));
      assert.ok(e.errors.length >= 1 && e.errors.every((z) => (z as Error).message === STATE), "only the refusals of state, the one answer never counted twice");
      return true;
    });
    assert.equal(fakes.get(RH)!.calls, 1, "the one operator that keeps the state is asked once");
    for (const u of order) if (u !== RH) assert.ok(fakes.get(u)!.calls <= 1, `${u}: asked at most once`);
  }
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
  assert.deepEqual(evmReadProvidersOf(v.robinhood!), [RH, DR, PK, PN]);
  assert.deepEqual(evmReadProvidersOf(v.base!)!.map(evmRpcOperator), ["base.org", "publicnode.com", "pocket.network", "tenderly.co"]);
});

// card device-evm-read-residuals (delta review of 1d895550, item 1): a keyed seat's own path segments, query and userinfo
// never reach a message, in any form a provider's words may hold them; errors[] and cause carry the same cleaned words
const KEYED = "https://us3r:PaSs%2FW0rdSeCrEt@lb.drpc.live/robinhood/AkEySeCrEt0123456789?apikey=QuErYsEcReT0123456789";
const SEG_S = "AkEySeCrEt0123456789";
const QUERY_S = "QuErYsEcReT0123456789";
const HOSTILE: readonly (readonly [string, string])[] = [
  ["the seat's URL as is", `upstream ${KEYED} said no`],
  ["in upper case", `upstream ${KEYED.toUpperCase()} said no`],
  ["with a port", `upstream https://lb.drpc.live:443/robinhood/${SEG_S} said no`],
  ["a listed host with no scheme", `lb.drpc.live/robinhood/${SEG_S}`],
  ["an unlisted host's userinfo", `upstream https://user:${SEG_S}@other.example/x/${SEG_S}?k=${QUERY_S}`],
  ["a query alone", `bad request ?apikey=${QUERY_S}`],
  ["a path alone", `no route /robinhood/${SEG_S}`],
  ["JSON-escaped slashes", `{"url":"https:\\/\\/lb.drpc.live\\/robinhood\\/${SEG_S}"}`],
  ["percent-encoded", `redirect to ${encodeURIComponent(`https://lb.drpc.live/robinhood/${SEG_S}?apikey=${QUERY_S}`)}`],
  ["wss on an unlisted host", `try wss://ws.other.example/robinhood/${SEG_S}`],
  ["an unlisted host with no scheme", `mirror.other.example/robinhood/${SEG_S}`],
  ["a trailing-dot host", `lb.drpc.live./robinhood/${SEG_S}`],
  ["a backslash path", `lb.drpc.live\\robinhood\\${SEG_S}`],
  ["userinfo holding a slash", `upstream https://us3r:PaSs/W0rdSeCrEt@lb.drpc.live/x refused`],
  ["the password percent-encoded", `auth PaSs%2fW0rdSeCrEt refused`],
  ["a key cut short by the provider", `key AkEySeCrEt01… rejected`],
  ["a key alone in another case", `${SEG_S.toLowerCase()} is not a valid key`],
  ["a key in a JSON body", `{"error":"invalid key ${QUERY_S}"}`],
  ["a long Unicode run before the URL", `İ${"İ".repeat(5000)} ${KEYED}`],
  ["a backtick-quoted URL", "`" + `https://lb.drpc.live/x?apikey=${QUERY_S}` + "`"],
];
// any piece of a secret, in any case; the password's start "PaSs" in its own mixed case (in any case it is a common word)
const LEAK = { test: (s: string) => /AkEySeCr|QuErYsEc|W0rdSeCr|%2fW0rd/i.test(s) || /PaSs/.test(s) };
test("a keyed seat's path, query and userinfo never reach a message, errors[] or cause: every one of the 20 hostile forms", async () => {
  assert.equal(HOSTILE.length, 20);
  const leaked: string[] = [];
  for (const [name, words] of HOSTILE) {
    class SeatFault extends Error {
      readonly body = words;
    }
    const thrown = new SeatFault(words, { cause: new Error(`inner ${words}`) });
    const e = await evmTwoOperators(seats([[RH, ok("0x1")], [KEYED, { calls: 0, answer: async () => Promise.reject(thrown) }]])).read("fee", f, eq).then(
      () => null,
      (x: unknown) => x,
    );
    assert.ok(e instanceof EvmOperatorsUnanswered, `${name}: ${String(e)}`);
    const seen = [e.message, String(e.stack), ...e.errors.flatMap((z) => [(z as Error).message, String((z as Error).stack), String((z as SeatFault).body), String(((z as Error).cause as Error)?.message)]), String((e.cause as Error)?.message)];
    if (seen.some((s) => LEAK.test(s))) leaked.push(`${name}: ${seen.find((s) => LEAK.test(s))!.slice(0, 160)}`);
    assert.ok(e.errors[0] instanceof SeatFault, `${name}: errors[] keeps the seat error's class`);
    assert.equal(e.cause, e.errors.at(-1), `${name}: cause is errors[]'s last`);
    assert.ok(e.message.includes(`lb.drpc.live: ${(e.errors[0] as Error).message}`), `${name}: the message and errors[] carry the same words`);
  }
  assert.deepEqual(leaked, []);
});

test("cleaned words keep what a caller reads: a provider's own words, the seat's host, a lag's class and code", async () => {
  class LagLike extends Error {
    readonly code = "lag";
    constructor(m: string) {
      super(m);
      this.name = "LagLike";
    }
  }
  const words = `HTTP 400: RPC error 27: Unknown state. First available state is 1 (https://lb.drpc.live/robinhood/${SEG_S})`;
  const e = await evmTwoOperators(seats([[RH, ok("0x1")], [KEYED, { calls: 0, answer: async () => Promise.reject(new LagLike(words)) }]])).read("fee", f, eq).catch((x: unknown) => x);
  assert.ok(e instanceof EvmOperatorsUnanswered);
  const z = e.errors[0] as LagLike;
  assert.ok(z instanceof LagLike);
  assert.equal(z.name, "LagLike");
  assert.equal(z.code, "lag");
  // a URL's run takes all to the next space or quote, a closing bracket too (a path may hold one): the host stands for it
  assert.equal(z.message, "HTTP 400: RPC error 27: Unknown state. First available state is 1 (lb.drpc.live");
  // a thrown DOMException (fetch's timeout) is copied without its getters throwing
  const t = await evmTwoOperators(seats([[RH, ok("0x1")], [KEYED, { calls: 0, answer: async () => Promise.reject(new DOMException(`timed out at ${KEYED}`, "TimeoutError")) }]])).read("fee", f, eq).catch((x: unknown) => x);
  assert.ok(t instanceof EvmOperatorsUnanswered);
  assert.equal((t.errors[0] as DOMException).name, "TimeoutError");
  assert.ok(!LEAK.test((t.errors[0] as Error).message) && !LEAK.test(t.message), t.message);
});

// card helper-scrubber-takes-the-kits-rule: the rule is the kit's public secretScrubber, which the helper cleans every
// provider's words with; the forms past the 20 that card found
test("secretScrubber: a raw '+' in a query key, as written, cut or percent-encoded, leaves none of it; the longest start at a place goes", () => {
  const PK = "PlUsKeY0+9876543210fedcba";
  const scrub = secretScrubber([`https://b.example/rpc?apikey=${PK}`]);
  assert.equal(scrub(`invalid api key ${PK} for this plan`), "invalid api key <key> for this plan");
  assert.equal(scrub("key PlUsKeY0+987654 rejected"), "key <key> rejected");
  assert.equal(scrub(`bad ${encodeURIComponent(PK)} here`), "bad <key> here");
  assert.equal(scrub(`bad ${PK.replace("+", " ")} here`), "bad <key> here");
});

test("secretScrubber: a chain's name in a seat's path is a word, so its hosts and env names stay readable; a key beside it goes", () => {
  const scrub = secretScrubber(["https://lb.drpc.live/robinhood/AkEySeCrEt0123456789", "https://x.example/base-mainnet/rpc?access_token=T0kEnSeCrEt99"]);
  assert.equal(scrub("robinhood.drpc.org: HTTP 400; drpc.live (ROBINHOOD_RPC_URL_DRPC_1): base-mainnet access_token AkEySeCrEt0123 T0kEnSeCrEt99"), "robinhood.drpc.org: HTTP 400; drpc.live (ROBINHOOD_RPC_URL_DRPC_1): base-mainnet access_token <key> <key>");
});

test("secretScrubber: a URL that does not parse is passed over; words past SECRET_SCRUB_MAX are cut, the cut marked, a whole key past it still gone", () => {
  const scrub = secretScrubber(["not a url", "https://a.example/v2/AkEySeCrEt0123456789"]);
  assert.equal(scrub("not a url said no"), "not a url said no");
  const out = scrub(`${"y".repeat(SECRET_SCRUB_MAX)} AkEySeCrEt0123456789`);
  assert.equal(out.length, SECRET_SCRUB_MAX + 1);
  assert.ok(out.endsWith("…") && !out.includes("AkEySeCr"));
  assert.equal(secretScrubber(["https://a.example/v2/AkEySeCrEt0123456789"], 10)("0123456789abc"), "0123456789…");
});

test("secretScrubber: a lowercase word is a word only as a path segment or a query name; as a password, a query value or a fragment it is a secret", () => {
  const pw = ["correct", "horse", "battery"].join("-");
  const scrub = secretScrubber([`https://user:${pw}@node.example.com/robinhood?apikey=${"pinkelephantdance"}#${"supersecretfragment"}`]);
  assert.equal(scrub(`auth failed for user:${pw}`), "auth failed for user:<key>");
  assert.equal(scrub("bad apikey pinkelephantdance"), "bad apikey <key>");
  assert.equal(scrub("no route supersecretfragment"), "no route <key>");
  assert.equal(scrub("robinhood is down"), "robinhood is down");
});
