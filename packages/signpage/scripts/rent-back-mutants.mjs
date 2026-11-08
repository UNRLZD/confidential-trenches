// node packages/signpage/scripts/rent-back-mutants.mjs (card sol-w-sweep, delta reviews 5 and 6 of 38e59182; card
// sol-rent-back-dust-burn): plants
// one mutant at a time in the signing page's rent back (src/pool-sell.ts) and the kit's teardown plan
// (packages/kit/src/checks/solana/checks.ts), runs the test that holds it, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SELL = `${W}/src/pool-sell.ts`;
const KIT = `${W}/../kit/src/checks/solana/checks.ts`;
const T = "test/pool-sell.test.ts";
const K = "../kit/test/solana-teardown-rules.test.ts";
// [name, file, the test that kills it, from, to]; from an array of [from, to] pairs plants each one (a rule held twice,
// as what W read as is: the pass's end names it W's own state, and the record keeps it only on those ends)
const M = [
  ["A10 a sweep priced on one RPC's lamports of W", SELL, T, '      if (a !== b) throw new Error("W\'s lamports differ on the two RPCs");\n', ""],
  ["B2 the helper's tokens left out of what W read as", SELL, T, "`${a}#${tokens}#", "`${a}##"],
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
  ["D1 a balance the sell left taken as a stranger's", SELL, T, '        if (a !== 0n) return "no";\n', ""],
  ["D2 the RPCs' metas may differ", SELL, T, "if (a === null || b === null || a !== b) throw", "if (a === null || b === null) throw"],
  ["D3 a meta that does not say it taken", SELL, T, "if (a === null || b === null || a !== b) throw", "if (a !== b) throw"],
  ["D4 a sell not read yet taken as sold", SELL, T, "          unsure = true;\n          continue;", "          continue;"],
  ["D5 an unsure read stored as W's own state", SELL, T, 'steady: sold === "no" }', "steady: true }"],
  ["D6 a failed sell taken as sold", SELL, T, 'if (got.every((g) => g.got === "failed")) return "no";', 'if (got.every((g) => g.got === "failed")) return "yes";'],
  ["D7 a sell past its blockhash taken as sold", SELL, T, 'if (await pastOnBoth(rpcs, by.last)) return "no";', 'if (await pastOnBoth(rpcs, by.last)) return "yes";'],
  ["D8 no record of the sell taken as sold", SELL, T, 'if (by === undefined) return "no";', "if (by === undefined) continue;"],
  ["D9 the burn list dropped", SELL, T, "const burn = holding.map((t) => t.ata);", "const burn: string[] = [];"],
  ["D10 the sell not recorded", SELL, T, "      owedRec.sell = { ...prior?.sell, [token]: { tx: base64.encode(signed), last: bh.lastHeight } };\n", ""],
  ["D11 a load passes no sell on", SELL, T, "mints: o.mints, wait, ...(o.sell ? { sell: o.sell } : {}) }", "mints: o.mints, wait }"],
  ["K1 a Token-2022 extension burned", KIT, K, "burn.includes(address) && other === undefined &&", "burn.includes(address) &&"],
  ["K2 the burn's amount unchecked", KIT, K, "|| u64(d, 1) !== h.burn ", ""],
  ["K3 the burn's mint unchecked", KIT, K, "|| a[1]?.key !== h.mint ", ""],
  ["K4 a burn anywhere in the frame", KIT, K, "|| !a[1]?.writable || !nextCloses)", "|| !a[1]?.writable)"],
  ["K6 a claim's destination burned", KIT, K, " && ![...cash.values()].some((c) => c.to === address);", ";"],
  ["K7 a native account burned", KIT, K, "const burns = !native && amount", "const burns = amount"],
  ["K8 the burn's signer unchecked", KIT, K, "|| a[2]?.key !== wallet || !a[2]?.signer ", ""],
];
let killed = 0;
for (const [name, file, test, from, to] of M) {
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
console.log(`${killed}/${M.length} killed`);
if (killed !== M.length) process.exitCode = 1;
