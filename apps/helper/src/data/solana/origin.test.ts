// node --test apps/helper/src/data/solana/origin.test.ts: a Solana token's launchpad read on chain (origin.ts), on
// accounts recorded 2026-11-03 16:49Z from api.mainnet-beta.solana.com (getMultipleAccounts, base64, confirmed) for
// tokens on Jupiter's live lists of that minute (fixtures/solana-origins.json, each token's case on its row): two per
// pad where the lists held two, a token Jupiter leaves untagged that the chain tags, a token Jupiter tags that no
// launchpad program made, and tokens no launchpad made.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PADS } from "../../../../terminal/src/screens/market/pads.ts";
import {
  APP_PADS, createOrigins, dbcConfigOf, dbcOf, dbcPool, DBC_PROGRAM, firstKeys, hintsOf, launchlabOf, launchlabPool, LAUNCHLAB_PROGRAM, ORIGIN_ASKS_PER_TICK, pda,
  progressOf, pumpOf, readOrigins, SETTLE_S, USD1, WSOL, type GetAccounts, type Hint, type Origin,
} from "./origin.ts";
import { pumpCurveAddress, PUMP_PROGRAM } from "./lists.ts";

type Token = { case: string; mint: string; hint: Hint; origin: Origin | null; jupiter: Record<string, unknown> };
const FX = JSON.parse(readFileSync(new URL("./fixtures/solana-origins.json", import.meta.url), "utf8")) as { read_at: string; tokens: Token[]; accounts: Record<string, unknown> };
const AT = Date.parse(FX.read_at);
/** Accounts from the recording; a key it does not hold fails the test, so the read asks only what it asked then. */
const recorded = (calls: string[][] = []): GetAccounts => async (keys) => {
  calls.push([...keys]);
  return keys.map((k) => {
    assert.ok(Object.hasOwn(FX.accounts, k), `unrecorded account ${k}`);
    return FX.accounts[k];
  });
};
const asks = (ts: readonly Token[]) => ts.map((t) => ({ mint: t.mint, hint: t.hint, createdS: null }));
const of = (c: string) => FX.tokens.filter((t) => t.case === c);
const acct = (k: string) => FX.accounts[k] as { owner: string; data: [string, string] };
const tweak = (k: string, f: (d: Buffer) => void, owner?: string) => {
  const a = acct(k);
  const d = Buffer.from(a.data[0], "base64");
  f(d);
  return { ...a, owner: owner ?? a.owner, data: [d.toString("base64"), "base64"] };
};

test("every recorded token reads the launch recorded for it: the pad, the pool and the progress", async () => {
  const got = await readOrigins(recorded(), asks(FX.tokens));
  for (const t of FX.tokens) assert.deepEqual(got.get(t.mint), t.origin, `${t.case}: ${t.mint}`);
});

test("per pad: two live tokens tagged with that pad where the lists held two, each from its own program's account", async () => {
  const got = await readOrigins(recorded(), asks(FX.tokens));
  const pads = (c: string) => of(c).map((t) => got.get(t.mint)?.pad);
  assert.deepEqual(pads("pump.fun on its curve"), ["pump.fun", "pump.fun"]);
  assert.deepEqual(pads("pump.fun graduated"), ["pump.fun"]);
  assert.deepEqual(pads("raydium-launchlab"), ["raydium-launchlab", "raydium-launchlab", "raydium-launchlab"]);
  assert.deepEqual(pads("stonkfun"), ["stonkfun", "stonkfun"]);
  assert.deepEqual(pads("met-dbc"), ["met-dbc", "met-dbc"]);
  // the lists held one of each of these on 3 Nov
  assert.deepEqual(pads("Raydium"), ["Raydium"]);
  assert.deepEqual(pads("letsbonk.fun"), ["letsbonk.fun"]);
  for (const t of FX.tokens) {
    const o = got.get(t.mint);
    if (!o) continue;
    // the pool is the program's own address for this mint, so only that program can have made it
    if (o.family === "pump") assert.equal(o.pool, pumpCurveAddress(t.mint));
    if (o.family === "launchlab") assert.ok([WSOL, USD1].some((q) => launchlabPool(t.mint, q) === o.pool) || o.curveBps === 10_000, `${t.mint}: a SOL or USD1 pool, or a graduated one found by its pool's quote`);
    if (o.family === "dbc") assert.equal(o.pool, dbcPool(t.mint, o.config!, dbcConfigOf(FX.accounts[o.config!])!.quote));
  }
});

test("Jupiter's word: an untagged token gets its pad from the chain; a tag no launch backs is dropped; a tag the app cannot draw is the family pad", async () => {
  const got = await readOrigins(recorded(), asks(FX.tokens));
  for (const t of of("untagged by Jupiter, tagged from the chain")) {
    assert.equal(t.hint.tag, null);
    assert.equal(got.get(t.mint)?.pad, "pump.fun");
  }
  const [metadao] = of("tagged by Jupiter, no launch on chain: untagged");
  assert.equal(metadao!.hint.tag, "metadao");
  assert.equal(got.get(metadao!.mint), null);
  const [moon] = of("a DBC partner tag the app does not draw: the family pad");
  assert.equal(moon!.hint.tag, "moonshot");
  assert.equal(got.get(moon!.mint)?.pad, "met-dbc");
  for (const t of of("untagged, no launchpad").concat(of("a LaunchLab token on its curve against another quote: not found, untagged"))) assert.equal(got.get(t.mint), null, t.case);
  // a platform tag is kept only when the pool's own config is the one Jupiter names
  const [bonk] = of("letsbonk.fun");
  const other = await readOrigins(recorded(), [{ mint: bonk!.mint, hint: { ...bonk!.hint, config: of("raydium-launchlab")[0]!.hint.config } }]);
  assert.equal(other.get(bonk!.mint)?.pad, "raydium-launchlab", "Jupiter naming another platform: the family pad");
});

test("the pads a row can carry are the terminal's own ids: every Solana pad, family or kept, is in its pad table", () => {
  for (const p of APP_PADS) assert.ok(Object.hasOwn(PADS, p), `${p} is not in pads.ts`);
  for (const t of FX.tokens) if (t.origin) assert.ok(Object.hasOwn(PADS, t.origin.pad), t.origin.pad);
});

test("hostile accounts: wrong owner, discriminator, size or mint is no launch; two programs claiming one mint is no answer", async () => {
  const [ll] = of("raydium-launchlab");
  const pool = ll!.origin!.pool;
  assert.notEqual(launchlabOf(acct(pool), ll!.mint, null), null);
  assert.equal(launchlabOf(tweak(pool, () => {}, PUMP_PROGRAM), ll!.mint, null), null, "owner");
  assert.equal(launchlabOf(tweak(pool, (d) => (d[0] = d[0]! ^ 1)), ll!.mint, null), null, "discriminator");
  assert.equal(launchlabOf({ ...acct(pool), data: [Buffer.from(acct(pool).data[0], "base64").subarray(0, 428).toString("base64"), "base64"] }, ll!.mint, null), null, "size");
  assert.equal(launchlabOf(acct(pool), of("stonkfun")[0]!.mint, null), null, "another mint");
  assert.equal(launchlabOf(tweak(pool, (d) => (d[17] = 3)), ll!.mint, null), null, "status");
  const [db] = of("met-dbc");
  const dp = db!.origin!.pool;
  assert.notEqual(dbcOf(acct(dp), db!.mint, db!.origin!.config!), null);
  assert.equal(dbcOf(acct(dp), db!.mint, LAUNCHLAB_PROGRAM), null, "another config");
  assert.equal(dbcOf(tweak(dp, () => {}, LAUNCHLAB_PROGRAM), db!.mint, db!.origin!.config!), null, "owner");
  assert.equal(dbcOf(tweak(dp, (d) => (d[305] = 2)), db!.mint, db!.origin!.config!), null, "migrated flag");
  const [pf] = of("pump.fun on its curve");
  const curve = pumpCurveAddress(pf!.mint);
  assert.equal(pumpOf(tweak(curve, () => {}, DBC_PROGRAM)), undefined);
  assert.equal(pumpOf(tweak(curve, (d) => (d[1] = d[1]! ^ 1))), undefined);
  for (const bad of [null, undefined, 7, "x", [], { owner: PUMP_PROGRAM }, { owner: PUMP_PROGRAM, data: ["AA==", "base58"] }]) {
    assert.equal(pumpOf(bad), undefined);
    assert.equal(launchlabOf(bad, ll!.mint, null), null);
    assert.equal(dbcOf(bad, db!.mint, LAUNCHLAB_PROGRAM), null);
    assert.equal(dbcConfigOf(bad), null);
  }
  // a pump.fun curve and a LaunchLab pool both answering for one mint: no answer, never a pick
  const twice: GetAccounts = async (keys) => keys.map((k) => (k === pumpCurveAddress(ll!.mint) ? acct(curve) : FX.accounts[k] ?? null));
  assert.equal((await readOrigins(twice, [{ mint: ll!.mint, hint: ll!.hint }])).get(ll!.mint), null);
});

test("a failed or short read settles nothing: the token is read again later, never called untagged", async () => {
  const t = FX.tokens.slice(0, 3);
  for (const get of [async () => undefined, async (k: readonly string[]) => k.slice(1).map(() => null)] as GetAccounts[]) {
    assert.equal((await readOrigins(get, asks(t))).size, 0);
  }
  // the second round failing keeps every token that needs it unsettled
  const [db] = of("met-dbc");
  let n = 0;
  const firstOnly: GetAccounts = async (keys) => (n++ === 0 ? recorded()(keys) : undefined);
  assert.equal((await readOrigins(firstOnly, asks([db!]))).has(db!.mint), false);
});

test("the cache: a launch is read once; a token on its curve has its pool read again each refresh; a new token with no launch is read again", async () => {
  const calls: string[][] = [];
  const o = createOrigins(recorded(calls));
  const [onCurve] = of("pump.fun on its curve");
  const [grad] = of("pump.fun graduated");
  const [none] = of("untagged, no launchpad");
  const nowS = AT / 1000;
  const list = [
    { mint: onCurve!.mint, hint: onCurve!.hint, createdS: nowS - 3_600 },
    { mint: grad!.mint, hint: grad!.hint, createdS: nowS - 3_600 },
    { mint: none!.mint, hint: none!.hint, createdS: nowS - 10 },
  ];
  await o.refresh(list, AT);
  assert.equal(o.get(onCurve!.mint)?.curveBps, onCurve!.origin!.curveBps);
  assert.equal(o.get(grad!.mint)?.curveBps, 10_000);
  assert.equal(o.get(none!.mint), undefined, `made under ${SETTLE_S} s ago with no launch: read again`);
  calls.length = 0;
  await o.refresh(list, AT + 12_000);
  const asked = calls.flat();
  assert.ok(asked.includes(onCurve!.origin!.pool), "the curve read again");
  assert.ok(!asked.includes(grad!.origin!.pool), "a graduated launch is not read again");
  assert.ok(asked.includes(firstKeys(none!.mint, none!.hint)[0]!), "the young token's launch read again");
  await o.refresh(list.map((a) => (a.mint === none!.mint ? { ...a, createdS: nowS - 3_600 } : a)), AT + 24_000);
  assert.equal(o.get(none!.mint), null, "old enough: no launch is settled as none");
});

test("the cache reads at most ORIGIN_ASKS_PER_TICK new tokens a refresh", async () => {
  const calls: string[][] = [];
  const o = createOrigins(async (keys) => (calls.push([...keys]), keys.map(() => null)));
  const many = Array.from({ length: ORIGIN_ASKS_PER_TICK + 5 }, (_, i) => ({ mint: pda([Buffer.from(`m${i}`)], WSOL), hint: undefined, createdS: 0 }));
  await o.refresh(many, AT);
  assert.equal(calls.flat().length, ORIGIN_ASKS_PER_TICK * 3);
  assert.equal(many.filter((m) => o.get(m.mint) === undefined).length, 5);
});

test("progress: a fresh read of a known pool moves its curve; a read that is not that pool keeps the last", () => {
  const [ll] = of("raydium-launchlab");
  const o = ll!.origin!;
  const moved = tweak(o.pool, (d) => d.writeBigUInt64LE(d.readBigUInt64LE(29) / 2n, 53));
  assert.equal(progressOf(o, ll!.mint, moved, null)?.curveBps, 5_000);
  assert.equal(progressOf(o, ll!.mint, null, null), null);
  assert.equal(progressOf(o, of("stonkfun")[0]!.mint, acct(o.pool), null), null);
});

test("hints: Jupiter's launchpad, partnerConfig and graduatedPool, each checked as an id", () => {
  const h = hintsOf([{ id: "So11111111111111111111111111111111111111112", launchpad: "pump.fun", partnerConfig: "not an address", graduatedPool: WSOL }, { id: "x" }, { id: USD1, launchpad: "a b" }]);
  assert.deepEqual(h.get(WSOL), { tag: "pump.fun", config: null, graduated: WSOL });
  assert.deepEqual(h.get(USD1), { tag: null, config: null, graduated: null });
  assert.equal(h.size, 2);
  assert.equal(hintsOf({ not: "a list" }).size, 0);
});
