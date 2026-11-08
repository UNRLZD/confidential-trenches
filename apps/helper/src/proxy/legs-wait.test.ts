// Card solana-legs-share-wait: a many-wallet Solana trade on Jupiter's Free plan through the helper's real budget
// (createProxy with PROXY_BUDGETS.jupiter: 60 a minute, 34 kept for the helper's own reads, a device's share 4 a 10 s
// window, lent past it while room stays for others). Every leg is the kit's own cap search (fetchSolanaJupiterBuildThatFits)
// sharing one SolanaBuildRoom, as runSolanaTrade's legs do: legs inside the share search at once, a leg the helper
// answers 429 or 503 waits its Retry-After inside the trade's 10-minute bound and then asks the cap another leg fitted.
// The token has no route at 40 and one at 48 (a new pump.fun curve's shape, solana-uncapped-fits). Time is virtual:
// the helper's queue and the device's waits move one clock, so a run of minutes takes milliseconds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SolanaBuildError, SolanaBuildRoom, fetchSolanaJupiterBuildThatFits } from "@blindfill/kit";
import { createProxy } from "./proxy.ts";

const GOOD = JSON.parse(readFileSync(new URL("../../test/fixtures/jupiter-build.json", import.meta.url), "utf8")) as { mint: string; wallet: string; body: string };
const ENV = { JUPITER_API_KEY: "fake-jupiter-key-" + "j".repeat(16), RELAY_API_KEY: "fake-relay-key-" + "r".repeat(16), LIFI_API_KEY: "fake-lifi-key-" + "l".repeat(16), ONECLICK_JWT: "fake.oneclick.jwt-" + "o".repeat(16) };
const BOUND_MS = 10 * 60_000; // flow.ts SOLANA_TRADE_BUILD_WAIT_MS

/** Virtual time: sleep(ms) parks until the clock reaches it; run() moves the clock to the next timer whenever every
 * task is parked, until `done` settles. */
function virtualTime(t0 = 1_800_000_000_000) {
  let t = t0;
  const timers: { at: number; go: () => void }[] = [];
  const sleep = (ms: number) => new Promise<void>((go) => { timers.push({ at: t + Math.max(ms, 0), go }); });
  const idle = async () => { for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); };
  async function run<T>(done: Promise<T>): Promise<T> {
    let settled = false;
    done.then(() => (settled = true), () => (settled = true));
    for (;;) {
      await idle();
      if (settled) return done;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      if (!next) throw new Error("stuck: no timer and not done");
      t = Math.max(t, next.at);
      next.go();
    }
  }
  return { now: () => t, sleep, run };
}

async function trade(legs: number) {
  const v = virtualTime();
  const vendorCalls: number[] = [];
  const proxy = createProxy(ENV, {
    now: v.now,
    sleep: v.sleep,
    fetch: async (url: string) => {
      const cap = Number(new URL(url).searchParams.get("maxAccounts"));
      vendorCalls.push(cap);
      return cap < 48 ? new Response('{"error":"No routes found"}', { status: 400, headers: { "content-type": "application/json" } }) : new Response(GOOD.body, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const answers: number[] = [];
  // the device's calls reach the helper's proxy as one client, the device
  const fetch = async (url: string) => {
    const u = new URL(url);
    const a = await proxy.handle("jupiter", "/swap/v2/build", u.search.slice(1), "", "device");
    answers.push(a.status);
    return new Response(a.body, { status: a.status, headers: a.headers });
  };
  const room = new SolanaBuildRoom({ total: legs, boundMs: BOUND_MS, clock: v.now, sleep: v.sleep });
  const t0 = v.now();
  const req = (i: number) => ({ side: "sell" as const, wallet: GOOD.wallet, token: GOOD.mint, amount: BigInt(1_000_000 + i), slippageBps: 1000 });
  const out = await v.run(Promise.all(Array.from({ length: legs }, async (_, i) => {
    try {
      const f = await fetchSolanaJupiterBuildThatFits("https://ct-api.unrealized.trade", req(i), () => "fits", { fetch, now: v.now, wait: room.wait });
      room.fitted(f.maxAccounts);
      return { steps: f.steps, calls: f.calls.length };
    } catch (e) {
      return { refused: e instanceof SolanaBuildError ? e.message : String(e) };
    } finally {
      room.done();
    }
  })));
  const wallMs = v.now() - t0;
  const statuses = answers.reduce<Record<number, number>>((m, s) => ((m[s] = (m[s] ?? 0) + 1), m), {});
  console.log(`${legs} legs: ${vendorCalls.length} Jupiter builds (${vendorCalls.filter((c) => c === 40).length} at 40, ${vendorCalls.filter((c) => c === 48).length} at 48), helper answers ${JSON.stringify(statuses)}, wall time ${(wallMs / 1000).toFixed(0)} s`);
  return { out, vendorCalls, wallMs, room };
}

for (const legs of [12, 64]) {
  test(`a ${legs}-leg sell on a token with no route at 40, on Free: every leg built at 48, none refused, inside the 10-minute bound`, async () => {
    const { out, vendorCalls, wallMs, room } = await trade(legs);
    for (const [i, o] of out.entries()) {
      assert.equal("refused" in o ? o.refused : undefined, undefined, `leg ${i}`);
      const steps = (o as { steps: { maxAccounts: number; outcome: string }[] }).steps;
      assert.equal(steps.at(-1)?.maxAccounts, 48, `leg ${i}`);
      assert.equal(steps.at(-1)?.outcome, "fits", `leg ${i}`);
      // a leg searched at once (40 then 48), or waited and asked 48 once
      assert.ok(steps.length === 2 || steps.length === 1, `leg ${i}: ${JSON.stringify(steps)}`);
    }
    assert.ok(wallMs <= BOUND_MS, `wall ${wallMs}`);
    // each leg one build at 48; at 40 only the legs that went at once
    assert.equal(vendorCalls.filter((c) => c === 48).length, legs);
    assert.ok(vendorCalls.length <= 2 * legs);
    assert.deepEqual(room.progress, { built: legs, waiting: 0, total: legs });
  });
}
