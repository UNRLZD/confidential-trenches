// node packages/signpage/scripts/export-mutants.mjs (card signpage-backup-export): plants one mutant at a time in the
// export of one key (src/pages/export.ts, and its wiring in src/main.ts), one per rule, runs the test that holds that
// rule, expects it to fail, and puts the source back.
// No mutant drops show()'s own clear of the wallet and key (src/main.ts show, "off the export screen"): since the review's
// fix every way off the export (Done, the x, the scrim, Esc, pagehide) runs leaveScreen, which clears them at the tap
// (X14 drops that), and a sign out here or elsewhere reloads the page; show()'s clear is the same program on every
// reachable state, kept so a later way off cannot keep them. Its mutant (X9 before the review) survived for that reason.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { refused, runMutant, withPlant } from "../../../scripts/mutant-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const MAIN = `${W}/src/main.ts`;
const EXPORT = `${W}/src/pages/export.ts`;
const UNIT = "test/pages-export.test.ts";
const PAGE = "test/main-export.test.ts";
const LEAVE = "test/main-export-leave.test.ts";
const BUILD = `${W}/scripts/build-app.mjs`;
// [name, file, the test that kills it, from, to]
const M = [
  ["X1 a foreign Solana or NEAR address matches (the address compare dropped)", EXPORT, UNIT, ": derived === named;", ": true;"],
  ["X2 a foreign EVM address matches (the address compare dropped)", EXPORT, UNIT, "/^0x[0-9a-fA-F]{40}$/.test(named) && derived.toLowerCase() === named.toLowerCase()", "true"],
  ["X3 a U is looked for on a chain its record is not of", EXPORT, UNIT, "  if (r.chain !== chain) return null;\n", ""],
  ["X4 a chain outside the four is taken", EXPORT, UNIT, 'typeof chain === "string" && Object.hasOwn(TAGS, chain)', 'typeof chain === "string"'],
  ["X5 the Solana key's halves swapped (not Phantom's form)", EXPORT, UNIT, "full.set(secretKey, 0);\n      full.set(publicKey, 32);", "full.set(publicKey, 0);\n      full.set(secretKey, 32);"],
  ["X6 the NEAR key with no ed25519: prefix (not NEAR's form)", EXPORT, UNIT, "`ed25519:${base58.encode(full)}`", "base58.encode(full)"],
  ["X7 the ownership check skipped before the answer", MAIN, PAGE, "answer: () => (owned ? decide(", "answer: () => (true ? decide("],
  ["X8 Show unguarded: a lined-up click draws the key", MAIN, PAGE, '"backup", "show", "copy",', '"backup", "copy",'],
  ["X10 the export's Copy leaves the clipboard holding the key after Done", MAIN, PAGE, "          copied = true;\n          void navigator.clipboard?.writeText(key)", "          void navigator.clipboard?.writeText(key)"],
  [
    "X11 the key sent to APP_HOST in the answer",
    MAIN,
    PAGE,
    "  let owned = false;\n  const after = (async () => {\n    await resynced();\n    owned = await ownsNow(chain, address);\n  })();\n  return { after, answer: () => (owned ? decide(id, \"export.open\", undefined, undefined, undefined, { chain, address }) : null) };",
    "  let owned = false;\n  let leaked = \"\";\n  const after = (async () => {\n    await resynced();\n    owned = await ownsNow(chain, address);\n    const seed = await openSeed64();\n    leaked = exportKey(seed, chain, address, await exportRefsNow()) ?? \"\";\n  })();\n  return { after, answer: () => { const a = owned ? decide(id, \"export.open\", undefined, undefined, undefined, { chain, address }) : null; return a && { ...a, result: { ...a.result, key: leaked } as typeof a.result }; } };",
  ],
  // the review's fixes (each with its test in test/main-export-leave.test.ts, test/pages-export.test.ts or scripts/build-app.test.mjs)
  ["X12 the key derived at the open and kept until Show", MAIN, LEAVE, "          exportTarget = target;\n          show(\"export\");", "          exportTarget = target;\n          void exportRefsNow().then(async (r) => { const s = await openSeed64(); try { exportKey(s, target.chain, target.address, r); } finally { s.fill(0); } });\n          show(\"export\");"],
  ["X13 a leave tapped during Show is dropped (run's busy)", MAIN, LEAVE, "  if (busy) return void (leaveAfter = true);", "  if (busy) return;"],
  ["X14 a leave during Show keeps the wallet: Show draws the key before the page goes back", MAIN, LEAVE, "function leaveScreen(): void {\n  exportTarget = null;\n  exportShown = null;\n", "function leaveScreen(): void {\n"],
  ["X15 pagehide leaves what the screen drew in the page", MAIN, LEAVE, "  if (st !== \"export\" && st !== \"backup\") return;\n  root.replaceChildren();\n", "  if (st !== \"export\" && st !== \"backup\") return;\n"],
  ["X16 the drawn key offered to page translation", MAIN, LEAVE, "        k.className = \"notranslate\";\n", ""],
  ["X17 the 12 words offered to page translation", MAIN, LEAVE, "        list.className = \"notranslate\";\n", ""],
  ["X18 the page's root offered to page translation", BUILD, "scripts/build-app.test.mjs", '<html lang="en" translate="no">', '<html lang="en">'],
  ["X19 one record no derivation takes ends the lookup", EXPORT, UNIT, "    try {\n      const m = matchOne(seed64, chain, address, r);\n      if (m !== null) return m;\n    } catch {\n      // no key at this ref: the next one\n    }\n", "    const m = matchOne(seed64, chain, address, r);\n    if (m !== null) return m;\n"],
  ["X20 a record's own word for its U taken (its derivation not compared)", EXPORT, LEAVE, "    if (base58.encode(k.publicKey) === address) return", "    if (base58.encode(k.publicKey) === address || true) return"],
];
let killed = 0;
for (const [name, file, test, from, to] of M) {
  const src = readFileSync(file, "utf8");
  if (src.split(from).length !== 2) {
    console.log(`NOT ONCE [${name}]: ${from}`);
    process.exitCode = 1;
    continue;
  }
  // a run past 180 s is killed, its process group with it; a run with no verdict is refused (scripts/mutant-run.mjs)
  const r = withPlant(file, src.replace(from, to), () => runMutant([test], { cwd: W, timeoutMs: 180_000 }));
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
