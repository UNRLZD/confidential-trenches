// card evm-warm-tap-ends-inside-two-seconds: a 2-of-3 quorum in agreeing's rounds. A round that is not contested and has
// three providers or more asks a third at once with the first two, where that third is not held and its pace and gate
// have a place for the post now; it is its own seat and its own vote, and the first two answers that agree win. Where it
// has no place the round runs as before (two, the stand-ins at evmHedgeAfter, the late spare). A request still queued
// at its gate or its pace when its round is done is dropped unsent, its units never taken, and holds nothing.
// The read that asked for it (2026-11-22 02:3xZ, side A be22ec935, Base VVV warm taps): Round 1's 3-call aggregate3
// batch took 1,348-1,390 ms on base-rpc.publicnode.com on 2 of 5 warm taps while blastapi answered it in about 300 ms,
// and the round waited for the slower of its two seats: the stand-in leaves at the hedge, so the tap ended at 2.0 s.
// Each provider answers after its own delay on the test's clock (test-clock.ts), so each time is exact.
//   node --test test/evm-quorum.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { test } from "node:test";
import * as Q from "../src/checks/evm/quote.ts";
import { evmPaceReady, evmPaceReset, evmPaceTake, type EvmPaceGive } from "../src/checks/evm/pace.ts";
import { evmPoolVenues } from "../src/trade/evm/buy-unpinned.ts";
import { onTestClock } from "./test-clock.ts";

type Rpc = Q.EvmRpc;
type Gate = Q.EvmGated & { readonly until?: AbortSignal };
type Call = { method: string; params: unknown[] };
// read defensively, so this file loads on a build without the quorum (and fails there, never throws on import)
const roomOf = (Q as unknown as Record<string, unknown>).evmRoomOf as ((calls: readonly Call[]) => (rpc: Rpc) => boolean) | undefined;

const v = evmPoolVenues().base;
const [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET] = v.providers! as [string, string, string, string];
const call = (n: number): Call[] => Array.from({ length: n }, (_, i) => ({ method: "eth_call", params: [{ to: "0x" + "1".repeat(40), data: "0x" + i.toString(16).padStart(2, "0") }, "latest"] }));

/** Base's four providers on the test clock (evmProviders over evmJsonRpc, so each post takes its turn at its
 *  provider's pace): each post answered `ms(url)` after it leaves the device with `answer(url)` as each call's result.
 *  Every post the fetch sees is logged: its provider, its time and its calls. An answer of LOST is no connection, a
 *  fetch's own TypeError with no response. */
const LOST = "lost";
function providers(ms: (url: string) => number, answer: (url: string) => string | null = () => "0x1") {
  const log: { url: string; at: number; calls: number }[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body)) as { id: number }[];
    log.push({ url: u, at: performance.now(), calls: body.length });
    await new Promise((go) => setTimeout(go, ms(u)));
    if (answer(u) === LOST) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body.map((c) => ({ jsonrpc: "2.0", id: c.id, result: answer(u) }))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const rpcs = Q.evmProviders(v.providers!, fetchFn);
  const of = new Map(v.providers!.map((u, k) => [u, rpcs[k]!] as const));
  const urlOf = new Map(v.providers!.map((u, k) => [rpcs[k]!, u] as const));
  return { of, urlOf, log, posts: (u: string, from = -Infinity) => log.filter((p) => p.url === u && p.at >= from).length };
}
type P = ReturnType<typeof providers>;

/** Each provider answers its kind first (`calls`), three posts, so each has its hedge time; then the clock runs 5 s,
 *  so every paced provider's bucket is full again. */
async function warm(p: P, calls: Call[]): Promise<void> {
  for (const u of v.providers!) for (let i = 0; i < 3; i++) await p.of.get(u)!(calls);
  await new Promise((r) => setTimeout(r, 5_000));
}

/** One round of agreeing over `list` asking `calls`, as a quote's reads ask it (`moving`, the late spare's budget
 *  spent, so only a stand-in, a failure's next or the quorum asks past the first two), with the kit's own room for
 *  `calls`. `asked` logs each request agreeing starts: its provider and its time. */
function round(p: P, list: Rpc[], calls: Call[], opts: { room?: (rpc: Rpc) => boolean; vote?: boolean } = {}) {
  const asked: { url: string; at: number }[] = [];
  const room = opts.room ?? roomOf?.(calls);
  const r = (Q.evmAgreeing as unknown as (...a: unknown[]) => Promise<{ a: string; b: string; i: number; j: number }>)(
    list,
    (rpc: Rpc, _k: number, gate: Gate) => {
      asked.push({ url: p.urlOf.get(rpc)!, at: performance.now() });
      gate.sent();
      return rpc(calls, gate.until, gate.wire).then((a) => JSON.stringify(a));
    },
    (a: string, b: string) => a === b,
    () => {
      throw new Error("differ");
    },
    opts.vote ?? true,
    undefined,
    true,
    () => false,
    undefined,
    room,
  );
  return { r, asked };
}

test("Q1 three providers that agree, the first seat 1,400 ms and the other two 300 ms: the round ends at the two fast answers, near 300 ms", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  let slow = false;
  const p = providers((u) => (slow && u === PUBLICNODE ? 1_400 : 300));
  await warm(p, call(3));
  slow = true;
  const list = [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  const t0 = performance.now();
  const { r, asked } = round(p, list, call(3));
  await r;
  const ms = performance.now() - t0;
  assert.ok(ms <= 310, `the round ended ${Math.round(ms)} ms in, waiting on the slow seat's stand-in (asked: ${asked.map((a) => `${a.url} +${Math.round(a.at - t0)}`).join(", ")})`);
  assert.deepEqual(asked.map((a) => a.url), [PUBLICNODE, BLASTAPI, BASE_ORG], "the third is asked at once, and no fourth");
  evmPaceReset();
}));

test("Q2 the third is asked at once only while its pace has room now: with mainnet.base.org's burst spent, no third leaves and the round runs as before", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 100);
  await warm(p, call(3));
  const listOf = () => [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  // its bucket full (12 calls at once): the third leaves with the first two
  let t0 = performance.now();
  let x = round(p, listOf(), call(3));
  await x.r;
  assert.equal(p.posts(BASE_ORG, t0), 1, "with room, mainnet.base.org was not asked as the round's third");
  assert.ok(x.asked.find((a) => a.url === BASE_ORG)!.at - t0 < 1, "the third was not asked at once");
  // its burst spent (4 posts of 3 calls, each answered: 12 calls spent as they are answered, pace.ts): no third at once
  await new Promise((r) => setTimeout(r, 5_000));
  await Promise.all(Array.from({ length: 4 }, () => p.of.get(BASE_ORG)!(call(3))));
  assert.equal(evmPaceReady(BASE_ORG, call(3)), false, "the test did not spend mainnet.base.org's burst");
  t0 = performance.now();
  x = round(p, listOf(), call(3));
  await x.r;
  assert.equal(p.posts(BASE_ORG, t0), 0, "a third was sent with no room in mainnet.base.org's pace");
  assert.deepEqual(x.asked.map((a) => a.url), [PUBLICNODE, BLASTAPI], "with no room the round asks its first two only, as before");
  evmPaceReset();
}));

test("Q3 a round won while its third waits at its pace: the third is never sent, its units are never taken, and its provider is not held", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 300);
  await warm(p, call(3));
  const list = [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  // mainnet.base.org had room as the round read it, then another reader's post took its whole burst before the third
  // reached its pace (a turn out, not yet answered: pace.ts `owed`), so the third waits there
  let other: EvmPaceGive | undefined;
  const room = roomOf?.(call(3));
  const raced = (rpc: Rpc) => {
    const yes = room?.(rpc) === true;
    if (yes && p.urlOf.get(rpc) === BASE_ORG) void (evmPaceTake(BASE_ORG, call(12)) as Promise<EvmPaceGive>).then((g) => (other = g));
    return yes;
  };
  const t0 = performance.now();
  const { r, asked } = round(p, list, call(3), { room: raced });
  await r;
  assert.ok(asked.some((a) => a.url === BASE_ORG && a.at - t0 < 1), "the third was not asked at once");
  // the other reader's post is answered; then the bucket refills
  other?.(true);
  await new Promise((r) => setTimeout(r, 2_000));
  assert.equal(p.posts(BASE_ORG, t0), 0, "the dropped third was sent once its units came back");
  assert.equal(evmPaceReady(BASE_ORG, call(12)), true, "mainnet.base.org's bucket is not full: the dropped third took units");
  const seat = Q.evmProviderSeats("base").find((s) => s.url === BASE_ORG)!;
  assert.equal(seat.rank, 0, "the dropped third held its provider as a failure");
  evmPaceReset();
}));

test("Q4 a first pair that differs is contested as before: every provider asked, more than half needed, so two agreeing liars never win and an honest majority does", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  // each provider answers by its own delay; the liars give 0x2
  const delay: Record<string, number> = { [PUBLICNODE]: 100, [BLASTAPI]: 200, [BASE_ORG]: 300, [POCKET]: 400 };
  let liars = new Set<string>();
  let warmUp = true;
  const p = providers((u) => (warmUp ? 100 : delay[u]!), (u) => (liars.has(u) ? "0x2" : "0x1"));
  await warm(p, call(1));
  warmUp = false;
  const listOf = () => [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  // two liars (publicnode first, mainnet.base.org the third) and two honest: the lie has 2 of the 3 needed, so does the truth
  liars = new Set([PUBLICNODE, BASE_ORG]);
  let t0 = performance.now();
  let x = round(p, listOf(), call(1));
  await assert.rejects(x.r, /differ/, "a value two of four gave was used in a contested round");
  assert.ok(x.asked.find((a) => a.url === BASE_ORG)!.at - t0 < 1, "the third was not asked at once");
  assert.deepEqual([...new Set(x.asked.map((a) => a.url))].sort(), [...v.providers!].sort(), "the contested round did not ask every provider");
  await new Promise((r) => setTimeout(r, 5_000));
  // one liar first and three honest: the first pair differs, and the truth wins with 3 of 4
  liars = new Set([PUBLICNODE]);
  t0 = performance.now();
  x = round(p, listOf(), call(1));
  const won = await x.r;
  assert.equal(JSON.parse(won.a)[0].result, "0x1", "the liar's answer was used");
  assert.ok(x.asked.find((a) => a.url === BASE_ORG)!.at - t0 < 1, "the third was not asked at once");
  assert.deepEqual([...new Set(x.asked.map((a) => a.url))].sort(), [...v.providers!].sort(), "the contested round did not ask every provider");
  evmPaceReset();
}));

test("Q5 Base's four providers end to end, publicnode answering in 1,400 ms: each warm round ends inside 400 ms and mainnet.base.org is sent 12 calls a second at most", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  let slow = false;
  const p = providers((u) => (slow && u === PUBLICNODE ? 1_400 : 300));
  await warm(p, call(3));
  slow = true;
  const list = [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  const t0 = performance.now();
  // a warm tap's three rounds, one after another, each a 3-call aggregate3 batch (the trace's Round 1)
  const took: number[] = [];
  for (let n = 0; n < 3; n++) {
    const at = performance.now();
    await round(p, list, call(3)).r;
    took.push(Math.round(performance.now() - at));
  }
  assert.ok(took.every((ms) => ms < 400), `a warm round took ${took.join(", ")} ms`);
  // the most calls mainnet.base.org was sent in any 1 s from the first round on, against its pace (12 a second, 12 at once)
  const sent = p.log.filter((x) => x.url === BASE_ORG && x.at >= t0);
  const most = Math.max(0, ...sent.map((x) => sent.filter((y) => y.at >= x.at && y.at < x.at + 1_000).reduce((n, y) => n + y.calls, 0)));
  assert.ok(sent.length > 0, "mainnet.base.org was never asked as the rounds' third");
  assert.ok(most <= 12, `mainnet.base.org was sent ${most} calls in one second`);
  assert.equal(p.posts(POCKET, t0), 0, "Pocket was asked: a round went past its three");
  evmPaceReset();
}));

/** A round of Base's four providers whose third answers `third` 400 ms after it is asked, after the first two agree at
 *  300 ms, asked as a quote's reads ask (askAt, over ask): the third's posts from the round's start, at its end and 5 s
 *  later. A not-yet answer is asked again 0.25, 0.5 and 0.75 s on, a lost connection 0.5, 1 and 1.5 s on, while agreeing
 *  has no spare for the request, and a round already agreed has none. */
async function lateThird(third: string | null): Promise<{ atEnd: number; later: number }> {
  Q.evmSpeedReset();
  evmPaceReset();
  let late = false;
  const p = providers((u) => (late && u === BASE_ORG ? 400 : 300), (u) => (late && u === BASE_ORG ? third : "0x1"));
  await warm(p, call(3));
  late = true;
  const list = [PUBLICNODE, BLASTAPI, BASE_ORG, POCKET].map((u) => p.of.get(u)!);
  const askAt = (Q as unknown as Record<string, unknown>).evmAskAt as ((rpc: Rpc, calls: Call[], gate?: Gate) => Promise<readonly unknown[]>) | undefined;
  assert.ok(askAt !== undefined, "no evmAskAt to ask through");
  const t0 = performance.now();
  await (Q.evmAgreeing as unknown as (...a: unknown[]) => Promise<unknown>)(
    list,
    (rpc: Rpc, _k: number, gate: Gate) => askAt!(rpc, call(3), gate).then((a) => JSON.stringify(a)),
    (a: string, b: string) => a === b,
    () => {
      throw new Error("differ");
    },
    true,
    undefined,
    true,
    () => false,
    undefined,
    roomOf?.(call(3)),
  );
  const atEnd = p.posts(BASE_ORG, t0);
  await new Promise((go) => setTimeout(go, 5_000));
  const later = p.posts(BASE_ORG, t0);
  evmPaceReset();
  return { atEnd, later };
}

// the recorded PONS warm tap (test/evm-warm-tap-calls.test.ts): robinhood.rpc.blxrbdn.com, the cold quote's third,
// answered for a block it did not hold yet after the round was agreed and was asked again after the quote had ended
test("Q6 a round won while its third waits to ask again (it answered for a block it does not hold yet): the third is never asked again after the round is agreed", () => onTestClock(async () => {
  const { atEnd, later } = await lateThird(null);
  assert.equal(atEnd, 1, "the third was not asked at once");
  assert.equal(later, 1, "the third was asked again after its round was agreed");
}));

test("Q6b a round won while its third waits to ask again (its post made no connection): the third is never asked again after the round is agreed", () => onTestClock(async () => {
  const { atEnd, later } = await lateThird(LOST);
  assert.equal(atEnd, 1, "the third was not asked at once");
  assert.equal(later, 1, "the third was asked again after its round was agreed");
}));

// card evm-quote-fewer-rounds: a request waiting at its provider's pace past its round's late time moves, unsent, to the
// next provider where that one has a place now. With robinhood.drpc.org held, a warm ANT tap's first round had its
// second answers wait at robinhood.rpc.blxrbdn.com's pace (posts at 56 to 1,835 ms) while Robinhood's own RPC had a
// place, and the tap took 4.4 s (read only from macOS, 2026-11-22 17:1xZ)
test("Q9 a request at a provider's spent pace moves, unsent, to the next with room once late: the round ends near the late time and its two answers, never at the pace's turn", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 100);
  await warm(p, call(3));
  // Pocket's pace spent: its next 3 calls leave about 1.5 s on (2 a second)
  const give = (await evmPaceTake(POCKET, call(3))) as EvmPaceGive;
  give();
  assert.equal(evmPaceReady(POCKET, call(3)), false, "the test did not spend Pocket's pace");
  // mainnet.base.org has no place as the round starts (so no third leaves with the first two), and one from 300 ms on
  const t0 = performance.now();
  const room = (rpc: Rpc) => p.urlOf.get(rpc) === BASE_ORG && performance.now() - t0 >= 300;
  const list = [PUBLICNODE, POCKET, BASE_ORG, BLASTAPI].map((u) => p.of.get(u)!);
  const { r, asked } = round(p, list, call(3), { room });
  await r;
  const ms = performance.now() - t0;
  const seen = asked.map((a) => `${a.url} +${Math.round(a.at - t0)}`).join(", ");
  assert.ok(ms <= 600, `the round ended ${Math.round(ms)} ms in, at Pocket's pace (asked: ${seen})`);
  assert.equal(p.posts(POCKET, t0), 0, `the request moved from Pocket was still sent there (asked: ${seen})`);
  assert.deepEqual(asked.map((a) => a.url), [PUBLICNODE, POCKET, BASE_ORG], "the move asks the next provider once, and no fourth");
  evmPaceReset();
}));

test("Q10 a request at a provider's spent pace waits its turn where the next has no place: nothing moves and no third is sent", () => onTestClock(async () => {
  Q.evmSpeedReset();
  evmPaceReset();
  const p = providers(() => 100);
  await warm(p, call(3));
  const give = (await evmPaceTake(POCKET, call(3))) as EvmPaceGive;
  give();
  const t0 = performance.now();
  const list = [PUBLICNODE, POCKET, BASE_ORG, BLASTAPI].map((u) => p.of.get(u)!);
  const { r, asked } = round(p, list, call(3), { room: () => false });
  await r;
  assert.deepEqual(asked.map((a) => a.url), [PUBLICNODE, POCKET], "a request moved to a provider with no place");
  assert.equal(p.posts(POCKET, t0), 1, "Pocket's request was not sent at its turn");
  assert.ok(performance.now() - t0 >= 1_000, "the round did not wait Pocket's turn");
  evmPaceReset();
}));
