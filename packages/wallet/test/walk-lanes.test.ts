// Card restore-shows-the-balance-in-seconds: a pool's 8 lane walks in Workers (src/restore/walk.ts walkLanes) are the
// page's own walks, lane for lane, for a pool's precommitments and for the Solana pool's marks (a PDA per index, made in
// the Worker); a Worker that cannot start walks its lane on the page; one that refuses stops the walk with its lane
// named; at most `cores` Workers run at once, and each is terminated once it answers. Real Workers
// (node:worker_threads, test/walk-worker-node.mjs, which clones bigints as a browser's postMessage does).
//   node --test test/walk-lanes.test.ts
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Worker } from "node:worker_threads";
import { base58 } from "@scure/base";
import * as d from "../src/derive/index.ts";
import { noteSecrets } from "../src/notes/secrets.ts";
import { checkedWalk, RESTORE_LANES, slices, walkLaneYielding, type LaneWalk } from "../src/notes/restore.ts";
import { solanaMarkOf } from "../src/pool/solana-restore.ts";
import { SOL_MAINNET_DEPLOY } from "../src/pool/solana.ts";
import { answerWalk, solanaPreMarkOf, walkCores, walkLanes, type WalkPort } from "../src/restore/walk.ts";

const SEED = d.wordsToSeed64(d.entropyToWords(new Uint8Array(16))); // the published all-zero entropy vector (a8.json)
const M = d.masters(SEED, "deposit");
const SCOPE = 777n;
const GAP = 40;
const PROGRAM = SOL_MAINNET_DEPLOY.program;
const P = (i: number): bigint => noteSecrets(SEED, { kind: "deposit", s: SCOPE, i }).precommitment;
// notes at indices 2, 3, 17 and 300 (lane 4, past a first gap of misses only when read to its reach: not found)
const HELD = [2, 3, 17, 90];
const PRE = [...HELD.map(P), 123n];
const MARKS = [...HELD.map((i) => solanaMarkOf(PROGRAM, "pre", P(i))), solanaMarkOf(PROGRAM, "pre", 123n)];

const live: Worker[] = [];
after(() => live.forEach((w) => void w.terminate()));
let started = 0;
let running = 0;
let most = 0;
let ended = 0;
function nodeWalker(): WalkPort {
  const w = new Worker(new URL("./walk-worker-node.mjs", import.meta.url));
  live.push(w);
  started++;
  most = Math.max(most, ++running);
  let gone = false;
  return {
    postMessage: (m) => w.postMessage(m),
    addEventListener: (type, f) => void w.on(type, type === "message" ? (data: unknown) => f({ data }) : () => f({})),
    terminate: () => {
      if (!gone) (gone = true, running--, ended++);
      void w.terminate();
    },
  };
}
const onPage = async (has: (p: bigint) => boolean): Promise<LaneWalk[]> => {
  const out: LaneWalk[] = [];
  for (let lane = 0; lane < RESTORE_LANES; lane++) out.push(await walkLaneYielding(M, SCOPE, lane, has, GAP, null, undefined, slices()));
  return out;
};

test("the Solana mark of a precommitment made in the Worker is the pool's own (solanaMarkOf)", () => {
  for (const p of [P(0), P(17), 123n]) assert.equal(solanaPreMarkOf(base58.decode(PROGRAM), p), solanaMarkOf(PROGRAM, "pre", p));
});

test("8 lanes in Workers, cores at a time: lane for lane the page's walk, each checked whole; every Worker ended", async () => {
  const pre = new Set(PRE);
  const page = await onPage((p) => pre.has(p));
  assert.deepEqual(page.flatMap((w) => w.found).sort((a, b) => a - b), HELD, "the page's walk finds the notes");
  for (const [match, cores] of [[{ kind: "pre" as const, precommitments: PRE }, 3], [{ kind: "solana" as const, program: PROGRAM, marks: MARKS }, 8]] as const) {
    started = running = most = ended = 0;
    const got = await walkLanes({ m: M, scope: SCOPE, match, gap: GAP, slice: slices(), spawn: nodeWalker, cores });
    assert.deepEqual(got, page, `${match.kind}: the Workers' walks are the page's`);
    got.forEach((w, lane) => checkedWalk(w, lane, SEED, SCOPE, GAP, null));
    assert.equal(started, RESTORE_LANES, "one Worker a lane");
    assert.equal(most, cores, `at most ${cores} at once`);
    assert.equal(ended, RESTORE_LANES, "each Worker terminated once it answered");
  }
});

test("a Worker that cannot start walks its lane on the page; one that fails before it answers too", async () => {
  const pre = new Set(PRE);
  const page = await onPage((p) => pre.has(p));
  let n = 0;
  const flaky = (): WalkPort => {
    if (n++ % 2 === 0) throw new Error("no Worker here");
    const p = nodeWalker();
    // a load that fails: an error before any answer
    return n % 4 === 0 ? { ...p, postMessage: () => void setTimeout(() => errorOf?.(), 1) , addEventListener: (t, f) => { if (t === "error") errorOf = () => f({}); else p.addEventListener(t, f); } } : p;
  };
  let errorOf: (() => void) | undefined;
  assert.deepEqual(await walkLanes({ m: M, scope: SCOPE, match: { kind: "pre", precommitments: PRE }, gap: GAP, slice: slices(), spawn: flaky, cores: 1 }), page);
  assert.deepEqual(await walkLanes({ m: M, scope: SCOPE, match: { kind: "pre", precommitments: PRE }, gap: GAP, slice: slices(), spawn: () => { throw new Error("no Worker"); }, cores: 8 }), page);
});

test("a Worker that refuses stops the walk with its lane named, and the other lanes' Workers end; a stopped run ends them too", async () => {
  started = running = most = ended = 0;
  const refusing = (): WalkPort => {
    const p = nodeWalker();
    return { ...p, postMessage: (m) => p.postMessage({ ...(m as object), precommitments: ["not a bigint"] }) };
  };
  await assert.rejects(walkLanes({ m: M, scope: SCOPE, match: { kind: "pre", precommitments: PRE }, gap: GAP, slice: slices(), spawn: refusing, cores: 4 }), /lane \d: the walk worker refused: precommitments: not bigints/);
  for (let i = 0; i < 50 && running > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(running, 0, "no Worker left running");
  const stop = new AbortController();
  const run = walkLanes({ m: M, scope: SCOPE, match: { kind: "pre", precommitments: PRE }, gap: 2_000_000, signal: stop.signal, slice: slices(), spawn: nodeWalker, cores: 8 });
  stop.abort(new Error("signed out"));
  await assert.rejects(run, /signed out/);
  for (let i = 0; i < 50 && running > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(running, 0, "every Worker ended at the stop");
});

test("the Worker's ask: the masters and the match, never the seed; a Solana ask of another shape is refused", () => {
  const base = { lane: 1, scope: SCOPE, gap: GAP, reach: null, nullifier: M.nullifier, secret: M.secret };
  assert.equal(answerWalk({ ...base, solana: { program: PROGRAM, marks: MARKS } }).ok, true);
  assert.deepEqual(answerWalk({ ...base, solana: { program: PROGRAM, marks: [1] } }), { ok: false, error: "solana marks: not addresses" });
  assert.deepEqual(answerWalk({ ...base, solana: { program: "short", marks: [] } }), { ok: false, error: "solana program: not an address" });
  assert.deepEqual(answerWalk(base), { ok: false, error: "precommitments: not bigints" });
  assert.equal(walkCores(Number.NaN), 1);
  assert.equal(walkCores(0), 1);
  assert.equal(walkCores(64), 8);
  assert.equal(walkCores(3), 3);
});
