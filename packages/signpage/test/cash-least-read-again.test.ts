// Card cash-least-read-again: sign live run 44300899132 (18 Nov 12:09Z) read 1Click, through the helper's proxy, answer
// "Failed to get quote" and "No liquidity available" over seconds in which it named its least before and after (77,361
// into SOL at 12:20Z). The device's least read (cash-to-pool.ts readOneClickLeast) took such an answer as no least, so a
// move from Cash was planned with its parts held to their own quotes alone, and a part split under 1Click's least met a
// refusal. Now an answer that is neither a least nor a quote is asked again, LEAST_READ_TRIES tries in all on the
// injected sleep, the whole read within LEAST_READ_BUDGET_MS; with every try spent the read throws naming the last
// answer, and the mover plans nothing (down), never a plan without the least. Red at a2d7d828b.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cashMover, LEAST_READ_BACKOFF_MS, LEAST_READ_BUDGET_MS, LEAST_READ_TRIES, readOneClickLeast, type CashMoverDeps, type CashNote } from "../src/cash-to-pool.ts";

const PRICE = { price: "8000000000", expo: -8 }; // SOL at 80 USD
const FEE = 50_000n; // the vault withdraw's relay fee, 0.05 USDC
const LEAST = 77_361n; // 1Click's least into SOL, the live check's read at 18 Nov 12:20Z
const ADDRESS = "d".repeat(64);
// Cash: one note that pays a part of any size
const NOTES: CashNote[] = [{ id: "n1", value: 5_000_000n }];

const body = (m: string) => JSON.stringify({ message: m, correlationId: "00000000-0000-0000-0000-000000000000", timestamp: "2026-11-18T12:09:26.000Z", path: "/v0/quote" });
const LEAST_ANSWER = () => new Response(body(`Amount is too low for bridge, try at least ${LEAST}`), { status: 400 });
const FAILED = () => new Response(body("Failed to get quote"), { status: 400 });
const NO_LIQUIDITY = () => new Response(body("No liquidity available"), { status: 400 });

/** 1Click as a script of answers, one a request, the last kept; every amount asked recorded. */
function oneClick(script: readonly (() => Response | Promise<Response>)[]) {
  const asked: string[] = [];
  const fetchFn = (async (_u: unknown, init: RequestInit) => {
    asked.push(String(JSON.parse(String(init.body)).amount));
    return script[Math.min(asked.length, script.length) - 1]!();
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}
/** The injected clock's sleep: every wait asked, none taken. */
function clock() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

function mover(least: CashMoverDeps["least"]) {
  const quoted: bigint[] = [];
  const paid: bigint[] = [];
  const d: CashMoverDeps = {
    price: () => PRICE,
    floor: async () => 0n,
    least,
    rails: ["1click"],
    quote: async (_c, usdc) => (quoted.push(usdc), { address: ADDRESS, amountIn: usdc, minOut: (usdc * 10n ** 9n * 10_000n) / (80_000_000n * 10_100n) }),
    fee: async () => FEE,
    cash: async () => 5_000_000n,
    notes: async () => NOTES,
    handoff: async (w) => (paid.push(w.amount), { kind: "arrived" }),
    landed: async () => false,
    now: () => 1_000,
  };
  return { m: cashMover(d), quoted, paid };
}

test("the bound: three tries, waits of 500 ms then 1,500 ms, the whole read within the 10 s a dry is answered in", () => {
  assert.equal(LEAST_READ_TRIES, 3);
  assert.deepEqual([...LEAST_READ_BACKOFF_MS], [500, 1_500]);
  assert.equal(LEAST_READ_BACKOFF_MS.length, LEAST_READ_TRIES - 1);
  assert.equal(LEAST_READ_BUDGET_MS, 10_000);
});

test("1Click fails a quote, then names its least: the move is planned to the least", async () => {
  // "Failed to get quote" up the whole ladder (one unit to one USDC), then the least at one USDC asked again
  const blip = oneClick([FAILED, FAILED, FAILED, FAILED, FAILED, FAILED, FAILED, LEAST_ANSWER]);
  const c = clock();
  const t = mover((chain) => readOneClickLeast(chain, blip.fetchFn, 0, { sleep: c.sleep }));
  const r = await t.m.plan("solana", 1_000_000n);
  assert.ok(!("error" in r), JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.equal(r.part, LEAST, "the least part is 1Click's least");
  assert.ok(r.parts !== null && r.parts.every((p) => p.usdc >= LEAST));
  assert.deepEqual(blip.asked, ["1", "10", "100", "1000", "10000", "100000", "1000000", "1000000"]);
  assert.deepEqual(c.waits, [500], "one wait, on the injected clock");
});

test("every blip 1Click gave or may give is asked again: No liquidity, a 5xx, a 429, no answer", async () => {
  const timeout = () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  const cases: [string, () => Response | Promise<Response>][] = [
    ["No liquidity available", NO_LIQUIDITY],
    ["HTTP 502", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["HTTP 429", () => new Response(body("Too many requests"), { status: 429 })],
    ["a timeout", timeout],
  ];
  for (const [why, blip] of cases) {
    const o = oneClick([blip, blip, LEAST_ANSWER]);
    const c = clock();
    assert.equal(await readOneClickLeast("solana", o.fetchFn, 0, { sleep: c.sleep }), LEAST, why);
    assert.deepEqual(o.asked, ["1", "1", "1"], `${why}: the same amount asked again`);
    assert.deepEqual(c.waits, [500, 1_500], why);
  }
});

test("every try fails: the read names the failure and the move plans nothing, never a plan without the least", async () => {
  const down = oneClick([NO_LIQUIDITY]);
  const c = clock();
  await assert.rejects(readOneClickLeast("solana", down.fetchFn, 0, { sleep: c.sleep }), /no least in 3 tries: .*No liquidity available/);
  assert.equal(down.asked.length, LEAST_READ_TRIES);
  assert.deepEqual(c.waits, [500, 1_500]);
  // the Move screen's plan and its move: down, no quote asked, no note leaves Cash
  const t = mover((chain) => readOneClickLeast(chain, oneClick([FAILED]).fetchFn, 0, { sleep: async () => {} }));
  assert.deepEqual(await t.m.plan("solana", 1_000_000n), { error: "down" });
  assert.deepEqual(await t.m.move("solana", 1_000_000n, "op-1"), { error: "down" });
  // a buy's shortfall: no move started
  assert.equal(await t.m.need("solana", 30_000_000n), null);
  assert.deepEqual(t.quoted, [], "no part's quote asked");
  assert.deepEqual(t.paid, [], "nothing withdrawn");
});

test("a refusal that names no least is no blip: never asked again, and no plan", async () => {
  const o = oneClick([() => new Response(body("recipient is not valid"), { status: 400 })]);
  const c = clock();
  await assert.rejects(readOneClickLeast("solana", o.fetchFn, 0, { sleep: c.sleep }), /names no least: HTTP 400 recipient is not valid/);
  assert.deepEqual(o.asked, ["1"]);
  assert.deepEqual(c.waits, []);
  // a least of none is no least
  await assert.rejects(readOneClickLeast("solana", oneClick([() => new Response(body("Amount is too low for bridge, try at least 0"), { status: 400 })]).fetchFn, 0, { sleep: c.sleep }), /names no least/);
});

test("the budget: a read past it asks nothing more and names it", async () => {
  const o = oneClick([LEAST_ANSWER]);
  await assert.rejects(readOneClickLeast("solana", o.fetchFn, 0, { signal: AbortSignal.abort(), sleep: async () => {} }), /no least within 10000 ms/);
  assert.deepEqual(o.asked, []);
  // a budget that ends during a wait: no try after it
  const ac = new AbortController();
  const late = oneClick([NO_LIQUIDITY, LEAST_ANSWER]);
  await assert.rejects(readOneClickLeast("solana", late.fetchFn, 0, { signal: ac.signal, sleep: async () => ac.abort() }), /no least within 10000 ms/);
  assert.deepEqual(late.asked, ["1"]);
});

test("a move whose least read is given as none is still held to each part's own quote alone (no read wired)", async () => {
  const t = mover(undefined);
  const r = await t.m.plan("solana", 1_000_000n);
  assert.ok(!("error" in r));
});
