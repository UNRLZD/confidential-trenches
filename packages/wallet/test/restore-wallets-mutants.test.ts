// The restore sweep (scripts/restore-wallets-mutants.mjs) reads a run with no verdict as a refusal, never a survivor
// (card restore-sweep-world-tests-exit-alone). A restore test run alone by name never exited (its store's
// BroadcastChannel stayed open), the sweep killed it at its cap and printed "SURVIVED ... pass undefined fail undefined".
// Here the sweep runs as written, on a copy of its tree in a temp dir, so no plant ever touches this checkout: its first
// plant's source is a stub holding the plant's text once, and that plant's test file is planted.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error: a plain .mjs script, no types
import { runSync } from "../../../scripts/group-run.mjs";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PLANT = "S-01 review: the same-chain deposit builds at a rent of 0, not the rent read";
const STUB = "export const x = (a) => ({ ...build(a.sizes, a.blockhash, a.rent) };\n";

/** The sweep's run of PLANT against a planted test file, its run bounded to `boundMs` by the run it is inside. */
function sweep(body: string, boundMs: number): { status: number | null; out: string; putBack: boolean } {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-sweep-"));
  try {
    const at = (p: string) => (mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }), path.join(dir, p));
    for (const f of ["scripts/group-run.mjs", "packages/wallet/scripts/restore-wallets-mutants.mjs", "scripts/mutant-run.mjs"]) copyFileSync(path.join(ROOT, f), at(f));
    writeFileSync(at("package.json"), '{ "type": "module" }\n');
    writeFileSync(at("packages/wallet/src/pool/same-chain.ts"), STUB);
    writeFileSync(at("packages/wallet/test/pool-same-chain.test.ts"), `import { test } from "node:test";\ntest("S-01 review: planted", async () => {\n  ${body}\n});\n`);
    // a run started from inside node --test reports to its parent and prints no summary: the sweep runs as its own
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
    // the sweep inside a run that ends in boundMs (scripts/group-run.mjs): its test run's cap is cut to that end
    const sweep = pathToFileURL(at("packages/wallet/scripts/restore-wallets-mutants.mjs")).href;
    const code = `process.env.GROUP_RUN_UNTIL_MS = String(Date.now() + ${boundMs}); await import(${JSON.stringify(sweep)});`;
    const r = runSync(process.execPath, ["--input-type=module", "-e", code, "sweep", PLANT], { encoding: "utf8", env, timeoutMs: 60_000 }) as { status: number | null; stdout: string; stderr: string };
    return { status: r.status, out: `${r.stdout}${r.stderr}`, putBack: readFileSync(at("packages/wallet/src/pool/same-chain.ts"), "utf8") === STUB };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("restore sweep: a run that hangs past its cap is refused with no verdict, never read as a survivor; its plant is put back", { timeout: 60_000 }, () => {
  // the test never ends and holds the event loop: the run is killed at its bound with no summary
  const r = sweep("setInterval(() => {}, 1_000);\n  await new Promise(() => {});", 4_000);
  assert.doesNotMatch(r.out, /SURVIVED/, r.out);
  assert.doesNotMatch(r.out, /undefined/, r.out);
  assert.match(r.out, new RegExp(`^HUNG \\[${PLANT}\\].*no verdict, refused$`, "m"), r.out);
  assert.match(r.out, /^0\/1 killed; 1 with no verdict, refused$/m, r.out);
  assert.notEqual(r.status, 0, r.out);
  assert.ok(r.putBack, "the plant is put back");
});

test("restore sweep: a run whose test fails is read as killed; a run whose test passes as a survivor", { timeout: 60_000 }, () => {
  const k = sweep('throw new Error("told apart");', 30_000);
  assert.match(k.out, new RegExp(`^KILLED \\[${PLANT}\\] pass 0 fail 1$`, "m"), k.out);
  assert.match(k.out, /^1\/1 killed$/m, k.out);
  assert.equal(k.status, 0, k.out);
  assert.ok(k.putBack, "the plant is put back");
  const s = sweep("", 30_000);
  assert.match(s.out, new RegExp(`^SURVIVED \\[${PLANT}\\] pass 1 fail 0$`, "m"), s.out);
  assert.notEqual(s.status, 0, s.out);
});
