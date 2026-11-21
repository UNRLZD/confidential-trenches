// Card robinhood-taps-meet-no-429: every tap read goes through one lane per provider (pace.ts evmPaceTake), so a burst
// of a tap's posts reaches each provider no faster than that provider's own limit lets it. Each limit below is the
// provider's, read from mainnet (read only, from the Mac) or from its own page, never ours; the lane is driven at once
// with more posts than a cold tap sends, and each post is judged against that limit as it leaves.
// The reds that asked for it: live sign runs 44429355960 (19 Nov 00:29Z: CASHCAT, robinhood.rpc.blxrbdn.com 1/11),
// 44441959756 (02:07Z: META, bloXroute 31 of 93) and 44651083107 (20 Nov 01:06Z: META, bloXroute 2/18), from a
// provider pace.ts left unpaced. robinhood.drpc.org is not here: its limit is about 600 calls a minute (pace.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { evmPaceReset, evmPaceTake } from "../src/checks/evm/pace.ts";
import { onTestClock } from "./test-clock.ts";

/** A provider's own limit, as a judge of each call when it arrives: true, the provider refuses it. */
type Limit = { readonly name: string; readonly url: string; readonly refuses: () => (now: number, calls: number) => boolean };

/** A token bucket of `burst` calls, refilled at `perS` a second: the provider's limit as its refusals fit it. */
const bucket = (burst: number, perS: number) => () => {
  let tokens = burst;
  let at = 0;
  let first = true;
  return (now: number, calls: number) => {
    if (first) ((first = false), (at = now));
    tokens = Math.min(burst, tokens + ((now - at) / 1000) * perS);
    at = now;
    if (tokens < calls) return true;
    tokens -= calls;
    return false;
  };
};

const LIMITS: readonly Limit[] = [
  // bloXroute's Robinhood endpoint, the quote list's fourth: posts of 3 eth_call (a real cbBTC tap's own, 2,568 bytes)
  // from the Mac, 2026-11-20 01:53-01:58Z: 4, 8, 12 and 16 calls a second for 10 s none refused; 24 a second refused
  // from the 30th call, 20 a second from the 57th, 18 a second (posts of 1) from the 153rd, each as HTTP 429 or as a
  // 200 whose calls' error is -32005 "Rate limited. Read-only traffic (eth_call, eth_getBlockReceipts, etc.) has a
  // reduced rate limit on this endpoint." Three refusals fit one bucket: 9 at once, 17 a second back (9 + 1.25 x 17 =
  // 30, 9 + 2.85 x 17 = 57, 9 + 8.5 x 17 = 153).
  { name: "robinhood.rpc.blxrbdn.com", url: "https://robinhood.rpc.blxrbdn.com", refuses: bucket(9, 17) },
];

/** `posts` posts of `size` eth_call to `url`, all asked at once through the lane, each reaching the provider `path(n)`
 *  ms after it leaves (its n-th) and answered `ms` after that: how many calls the provider's limit refused. */
async function drive(limit: Limit, posts: number, size: number, ms: number, path: (n: number) => number = () => 0): Promise<number> {
  const judge = limit.refuses();
  const calls = Array.from({ length: size }, () => ({ method: "eth_call" }));
  let refused = 0;
  let sent = 0;
  await Promise.all(
    Array.from({ length: posts }, async () => {
      const give = await evmPaceTake(limit.url, calls);
      const wait = path(sent++);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (judge(performance.now(), size)) refused += size;
      await new Promise((r) => setTimeout(r, ms));
      give();
    }),
  );
  return refused;
}

for (const limit of LIMITS) {
  test(`card robinhood-taps-meet-no-429: a burst of a tap's posts to ${limit.name} reaches it inside its own limit`, { timeout: 60_000 }, () =>
    onTestClock(async () => {
      // 60 posts of 3 calls (a cold META tap sent bloXroute 93 posts) and 120 posts of 1, each answered 100 ms on
      for (const [posts, size] of [[60, 3], [120, 1]] as const) {
        evmPaceReset();
        const refused = await drive(limit, posts, size, 100);
        evmPaceReset();
        assert.equal(refused, 0, `${limit.name}: ${refused} of ${posts * size} calls in posts of ${size} past its limit`);
      }
    }),
  );
}

// Card evm-warm-tap-ends-inside-two-seconds, round F: release 189's sign live run 44924144323 (ANT warm 3: one 429 of
// robinhood.rpc.blxrbdn.com, an eth_getBlockByNumber, 1 of 10 posts). The lane counts a call as it leaves the device;
// the provider's bucket counts it as it arrives. A post that opens a new connection (TCP and TLS, two or three round
// trips: 300 to 600 ms from a runner far from the provider) arrives behind the posts sent after it, and they arrive
// together: the lane's 6 at once and 15 a second absorb 200 ms of such a lag at most (6 + 15 x 0.2 = 9). Here the
// connection is lost 1 s in and back 600 ms later: every post sent meanwhile waits for it and arrives as it opens (one
// connection per origin, HTTP/2 in a browser), as each post of a sustained burst behind it.
for (const limit of LIMITS) {
  test(`card evm-warm-tap-ends-inside-two-seconds: posts to ${limit.name} that reach it late on a new connection still arrive inside its own limit`, { timeout: 60_000 }, () =>
    onTestClock(async () => {
      for (const [posts, size] of [[60, 3], [120, 1]] as const) {
        evmPaceReset();
        const t0 = performance.now();
        const refused = await drive(limit, posts, size, 100, () => {
          const at = performance.now() - t0;
          return at >= 1_000 && at < 1_600 ? 1_600 - at : 0;
        });
        evmPaceReset();
        assert.equal(refused, 0, `${limit.name}: ${refused} of ${posts * size} calls in posts of ${size} past its limit as they arrive`);
      }
    }),
  );
}

