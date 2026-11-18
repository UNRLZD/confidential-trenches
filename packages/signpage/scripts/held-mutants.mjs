// node packages/signpage/scripts/held-mutants.mjs (card held-deposit-way-out, delta review of the fold D2 and D5): plants
// one mutant at a time in the signing page's held move (src/main.ts heldULock, heldDeps and settleHeld, src/withdraw/held.ts move),
// runs the test that holds it, expects it to fail, puts the source back. The wallet's own sweep of moveout.ts is
// packages/wallet/scripts/held-moveout-mutants.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { refused, runMutant, withPlant } from "../../../scripts/mutant-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const MAIN = `${W}/src/main.ts`;
const HELD = `${W}/src/withdraw/held.ts`;
// [name, file, the test that kills it, from, to]
const M = [
  ["MM1 U's lock named without the network (not the deposit follow's lock)", MAIN, "test/held-lock.test.ts", "`${FOLLOW_LOCK}${PAGE_NETWORK}/${u}`", "`${FOLLOW_LOCK}${u}`"],
  ["MM2 U's lock waited for (no ifAvailable)", MAIN, "test/held-lock.test.ts", '{ mode: "exclusive", ifAvailable: true }', '{ mode: "exclusive" }'],
  ["MM3 the tap's move takes no lock of U", MAIN, "test/held-lock.test.ts", "seedLock: heldSeedLock, uLock: heldULock(u) });", "seedLock: heldSeedLock });"],
  ["MM4 the sign-in's resume skips a moved op (a later deposit in its U stays behind Moved)", MAIN, "test/held-main.test.ts", "op.follow?.out !== undefined && op.follow.network === PAGE_NETWORK)", "op.follow?.out !== undefined && op.follow.why !== \"moved_out\" && op.follow.network === PAGE_NETWORK)"],
  ["MM5 the sign-in's resume hands no archival list (a forgotten landed move never settles)", MAIN, "test/held-main.test.ts", "await moveOutHeld(k, null, { ops, rpcs: heldRpcs(), archival: heldArchival(),", "await moveOutHeld(k, null, { ops, rpcs: heldRpcs(), archival: [],"],
  ["MM6 the page's archival hosts asked once (moveOutRpc, no ask again after a throttle: review 3 F4)", MAIN, "test/held-main.test.ts", "archival.map((u) => archivalRpc(u));", "archival.map((u) => moveOutRpc(u));"],
  ["H2x a fixed account's tap skips the account re-check (D5)", HELD, "test/held-move-out.test.ts", '      const c = await checkRecipient(to, deps.network, deps.rpcs).catch(() => ({ ok: false, code: "unread" }) as const);\n      if (!c.ok || c.recipient !== to) return refuse(c.ok ? null : c.code);\n', ""],
];
let killed = 0;
for (const [name, file, test, from, to] of M) {
  const src = readFileSync(file, "utf8");
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: ${from}`);
    process.exitCode = 1;
    continue;
  }
  // a run past 120 s is killed, its process group with it; a run with no verdict is refused (scripts/mutant-run.mjs)
  const r = withPlant(file, src.replace(from, to), () => runMutant([test], { cwd: W, timeoutMs: 120_000 }));
  if (!refused(name, r)) {
    const by = [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].slice(0, 70)).filter((v, i, a) => a.indexOf(v) === i);
    const dead = r.verdict === "killed";
    if (dead) killed++;
    console.log(`${dead ? "KILLED" : "SURVIVED"} [${name}] pass ${r.pass} fail ${r.fail}${by.length ? ` by: ${by.join(" | ")}` : ""}`);
  }
  if (readFileSync(file, "utf8") !== src) {
    console.log("SOURCE NOT RESTORED");
    process.exitCode = 1;
  }
}
console.log(`${killed}/${M.length} killed`);
if (killed !== M.length) process.exitCode = 1;
