// Card restore-walk-rewalks-a-bad-lane: the restore's lane walk hashes on a WebAssembly program where it compiles
// (src/notes/poseidon-walk.ts), which answers one known index before its first use (card
// walk-program-checked-before-use). A fault the known index misses (the review's 2^62 cut of the dots' sums answered
// wrong on some inputs only) made the walk's answer wrong, and checkedWalk stopped the restore. Here the program is
// planted to answer its known index right and every later one wrong (each word it writes off by one bit): the restore
// must walk the lane again on BigInt and return the notes an honest walk finds, inline and with the walks handed in.
//   node --test test/restore-rewalk.test.ts      (from packages/wallet)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

type Run = { bites: boolean; inline: unknown; handedIn: unknown; want: string[]; programRuns: number };

/** A fresh process whose walk program is planted (after the imports: node's TypeScript loader runs on WebAssembly too). */
function planted(): Run {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const src = (f: string): string => JSON.stringify(path.join(here, "../src", f));
  const code = `
    const r = await import(${src("notes/restore.ts")});
    const { noteSecrets, noteCommitment } = await import(${src("notes/secrets.ts")});
    const { masters } = await import(${src("derive/index.ts")});
    const RealInstance = WebAssembly.Instance;
    let programRuns = 0;
    WebAssembly.Instance = function (m, i) {
      const inst = new RealInstance(m, i);
      if (!i?.env?.mem) return inst;
      const mem = new Uint32Array(i.env.mem.buffer);
      const real = inst.exports.run;
      return {
        exports: {
          run: () => {
            if (++programRuns === 1) return real();
            const before = mem.slice();
            real();
            for (let w = 0; w < mem.length; w++) if (mem[w] !== before[w]) mem[w] ^= 1;
          },
        },
      };
    };
    // an all-zero seed64: a test value, no wallet's
    const seed64 = new Uint8Array(64);
    const scope = 12345n;
    const gap = 50;
    const owned = [3, 7, 27, 323];
    const deposits = owned.map((i, k) => {
      const precommitment = noteSecrets(seed64, { kind: "deposit", s: scope, i }).precommitment;
      return { index: k, precommitment, label: 1000n + BigInt(k), value: 5n + BigInt(k), leafIndex: BigInt(k), depositor: "a.test" };
    });
    const pages = { deposits, spends: [], leaves: deposits.map((d) => noteCommitment(d.value, d.label, d.precommitment)) };
    const has = (p) => deposits.some((d) => d.precommitment === p);
    const outcome = (f) => {
      try {
        const got = f();
        return { notes: got.notes.map((n) => n.ref.kind + " " + n.ref.i + " " + n.leaf.value), laneWalked: got.laneWalked };
      } catch (e) {
        return { stopped: String(e.message) };
      }
    };
    const m = masters(seed64, "deposit");
    const lanes = Array.from({ length: 8 }, (_, lane) => r.walkLaneOf(m, scope, lane, has, gap));
    // the plant bites: lane 3's fast walk misses its notes and its last precommitment is not poseidon-lite's
    const bites = lanes[3].found.length === 0 && lanes[3].lastPrecommitment !== noteSecrets(seed64, { kind: "deposit", s: scope, i: lanes[3].last }).precommitment;
    const inline = outcome(() => r.restorePages(seed64, scope, pages, { gap }));
    const handedIn = outcome(() => r.restorePages(seed64, scope, pages, { gap, lanes }));
    const want = owned.map((i, k) => "deposit " + i + " " + (5 + k));
    console.log(JSON.stringify({ bites, inline, handedIn, want, programRuns }));
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").pop()!) as Run;
}

test("card restore-walk-rewalks-a-bad-lane: a walk program that answers its known index right and later ones wrong costs a walk again on BigInt, never the restore: the notes an honest walk finds, inline and handed in", () => {
  const r = planted();
  assert.equal(r.bites, true, "the planted program makes the fast walk wrong");
  assert.equal(r.programRuns > 1, true, "the program passed its known index and was used");
  // each lane walked to gap past its last note: lane 3's notes at 3, 27 and 323, lane 7's at 7, the rest none
  const laneWalked = Array.from({ length: 8 }, (_, lane) => (lane === 3 ? 323 : lane === 7 ? 7 : lane - 8) + 8 * 50);
  const want = { notes: [...r.want].sort(), laneWalked };
  for (const [what, got] of [["inline", r.inline], ["handed in", r.handedIn]] as const) {
    assert.ok(got && typeof got === "object" && !("stopped" in got), `${what}: the restore stopped: ${JSON.stringify(got)}`);
    const g = got as { notes: string[]; laneWalked: number[] };
    assert.deepEqual({ notes: [...g.notes].sort(), laneWalked: g.laneWalked }, want, what);
  }
});
