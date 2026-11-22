// Card helper-warm-start-coingecko-bound: a path CoinGecko answered 404 is not sent again for CG_MISS_HOLD_MS, per path
// with its query left off; the minute line names each held one "404 held". A cold helper's live run sent 81 of its 329
// CoinGecko calls as 404s (helper-216, 22 Nov), each one counted against the day as any call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CG_MISS_HOLD_MS, CG_ONCHAIN, coingeckoPace, createKeyed } from "./coingecko.ts";
import { providerHolds } from "../limits/limits.ts";

const KEY = ["CG", "planted", "test", "key", "only"].join("-");
const ENV = { COINGECKO_API_KEY: KEY, COINGECKO_CALLS_PER_MIN: "300" };
const NEW = "/networks/solana/tokens/NewCoin1111111111111111111111111111111pump";
const LISTED = "/networks/solana/tokens/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

function keyed() {
  const t = { t: Date.parse("2026-11-22T17:40:00Z") };
  const sent: string[] = [];
  const fetch = async (url: string) => {
    sent.push(url.slice(CG_ONCHAIN.length));
    const path = url.slice(CG_ONCHAIN.length).split("?")[0];
    return path === LISTED || path.startsWith(`${LISTED}/`) ? new Response("{}", { status: 200 }) : new Response("{}", { status: 404 });
  };
  const holds = providerHolds(() => t.t, coingeckoPace(ENV));
  const k = createKeyed(ENV, holds, { fetch: fetch as never, now: () => t.t })!;
  return { t, sent, k };
}
const any = () => true;

test("a 404 path is sent once while held, its repeats answered not found with no call and counted as 404 held (red on main: 3 sent)", async () => {
  const { sent, k } = keyed();
  for (let i = 0; i < 3; i++) assert.equal(await k.read(NEW, any), undefined);
  assert.deepEqual(sent, [NEW]);
  assert.equal(k.minute(), "coingecko calls: 404 1, 404 held 2");
});

test("the hold is per path with its query left off: a bars read of another before_timestamp is the same path, another kind is not", async () => {
  const { sent, k } = keyed();
  const bars = "/networks/solana/pools/NewPool111111111111111111111111111111111111/ohlcv/minute";
  await k.read(`${bars}?aggregate=1&limit=100&before_timestamp=1`, any);
  await k.read(`${bars}?aggregate=1&limit=100&before_timestamp=2`, any);
  await k.read(`${NEW}/pools`, any);
  assert.deepEqual(sent, [`${bars}?aggregate=1&limit=100&before_timestamp=1`, `${NEW}/pools`]);
});

test("past CG_MISS_HOLD_MS the path is asked again, so a coin the index lists meanwhile is read; an answered path is never held", async () => {
  const { t, sent, k } = keyed();
  await k.read(NEW, any);
  t.t += CG_MISS_HOLD_MS - 1;
  await k.read(NEW, any);
  t.t += 1;
  await k.read(NEW, any);
  assert.deepEqual(sent, [NEW, NEW]);
  assert.deepEqual(await k.read(LISTED, any), {});
  assert.deepEqual(await k.read(LISTED, any), {});
  assert.equal(sent.filter((p) => p === LISTED).length, 2);
});
