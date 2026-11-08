// node packages/signpage/scripts/rent-back-mutants.mjs (card sol-w-sweep, delta reviews 5 and 6 of 38e59182 and 6 of 13898c19): plants
// one mutant at a time in the signing page's rent back (src/pool-sell.ts) and the kit's teardown plan
// (packages/kit/src/checks/solana/checks.ts), runs the test that holds it, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SELL = `${W}/src/pool-sell.ts`;
const KIT = `${W}/../kit/src/checks/solana/checks.ts`;
const BUY = `${W}/src/pool-buy.ts`;
const T = "test/pool-sell.test.ts";
const KC = "../kit/test/solana-teardown-cashback.test.ts";
const TB = "test/pool-buy.test.ts";
const TESTNET = `${W}/src/pool-testnet.ts`;
const TT = "test/pool-testnet.test.ts";
// [name, file, the test that kills it, from, to]; from an array of [from, to] pairs plants each one (a rule held twice,
// as what W read as is: the pass's end names it W's own state, and the record keeps it only on those ends)
const M = [
  ["A10 a sweep priced on one RPC's lamports of W", SELL, T, '      if (a !== b) throw new Error("W\'s lamports differ on the two RPCs");\n', ""],
  ["B4 the accounts' data left out of what W read as", SELL, T, "`${t.owner}:${t.lamports}:${base64.encode(t.data)}`", "`${t.owner}:${t.lamports}`"],
  ["B7 what W read as kept on a pass that gave up", SELL, T, [['steady = e === "holds" || e === "kept" || e === "refused"', 'steady = e === "holds" || e === "kept" || e === "refused" || e === "gave_up"'], ['(e === "floor" || e === "holds" || e === "kept" || e === "refused")' , '(e === "floor" || e === "holds" || e === "kept" || e === "refused" || e === "gave_up")']]],
  ["B8 what W read as kept on a sweep sent", SELL, T, [['steady = e === "holds" || e === "kept" || e === "refused"', 'steady = e === "holds" || e === "kept" || e === "refused" || e === "sent"'], ['(e === "floor" || e === "holds" || e === "kept" || e === "refused")', '(e === "floor" || e === "holds" || e === "kept" || e === "refused" || e === "sent")']]],
  ["C1 the load's record used, not read again inside the lock", SELL, T, "      const o = (await h.owed!.list()).find((r) => r.address === address);\n      const w = o &&", "      const o = owed.find((r) => r.address === address);\n      const w = o &&"],
  ["M1 a System account with no data at W's address planned as an account", KIT, T, "(x !== null && x.owner === SOLANA_SYSTEM_PROGRAM && x.data.length === 0 ? null : x)", "x"],
  ["M1 a plan refusal on alike reads read again as a fault", SELL, T, 'if (held[0].every((t, i) => sameRead(t, held[1][i] ?? null))) return { k: "refused" as const, why: faultOf(e) };', ""],
  ["M1 a plan refusal ends the pass on reads that differ", SELL, T, "if (held[0].every((t, i) => sameRead(t, held[1][i] ?? null)))", "if (true)"],
  ["M1 the sell lock held through a sleep", SELL, T, "        hold.release();\n        await wait(ms);\n        sell = await take(locks, POOL_SELL_LOCK, true);\n        return sell !== null;", "        await wait(ms);\n        return true;"],
  ["M1 a sell lock taken meanwhile ignored", SELL, T, "    if (!(await hold.nap(ms))) throw BUSY;", "    await hold.nap(ms);"],
  ["L2 a record written keeps its place in the list", SELL, T, "        delete all[r.address];\n", ""],
  ["L3 the rent left out of what W read as", SELL, T, "#${x.rent.lamportsPerByte}:${x.rent.factor}", ""],
  ["L3 a floor end always W's own state", SELL, T, "steady: cheapest < floor,", "steady: true,"],
  ["info the sell's record replaces the mints a prior one kept", SELL, T, "      owedRec.mints = mintsOf(prior?.mints, owedRec.mints);\n", ""],
  ["info a pass's end replaces the record's mints", SELL, T, "mints: mintsOf(now.mints, o.mints), ", ""],
  // delta review 6 of 13898c19's named ones (its runner's plants, byte for byte)
  ["review 6 N6b-sameRead-no-lamports", SELL, T, "a.owner === b.owner && a.lamports === b.lamports && a.data.length", "a.owner === b.owner && a.data.length"],
  // N8 (the again loop's `if (e === BUSY) throw e` taken out) is left out as equivalent: a try's body never sleeps, the
  // sleep before it is outside its try, so BUSY never reaches that catch
  ["review 6 N10-no-back-lock", SELL, T, "  const own = await take(locks, backLock(address), ifAvailable);\n  if (!own) return true;", "  const own = () => {};"],
  ["review 6 N10b-back-lock-busy-stops-list", SELL, T, "  if (!own) return true;", "  if (!own) return false;"],
  ["review 6 N12-seen-no-rules-version", SELL, T, "#${POOL_RENT_BACK_RULES}`", "`"],
  ["review 6 N16-owedAfter-no-reread", SELL, T, "    const now = (await h.owed?.list())?.find((r) => r.address === o.address) ?? o;", "    const now = o;"],
  ["review 6 N17-owedAfter-mints-not-merged", SELL, T, "mints: mintsOf(now.mints, o.mints), passes", "mints: now.mints, passes"],
  ["review 6 N18-zero-with-claim-dropped", SELL, T, "if (lamports === 0n) return { end: owed > 0 ? (\"owed\" as const) : (\"nothing\" as const)", "if (lamports === 0n) return { end: \"nothing\" as const"],
  ["review 6 N19-setup-fault-no-stop", SELL, T, "        await owedAfter(h, o, \"gave_up\");\n      });\n      if (!go) return;", "        await owedAfter(h, o, \"gave_up\");\n      });\n      void go;"],
  ["review 6 N20-setup-fault-unlocked", SELL, T, "      const go = await withHolds(locks, address, true, wait, async () => {\n        const o = (await h.owed!.list()).find((r) => r.address === address);\n        if (!o) return;", "      const go = await (async (f: () => Promise<void>) => (await f(), true))(async () => {\n        const o = (await h.owed!.list()).find((r) => r.address === address);\n        if (!o) return;"],
  ["review 6 N21-sweep-refused-gives-up", SELL, T, "      if (now.k === \"refused\") return { end: \"refused\" as const, detail: now.why };", "      if (now.k === \"refused\") return { end: \"gave_up\" as const, detail: now.why };"],
  ["review 6 N22-busy-detail-plain", SELL, T, "e === BUSY ? \"a sell took the sell lock between tries: W waits for the next load\" : faultOf(e)", "faultOf(e)"],
  ["review 6 N24-sell-back-ifAvailable", SELL, T, "later.back = (locks) => withHolds(locks, w.address, false, wait,", "later.back = (locks) => withHolds(locks, w.address, true, wait,"],
  // delta review 7 of 08290868's plants on the claim's prefund (F1)
  ["review 7 P7 a made account read as unmade", KIT, KC, "        if (toRead === null) {", "        if (true) {"],
  ["review 7 P9 the open's lamports bound without the prefund", KIT, KC, "lam - c.prefund > SOLANA_TOKEN_ACCOUNT_RENT_MAX) sim", "lam > SOLANA_TOKEN_ACCOUNT_RENT_MAX) sim"],
  // delta review 7 of 08290868, item 1: W's buy mint (the buy's record) holds the pass while W holds any of it
  ["review 7 A1 the buy record not read into the pass", SELL, T, "const x: RentBack = buy ? { ...given, mints: mintsOf(given.mints, [buy]), buy } : { ...given, buy: null };", "const x: RentBack = { ...given, buy: buy ? buy : null };"],
  ["review 7 A2 no buy record: the pass runs", SELL, T, '    if (!x.buy) return end("holds", "no buy of W\'s is recorded");\n', ""],
  ["review 7 A3 a buy record read as none", SELL, T, "const x: RentBack = buy ? { ...given, mints: mintsOf(given.mints, [buy]), buy } : { ...given, buy: null };", "const x: RentBack = { ...given, buy: null };"],
  ["review 7 A5 the buy writes no record", BUY, TB, "      await h.bought?.put(w.address, { mint: venue.mint, program: venue.tokenProgram });\n", ""],
  ["review 7 A6 the buy's record written after its send", BUY, TB, [["      await h.bought?.put(w.address, { mint: venue.mint, program: venue.tokenProgram });\n      return await sendAndSettle(h, r, release, pool, signed, bh.lastHeight, wait, { token, minOut, tell, bound });", "      try { return await sendAndSettle(h, r, release, pool, signed, bh.lastHeight, wait, { token, minOut, tell, bound }); } finally { await h.bought?.put(w.address, { mint: venue.mint, program: venue.tokenProgram }); }"]]],
  // delta review 8 of 5697d7a1: with no buy record the pass holds; the record through the page's store
  ["review 8 F1 no buy record: the page's holdings decide the pass", SELL, T, '    if (!x.buy) return end("holds", "no buy of W\'s is recorded");', '    if (!x.buy && [...w.holdings.tokens].some(([mint, t]) => !x.mints.some((m) => m.mint === mint) && t.amount > 0n)) return end("holds", "no buy of W\'s is recorded");'],
  ["review 8 C3 a buy record that cannot be read faults the pass", SELL, T, "const buy = await Promise.resolve(h.bought?.get(given.w.address)).catch(() => undefined);", "const buy = await h.bought?.get(given.w.address);"],
  ["review 8 C5 the buy host loses bought", TESTNET, TT, "      // W's buy mint, written before the send: the rent back after a later sell holds while W holds any of it\n      bought: buyMints(page.store),\n", ""],
  ["review 8 C6 the sell host loses bought", TESTNET, TT, "      owed: owedRentBacks(page.store),\n      bought: buyMints(page.store),\n", "      owed: owedRentBacks(page.store),\n"],
  ["review 8 C7 buyMints' get returns undefined", SELL, T, "return Object.hasOwn(all, address) ? all[address] : undefined;", "return undefined;"],
];
// ONLY=<text>: run just the mutants whose name holds it (a fix's own red/green), the rest skipped
const only = process.env.ONLY;
const run = only ? M.filter(([name]) => name.includes(only)) : M;
let killed = 0;
for (const [name, file, test, from, to] of run) {
  const src = readFileSync(file, "utf8");
  const pairs = Array.isArray(from) ? from : [[from, to]];
  const once = pairs.find(([f]) => src.split(f).length !== 2);
  if (once) {
    console.log(`NOT ONCE [${name}]: ${once[0]}`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(file, pairs.reduce((s, [f, t]) => s.replace(f, t), src));
  // a run past 180 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", "--test-timeout=20000", test], { cwd: W, encoding: "utf8", timeoutMs: 180_000 });
  } finally {
    writeFileSync(file, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const by = [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].slice(0, 70)).filter((v, i, a) => a.indexOf(v) === i);
  const dead = r.status !== 0 && Number(fail) > 0;
  if (dead) killed++;
  console.log(`${dead ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${by.length ? ` by: ${by.join(" | ")}` : ""}`);
  if (readFileSync(file, "utf8") !== src) {
    console.log("SOURCE NOT RESTORED");
    process.exitCode = 1;
  }
}
console.log(`${killed}/${run.length} killed`);
if (killed !== run.length || run.length === 0) process.exitCode = 1;
