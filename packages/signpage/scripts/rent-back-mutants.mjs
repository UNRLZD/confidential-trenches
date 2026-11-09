// node packages/signpage/scripts/rent-back-mutants.mjs (card sol-w-sweep, delta reviews 5 and 6 of 38e59182 and 6 of
// 13898c19; card sol-rent-back-dust-burn): plants
// one mutant at a time in the signing page's rent back (src/pool-sell.ts) and the kit's teardown plan
// (packages/kit/src/checks/solana/checks.ts), runs the test that holds it, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SELL = `${W}/src/pool-sell.ts`;
const KIT = `${W}/../kit/src/checks/solana/checks.ts`;
const FLOW = `${W}/../kit/src/trade/solana/flow.ts`;
const BUY = `${W}/src/pool-buy.ts`;
const T = "test/pool-sell.test.ts";
const K = "../kit/test/solana-teardown-rules.test.ts";
const KF = "../kit/test/solana-flow.test.ts";
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
  // card sol-rent-back-dust-burn: what a stranger's balance is, and the burn the kit's plan and check allow. Left out as
  // equivalent: the mixed read's throw (an "ok" beside a "none", "failed" or "other" read leaves a meta that is not one
  // or reads a different balance, so the alike-meta throw below it refuses it the same), and the burn count's "at
  // least once" (FRAME takes a burn only right before its account's close, which runs once, so no account burns twice)
  // D1 inverted by the review of bf467ae7, F1: a full sell never leaves W's own units, so a balance it left is a
  // stranger's; holding it as W's own stranded W for good (a hostile RPC front-running 1 unit)
  ["D1 a balance a full sell left held as W's own", SELL, T, 'what W\'s account held after it");\n      return "yes";', 'what W\'s account held after it");\n      if (a !== 0n) return "no";\n      return "yes";'],
  ["D2 the RPCs' metas may differ", SELL, T, "if (a === null || b === null || a !== b) throw", "if (a === null || b === null) throw"],
  ["D3 a meta that does not say it taken", SELL, T, "if (a === null || b === null || a !== b) throw", "if (a !== b) throw"],
  ["D4 a sell not read yet taken as sold", SELL, T, '? "no" : "unsure";', '? "no" : "yes";'],
  ["D5 an unsure read stored as W's own state", SELL, T, 'steady: sold === "no" }', "steady: true }"],
  ["D6 a failed sell taken as sold", SELL, T, 'if (got.every((g) => g.got === "failed")) return "no";', 'if (got.every((g) => g.got === "failed")) return "yes";'],
  ["D7 a sell past its blockhash taken as sold", SELL, T, "(await goneOnBoth(rpcs, base58.encode(signed.subarray(1, 65)), by.last)) ? \"no\" : \"unsure\"", "(await goneOnBoth(rpcs, base58.encode(signed.subarray(1, 65)), by.last)) ? \"yes\" : \"unsure\""],
  // D8 (soldOne's own `by === undefined` taken as sold) is left out as equivalent since the review of bf467ae7's F5:
  // readW asks soldOne only of a mint with a recorded sell; D8b holds a held mint with none
  ["D8b a held mint with no sell read taken as sold", SELL, T, 'sells.get(t.mint) ?? "no"', 'sells.get(t.mint) ?? "yes"'],
  ["D9 the burn list dropped", SELL, T, "const burn = holding.map((t) => t.ata);", "const burn: string[] = [];"],
  ["D10 the sell not recorded", SELL, T, "      owedRec.sell = { ...prior?.sell, [token]: { tx: base64.encode(signed), last: bh.lastHeight } };\n", ""],
  ["D11 a load passes no sell on", SELL, T, "mints: o.mints, wait, ...(o.sell ? { sell: o.sell } : {}) }", "mints: o.mints, wait }"],
  // the review of bf467ae7's named ones: X2 (F3), Y2, Y3, Y4, Y7 (F4), its read order and commitment (F5), and the
  // armed path's burn list (F6); and a sell read's fault counted for a mint W no longer holds
  ["review X2 a burn's next close of another account", KIT, K, " && next.data[0] === 9 && next.accounts[0]?.key === h?.address;\n          if (!h || h.kind !== \"token\" || h.burn", " && next.data[0] === 9;\n          if (!h || h.kind !== \"token\" || h.burn"],
  ["review Y2 leftAfter counts another owner's account", SELL, T, "if (b.mint !== mint || b.owner !== owner) continue;", "if (b.mint !== mint) continue;"],
  ["review Y3 leftAfter counts another mint's account", SELL, T, "if (b.mint !== mint || b.owner !== owner) continue;", "if (b.owner !== owner) continue;"],
  ["review Y4 a list with no W entry read as 0", SELL, T, "    total = (total ?? 0n) + BigInt(amount);\n  }\n  return total;", "    total = (total ?? 0n) + BigInt(amount);\n  }\n  return total ?? 0n;"],
  ["review Y7 another mint's sell used", SELL, T, "const by = x.sell?.[m];", "const by = Object.values(x.sell ?? {})[0];"],
  ["review F5a the sell read at confirmed", SELL, T, 'signed, "finalized"));', "signed));"],
  ["review F5b the sell read after W's accounts", SELL, T, [["      for (const m of x.mints) if (x.sell?.[m.mint] !== undefined) sells.set(m.mint, await soldOne(m.mint).catch((e: unknown) => ({ fault: e })));\n      const held = await both(rpcs, (r) => accountsOf(r, [w.address, ...addresses]));\n", "      const held = await both(rpcs, (r) => accountsOf(r, [w.address, ...addresses]));\n      for (const m of x.mints) if (x.sell?.[m.mint] !== undefined) sells.set(m.mint, await soldOne(m.mint).catch((e: unknown) => ({ fault: e })));\n"]]],
  ["review F5c a sell read's fault for a mint W no longer holds", SELL, T, "await soldOne(m.mint).catch((e: unknown) => ({ fault: e }))", "await soldOne(m.mint)"],
  ["review F6 the armed path passes a burn list", FLOW, KF, "    plan = solanaTeardownPlan(w, accounts);", "    plan = solanaTeardownPlan(w, accounts, undefined, addresses);"],
  ["K1 a Token-2022 extension burned", KIT, K, "burn.includes(address) && other === undefined &&", "burn.includes(address) &&"],
  ["K2 the burn's amount unchecked", KIT, K, "|| u64(d, 1) !== h.burn ", ""],
  ["K3 the burn's mint unchecked", KIT, K, "|| a[1]?.key !== h.mint ", ""],
  ["K4 a burn anywhere in the frame", KIT, K, "|| !a[1]?.writable || !nextCloses)", "|| !a[1]?.writable)"],
  ["K6 a claim's destination burned", KIT, K, " && ![...cash.values()].some((c) => c.to === address);", ";"],
  ["K7 a native account burned", KIT, K, "const burns = !native && amount", "const burns = amount"],
  ["K8 the burn's signer unchecked", KIT, K, "|| a[2]?.key !== wallet || !a[2]?.signer ", ""],
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
  ["review 6 N24-sell-back-ifAvailable", SELL, T, "const back: NonNullable<typeof later.back> = (locks) => withHolds(locks, w.address, false, wait,", "const back: NonNullable<typeof later.back> = (locks) => withHolds(locks, w.address, true, wait,"],
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
  // card sol-sell-deposit-back-floor: the deposit back under the kit's release floor is never built; the sale stays on W
  ["floor F1 a deposit back under the floor built", SELL, T, "return { reserve, value: p.minOut - reserve < p.noteFloor ? 0n : p.minOut - reserve };", "return { reserve, value: p.minOut - reserve };"],
  ["floor F2 no floor taken", SELL, T, '  if (typeof p.noteFloor !== "bigint" || p.noteFloor < SOLANA_POOL_MIN_DEPOSIT) return { refused: "quote_check_failed" };\n', ""],
  ["floor F3 the pool's least deposit for the floor", SELL, T, "const noteFloor = solanaPoolNoteFloor(rent);", "const noteFloor = SOLANA_POOL_MIN_DEPOSIT;"],
  ["floor F4 an eight under the floor kept, never the six", SELL, T, '      if (next && r.value === 0n) return no("quote_check_failed");\n', ""],
  ["floor F5 a value of 0 built as a deposit", SELL, T, "value === 0n ? steps : [...steps, depositIx(", "false ? steps : [...steps, depositIx("],
  ["floor F6 one RPC's read of the sell filled", SELL, T, "if (got[0].got === \"ok\" && got[1].got === \"ok\") return \"filled\";", "if (got[0].got === \"ok\" || got[1].got === \"ok\") return \"filled\";"],
  ["floor F7 one RPC's silence not_landed", SELL, T, "if (got[0].got === \"none\" && got[1].got === \"none\" && (await goneOnBoth(", "if ((got[0].got === \"none\" || got[1].got === \"none\") && (await goneOnBoth("],
  ["floor F10 not_landed before both are past", SELL, T, "const at = await pastAt(rpcs, last);", "const at = [0, 0] as const;"],
  ["floor F8 a full sell kept on W runs no rent back", SELL, T, "        if (v === \"filled\" && !keeps) later.back = back;\n", ""],
  ["floor F9 a sell kept on W writes a note", SELL, T, "const note = kept ? null : await store.move(", "const note = false ? null : await store.move("],
  // review of b38cd8c2: F1 a read that throws is no RPC's word; F3 none only at a slot each RPC is past at; F4 the kept
  // sell's record before the send, settled on load, dropped at its verdict
  ["review F1 a throwing read taken as none on both", SELL, T, "const got = await both(rpcs, (r) => readBackFailure(r, k.signature, signed)).catch(() => null);", "const got = await both(rpcs, (r) => readBackFailure(r, k.signature, signed)).catch((): { got: \"none\" }[] => [{ got: \"none\" }, { got: \"none\" }]);"],
  ["review F3 a status at any slot", SELL, T, "return int(s?.context?.slot) >= at[i]! &&", "return true &&"],
  ["review F3 no status read for the sell's none", SELL, T, "if (got[0].got === \"none\" && got[1].got === \"none\" && (await goneOnBoth(rpcs, k.signature, k.last))) return \"not_landed\";", "if (got[0].got === \"none\" && got[1].got === \"none\" && (await pastOnBoth(rpcs, k.last))) return \"not_landed\";"],
  ["review F3 no status read for a recorded sell's none", SELL, T, "goneOnBoth(rpcs, base58.encode(signed.subarray(1, 65)), by.last)", "pastOnBoth(rpcs, by.last)"],
  ["review F4 no record before the send", SELL, T, "    if (kept) await h.kept?.put(", "    if (false) await h.kept?.put("],
  ["review F4 not settled on load", SELL, T, "const v = await keptVerdict(h.rpcs, k).catch(() => \"pending\" as const);", "const v = \"pending\" as const;"],
  ["review F4 the record kept after its verdict", SELL, T, "        await h.kept?.drop(signature).catch(() => {});\n", ""],
  // review of fcd67b72: P1 the load settles a kept sell with no note; P2 the kept record before the request's record
  ["review P1 the load settles sells only on a note", TESTNET, TT, " || (await keptSells(page.store).list().catch(() => [])).length > 0) await settleSells();", ") await settleSells();"],
  ["review P2 the kept record after the request's record", SELL, T, [["    if (kept) await h.kept?.put({ signature, tx: base64.encode(signed), last: bh.lastHeight });\n", ""], ["    await h.signed?.(signature);\n", "    await h.signed?.(signature);\n    if (kept) await h.kept?.put({ signature, tx: base64.encode(signed), last: bh.lastHeight });\n"]]],
  // review of 5de2165e: P3-2 the state read's kept list read unguarded (one that always fails ends the read early)
  ["review P3-2 the kept list read unguarded", TESTNET, TT, "(await keptSells(page.store).list().catch(() => [])).length > 0", "(await keptSells(page.store).list()).length > 0"],
];
// ONLY=<text>: run just the mutants whose name holds it (a fix's own red/green), the rest skipped
const only = process.env.ONLY;
// <k>/<n>: part k of n only, mutant i in part (i % n) + 1, as the helper's sweeps split (apps/helper/test/pool-evm/
// mutant-sweep.mjs partOf); test:mutants runs the parts, one command each, so ci.yml's split shares them out
const arg = process.argv.slice(2);
const part = /^(\d+)\/(\d+)$/.exec(arg[0] ?? "");
if (arg.length > 1 || (arg.length === 1 && (!part || Number(part[1]) < 1 || Number(part[1]) > Number(part[2])))) {
  console.log(`FAIL the part is <k>/<n> with 1 <= k <= n, one at most, not ${JSON.stringify(arg)}`);
  process.exit(1);
}
const inPart = (i) => !part || i % Number(part[2]) === Number(part[1]) - 1;
const run = (only ? M.filter(([name]) => name.includes(only)) : M).filter((_, i) => inPart(i));
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
