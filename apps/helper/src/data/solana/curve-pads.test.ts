// node --test apps/helper/src/data/solana/curve-pads.test.ts (card helper-curve-all-pads): every Solana launchpad's curve
// progress, each by its own completion rule, and Graduating ranking the pads together. Accounts recorded once from
// api.mainnet-beta.solana.com (getMultipleAccounts, base64, confirmed; slots 471310657-471310658, 2026-11-19 11:00Z)
// through origin.ts readOrigins, in fixtures/solana-curves-all-pads.json: per pad a curve on its way, a completed one,
// and the highest each list held (met-dbc at 97.8%). Each case also holds the raw fields its rule reads, decoded by the
// recorder from the vendors' layouts with its own offsets, so the helper is held to the vendor's rule, not to itself:
//   - pump.fun: complete once real_token_reserves is 0 (pump-fun/pump-public-docs@639b87f docs/PUMP_PROGRAM_README.md
//     "Bonding curve"); progress is the curve's tokens sold against the 793.1 M it starts with (Global
//     initial_real_token_reserves, the same file); a mayhem coin above that start has no progress (its start is not
//     published) and reads null.
//   - Raydium LaunchLab: base sold, real_a against total_sell_a, a buy capped at total_sell_a - real_a
//     (raydium-io/raydium-sdk-V2@32a184e src/raydium/launchpad/curve/curve.ts:286,350); status 0 is the raise.
//   - Meteora DBC: quote raised against the config's migration_quote_threshold, complete at quote_reserve >= threshold
//     (MeteoraAg/dynamic-bonding-curve@3bde880 programs/dynamic-bonding-curve/src/state/virtual_pool.rs:1120
//     is_curve_complete).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PUMP_CURVE_TOKENS, snapshot, toRow, type Row } from "./lists.ts";
import { createOrigins, dbcOf, DBC_PROGRAM, launchlabOf, LAUNCHLAB_PROGRAM, progressOf, pumpOf, readOrigins, type GetAccounts, type Hint, type Origin } from "./origin.ts";

type Case = { case: string; mint: string; hint: Hint; origin: Origin | null; slot: number; fields: Record<string, string | number> };
const FX = JSON.parse(readFileSync(new URL("./fixtures/solana-curves-all-pads.json", import.meta.url), "utf8")) as { cases: Case[]; accounts: Record<string, unknown> };
const recorded: GetAccounts = async (keys) =>
  keys.map((k) => {
    assert.ok(Object.hasOwn(FX.accounts, k), `unrecorded account ${k}`);
    return FX.accounts[k];
  });
const by = (c: string) => FX.cases.find((x) => x.case === c)!;
const acct = (k: string) => FX.accounts[k] as { owner: string; data: [string, string] };
const tweak = (k: string, f: (d: Buffer) => void, owner?: string) => {
  const a = acct(k);
  const d = Buffer.from(a.data[0], "base64");
  f(d);
  return { ...a, owner: owner ?? a.owner, data: [d.toString("base64"), "base64"] };
};
const short = (k: string, n: number) => ({ ...acct(k), data: [Buffer.from(acct(k).data[0], "base64").subarray(0, n).toString("base64"), "base64"] });

/** Each pad's own rule on the recorded raw fields (the vendors' cites above), never the helper's code. */
function rule(c: Case): number | null {
  const f = c.fields;
  const bps = (n: bigint, d: bigint) => Math.min(9_999, Number((n * 10_000n) / d));
  if (c.origin!.family === "pump") {
    const real = BigInt(f.real_token_reserves!);
    if (f.complete === 1) return 10_000;
    return real > PUMP_CURVE_TOKENS ? null : bps(PUMP_CURVE_TOKENS - real, PUMP_CURVE_TOKENS);
  }
  if (c.origin!.family === "launchlab") return f.status === 0 ? bps(BigInt(f.real_a!), BigInt(f.total_sell_a!)) : 10_000;
  const [q, t] = [BigInt(f.quote_reserve!), BigInt(f.migration_quote_threshold!)];
  return f.is_migrated === 1 || q >= t ? 10_000 : bps(q, t);
}

test("every pad's recorded curve reads its own rule's progress: on its way, near completion and completed, for pump.fun, LaunchLab and DBC (and a DBC partner)", async () => {
  const got = await readOrigins(recorded, FX.cases.map((c) => ({ mint: c.mint, hint: c.hint })));
  const families = new Set<string>();
  for (const c of FX.cases) {
    const o = got.get(c.mint)!;
    assert.ok(o, `${c.case}: a launch`);
    assert.equal(o.pad, c.origin!.pad, c.case);
    assert.equal(o.pool, c.origin!.pool, c.case);
    assert.equal(o.curveBps, rule(c), `${c.case}: ${JSON.stringify(c.fields)}`);
    families.add(o.family);
  }
  assert.deepEqual([...families].sort(), ["dbc", "launchlab", "pump"]);
  for (const c of ["pump.fun completed", "raydium-launchlab completed", "met-dbc completed"]) assert.equal(got.get(by(c).mint)!.curveBps, 10_000, c);
  assert.ok(got.get(by("met-dbc near completion").mint)!.curveBps! >= 9_000, "the near-complete DBC curve");
  assert.equal(got.get(by("pump.fun mayhem coin above the start").mint)!.curveBps, null, "a mayhem coin above the start is no number");
  // the vendor-decoded LaunchLab mint is the token: the layout's offsets agree with the vendor's field order
  for (const c of FX.cases.filter((x) => x.origin!.family === "launchlab")) assert.equal(c.fields.mint_a, c.mint);
});

test("DBC's own completion: a pool whose quote reached the config's threshold is complete (10,000) before it migrates, on first read and on each refresh", async () => {
  const c = by("met-dbc near completion");
  const pool = c.origin!.pool;
  const t = BigInt(c.fields.migration_quote_threshold!);
  const at = (q: bigint) => tweak(pool, (d) => d.writeBigUInt64LE(q, 240));
  for (const [q, want] of [[t, 10_000], [t + 1n, 10_000], [t - 1n, 9_999]] as const) {
    const first = await readOrigins(async (keys) => keys.map((k) => (k === pool ? at(q) : FX.accounts[k])), [{ mint: c.mint, hint: c.hint }]);
    assert.equal(first.get(c.mint)!.curveBps, want, `first read, quote ${q} of ${t}`);
    assert.equal(progressOf(c.origin!, c.mint, at(q), t)!.curveBps, want, `refresh, quote ${q} of ${t}`);
  }
});

test("forged accounts read no progress: wrong owner, wrong discriminator, short data, numbers out of range; a null stays null", async () => {
  const ll = by("raydium-launchlab on its curve");
  const lp = ll.origin!.pool;
  assert.notEqual(launchlabOf(acct(lp), ll.mint, null), null);
  assert.equal(launchlabOf(tweak(lp, () => {}, DBC_PROGRAM), ll.mint, null), null, "owner");
  assert.equal(launchlabOf(tweak(lp, (d) => (d[0] = d[0]! ^ 1)), ll.mint, null), null, "discriminator");
  assert.equal(launchlabOf(short(lp, 200), ll.mint, null), null, "short");
  assert.equal(launchlabOf(tweak(lp, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(29) + 1n, 53)), ll.mint, null), null, "sold past the curve");
  assert.equal(launchlabOf(tweak(lp, (d) => d.writeBigUInt64LE(0n, 29)), ll.mint, null), null, "a curve of nothing");
  const db = by("met-dbc near completion");
  const dp = db.origin!.pool;
  assert.notEqual(dbcOf(acct(dp), db.mint, db.origin!.config!), null);
  assert.equal(dbcOf(tweak(dp, () => {}, LAUNCHLAB_PROGRAM), db.mint, db.origin!.config!), null, "owner");
  assert.equal(dbcOf(tweak(dp, (d) => (d[3] = d[3]! ^ 1)), db.mint, db.origin!.config!), null, "discriminator");
  assert.equal(dbcOf(short(dp, 300), db.mint, db.origin!.config!), null, "short");
  assert.equal(dbcOf(tweak(dp, (d) => (d[305] = 7)), db.mint, db.origin!.config!), null, "migrated flag");
  const pf = by("pump.fun on its curve, highest listed");
  const pc = pf.origin!.pool;
  assert.equal(pumpOf(tweak(pc, () => {}, LAUNCHLAB_PROGRAM)), undefined, "owner");
  assert.equal(pumpOf(tweak(pc, (d) => (d[7] = d[7]! ^ 1))), undefined, "discriminator");
  assert.equal(pumpOf(short(pc, 40)), undefined, "short");
  assert.equal(pumpOf(tweak(pc, (d) => (d[48] = 2)))!.curveBps, null, "complete flag");
  // a forged account on refresh keeps the last progress, never a guess (createOrigins keeps `known` when progressOf is null)
  for (const forged of [tweak(lp, () => {}, DBC_PROGRAM), short(lp, 200)]) assert.equal(progressOf(ll.origin!, ll.mint, forged, null), null);
  const o = createOrigins(async (keys) => keys.map((k) => (k === lp ? short(lp, 200) : FX.accounts[k])));
  await o.refresh([{ mint: ll.mint, hint: ll.hint, createdS: 0 }], Date.parse("2026-11-19T11:00:00Z"));
  assert.equal(o.get(ll.mint), null, "a LaunchLab pool that does not read is no launch");
});

test("Graduating ranks tokens from every pad together by progress, highest first; completed curves and no-number curves are out", async () => {
  const got = await readOrigins(recorded, FX.cases.map((c) => ({ mint: c.mint, hint: c.hint })));
  const rows = FX.cases.map((c) => toRow({ id: c.mint, symbol: c.case.slice(0, 8), name: c.case }, 0)!) as Row[];
  const s = snapshot({ new: rows.slice(0, 4), trending_5m: rows.slice(4), trending_1h: rows }, (m) => got.get(m), 0);
  const g = s.lists.graduating;
  assert.deepEqual(
    g.map((r) => [r.launchpad, r.curve_bps]),
    [["met-dbc", 9_777], ["pump.fun", 4_556], ["raydium-launchlab", 21], ["bags.fun", 10]],
  );
  assert.ok(new Set(g.map((r) => r.launchpad)).size >= 3, "pads ranked together");
});
