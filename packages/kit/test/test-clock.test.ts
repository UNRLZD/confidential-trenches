// The test clock's own checks (card fresh-run-margin): test/test-clock.ts skips idle time only, runs a test's work out
// before the next test, and fails a test whose timers never stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { onTestClock } from "./test-clock.ts";

test("a wait is skipped, never shortened: 10 s of timers end at once, in order of time; Date.now stays whole ms, never runs back, and shows each wait at least as long as it was set", async () => {
  const real = process.hrtime.bigint();
  const date = Date.now();
  const order: number[] = [];
  const reads: number[] = [];
  const shown: [number, number][] = [];
  const read = await onTestClock(async () => {
    const t = performance.now();
    reads.push(Date.now());
    // waits that leave fractions of a millisecond on the clock, back to back and side by side
    const wait = (ms: number) => {
      const at = Date.now();
      reads.push(at);
      return new Promise<void>((r) =>
        setTimeout(() => {
          reads.push(Date.now());
          shown.push([ms, Date.now() - at]);
          r();
        }, ms),
      );
    };
    await Promise.all([3_000, 10_000, 1_000].map((ms) => wait(ms).then(() => void order.push(ms))));
    for (const ms of [0.4, 1, 1.5, 7, 333.3, 999]) await wait(ms);
    await Promise.all([2.5, 2.5, 0.1].map(wait));
    return performance.now() - t;
  });
  reads.push(Date.now());
  assert.ok(read >= 10_000, `${read} ms on the clock`);
  assert.ok(Date.now() - date >= 10_000, `${Date.now() - date} ms on Date.now`);
  const ms = Number(process.hrtime.bigint() - real) / 1e6;
  assert.ok(ms < 2_000, `${ms} ms in real time`);
  assert.deepEqual(order, [1_000, 3_000, 10_000]);
  assert.ok(reads.every(Number.isInteger), `Date.now not whole ms: ${reads.filter((x) => !Number.isInteger(x)).join(", ")}`);
  assert.ok(reads.every((x, i) => i === 0 || x >= reads[i - 1]!), "Date.now ran back");
  assert.ok(reads[0]! >= date, "Date.now on the clock read below the real one");
  for (const [set, saw] of shown) assert.ok(saw >= Math.ceil(set), `a wait of ${set} ms shown as ${saw} ms on Date.now`);
  assert.equal(shown.length, 12);
});

test("AbortSignal.timeout is on the clock: a request's deadline aborts it at its time", async () => {
  const ms = await onTestClock(async () => {
    const t = performance.now();
    const s = AbortSignal.timeout(5_000);
    await new Promise((r) => s.addEventListener("abort", r));
    assert.equal((s.reason as DOMException).name, "TimeoutError");
    return performance.now() - t;
  });
  assert.ok(ms >= 5_000, `${ms} ms`);
});

test("a test's work left running is run out before the next test: a timer it never awaited still fires inside the clock", async () => {
  let fired = false;
  await onTestClock(async () => void setTimeout(() => (fired = true), 30_000));
  assert.equal(fired, true);
});

test("a test whose timers never stop fails, naming where they were set", async () => {
  const again = () => void setTimeout(again, 1_000);
  await assert.rejects(onTestClock(async () => again()), /left 1 timer\(s\) that never stop: .*test-clock\.test\.ts/);
});

test("a clear of a timer set outside the clock reaches it; a clear of a cleared timer of an earlier run takes out none of a later one", async () => {
  let outside = false;
  const h = setTimeout(() => (outside = true), 20);
  let early: unknown;
  await onTestClock(async () => {
    clearTimeout(h);
    early = setTimeout(() => {}, 5);
    clearTimeout(early as ReturnType<typeof setTimeout>);
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(outside, false);
  let later = false;
  await onTestClock(async () => {
    setTimeout(() => (later = true), 5);
    clearTimeout(early as ReturnType<typeof setTimeout>);
  });
  assert.equal(later, true);
});

// card test-clock-runs-on-virtual-time: the clock moves only by the waits it skips, never by real elapsed time, so a test
// reads the same times on a slow or busy machine (a judge's laptop, packages run side by side) as on a fast one
test("work takes no time on the clock: 50 ms of real work between two reads reads 0 ms, and a wait after it reads exactly its length", async () => {
  const busy = (ms: number) => {
    const end = process.hrtime.bigint() + BigInt(ms * 1e6);
    while (process.hrtime.bigint() < end);
  };
  const [work, wait, day] = await onTestClock(async () => {
    const t = performance.now();
    const d = Date.now();
    busy(50);
    const work = performance.now() - t;
    await new Promise((r) => setTimeout(r, 1_000));
    busy(20);
    return [work, performance.now() - t, Date.now() - d];
  });
  assert.equal(work, 0, `real work moved the clock ${work} ms`);
  assert.equal(wait, 1_000, `a 1 s wait read ${wait} ms`);
  assert.equal(day, 1_000, `Date.now moved ${day} ms`);
});

test("a run is bounded by its own time, not the machine's: 590 s of waits with real work between them never runs away", async () => {
  const ms = await onTestClock(async () => {
    const t = performance.now();
    for (let i = 0; i < 59; i++) {
      const end = process.hrtime.bigint() + 1_000_000n; // 1 ms of real work a wait
      while (process.hrtime.bigint() < end);
      await new Promise((r) => setTimeout(r, 10_000));
    }
    return performance.now() - t;
  });
  assert.equal(ms, 590_000);
});

test("between runs the clock moves with real time from where the last run left it, never back; runs do not nest", async () => {
  const end = await onTestClock(async () => (await new Promise((r) => setTimeout(r, 60_000)), performance.now()));
  const after = performance.now();
  assert.ok(after >= end, `the clock ran back: ${after} after ${end}`);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(performance.now() - after >= 15, "the clock stood still between runs");
  await assert.rejects(onTestClock(async () => onTestClock(async () => 1)), /does not nest/);
});

// The wallet's store seals with crypto.subtle, which runs in the thread pool, outside the clock. A clock that skipped while
// it ran fired a page's 50 ms polls and 15 s passes by the hundred on a busy machine before the store answered, and ran
// past RUNAWAY_MS (positions-requests.test.ts on the box with 3 CPU hogs on its core, 5 of 5 red): work outside the clock
// holds it, as work on the main thread does, so it takes no time on it.
test("work in the thread pool holds the clock: a 1 s poll waiting on a crypto.subtle key derivation sees it at its first turn", async () => {
  const base = await crypto.subtle.importKey("raw", new Uint8Array(16), "PBKDF2", false, ["deriveBits"]);
  const [polls, ms] = await onTestClock(async () => {
    const t = performance.now();
    let done = false;
    void crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(8), iterations: 300_000 }, base, 256).then(() => (done = true));
    let polls = 0;
    while (!done) {
      polls++;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return [polls, performance.now() - t];
  });
  assert.equal(polls, 1, `${polls} polls of 1 s while the digest ran`);
  assert.equal(ms, 1_000);
  assert.equal(Object.hasOwn(crypto.subtle, "deriveBits"), false, "crypto.subtle is the real one again after the run");
});

test("the store's seal on the clock is the web's AES-GCM, settled when asked: what the clock seals the real crypto.subtle opens, and back; a wrong tag or AAD is refused as the web refuses it", async () => {
  const iv = new Uint8Array(12).fill(7), aad = new TextEncoder().encode("meta/seed"), plain = new TextEncoder().encode("the words stay here");
  const real = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const realSealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, real, plain));
  const got = await onTestClock(async () => {
    let settled = false;
    const sealing = crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, real, plain).then((b) => ((settled = true), b));
    await Promise.resolve();
    await Promise.resolve();
    const atOnce = settled;
    const sealed = new Uint8Array(await sealing);
    const opened = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, real, realSealed));
    const made = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const madeSealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, made, plain);
    const bad = new Uint8Array(sealed);
    bad[bad.length - 1]! ^= 1;
    const refused = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, real, bad).then(() => "opened", (e: DOMException) => e.name);
    const wrongAad = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, real, sealed).then(() => "opened", (e: DOMException) => e.name);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plain));
    return { atOnce, sealed, opened, made, madeSealed, refused, wrongAad, digest };
  });
  assert.equal(got.atOnce, true, "settled when asked, not after a thread pool's turn");
  assert.deepEqual(got.sealed, realSealed, "the same bytes as the real AES-GCM");
  assert.deepEqual(got.opened, plain);
  assert.equal(got.made.extractable, false);
  assert.deepEqual(got.made.usages, ["encrypt", "decrypt"]);
  assert.deepEqual(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, got.made, got.madeSealed)), plain, "a key made on the clock opens off it");
  assert.equal(got.refused, "OperationError");
  assert.equal(got.wrongAad, "OperationError");
  assert.deepEqual(got.digest, new Uint8Array(await crypto.subtle.digest("SHA-256", plain)));
});
