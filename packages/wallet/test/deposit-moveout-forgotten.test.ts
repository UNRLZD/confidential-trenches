// Card held-move-forgotten-tx: a held move out that landed on 2 Nov 2026 (2Q4pYKQ9..., signer 4b6c00c3...) and that the
// testnet release pair no longer keeps (both answer UNKNOWN_TRANSACTION to it, read 8 Nov 2026): the wallet's own
// moveOutHeld(op, null) replays every answer test.rpc.fastnear.com, near-testnet.drpc.org and both testnet archival
// RPCs gave it (test/vectors/moveout-forgotten-2q4p.json, recorded with send_tx blocked and no seed). The pair reads U
// at 587,365 base units after it (block 276739523), so the move is history and U's money open for a tap, whatever the
// archival hosts say (delta review of c3e71713, item 2: money in U is always movable; Moved only while U holds 1), and
// they are not asked then (delta review 4, item 2). Their recorded answers are the card's real archival read.
//   node --test test/deposit-moveout-forgotten.test.ts   (from packages/wallet)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { NEAR_NETWORKS } from "../src/deposit/account.ts";
import type { DepositOp } from "../src/deposit/follow.ts";
import { moveOutHeld, moveOutRpc } from "../src/deposit/moveout.ts";

type Answer = { url: string; body: unknown; status: number; answer: unknown };
const V = JSON.parse(readFileSync(new URL("./vectors/moveout-forgotten-2q4p.json", import.meta.url), "utf8")) as { record: Record<string, unknown>; u: string; answers: Answer[] };
const NET = NEAR_NETWORKS.testnet;

// every request answered as recorded, by URL and body; send_tx and anything unrecorded throw
function replay(drop: (a: Answer) => boolean = () => false) {
  const asked: string[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    delete body.id;
    asked.push(`${url} ${body.method}`);
    const a = V.answers.find((x) => x.url === url && JSON.stringify(x.body) === JSON.stringify(body) && !drop(x));
    if (a === undefined) throw new Error(`no recorded answer: ${url} ${body.method}`);
    return new Response(JSON.stringify(a.answer), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchFn, asked };
}
function store() {
  const db = new Map<string, unknown>([["op1", { kind: "deposit", stage: "held", txs: [], created_ms: 1, held_id: V.u, follow: { network: "testnet", s: "1", i: 0, u: V.u, address: "x", deadline_ms: 1, origin: "nep141:x", min_out: "1", why: "sender_struck", out: V.record } }]]);
  return {
    db,
    ops: {
      get: async (_s: string, k: string) => db.get(k),
      keys: async () => [...db.keys()],
      update: async (_s: string, k: string, f: (v: unknown) => unknown) => {
        const n = f(db.get(k));
        if (n !== undefined) db.set(k, n);
        return db.get(k);
      },
    },
  };
}
const deps = (fetchFn: typeof fetch, ops: ReturnType<typeof store>["ops"], archival = true) => ({
  ops: ops as never,
  rpcs: [moveOutRpc(NET.fastnear[0], fetchFn), moveOutRpc(NET.drpc, fetchFn)] as const,
  ...(archival ? { archival: NET.archival.map((u) => moveOutRpc(u, fetchFn)) } : {}),
  seed64: async (): Promise<Uint8Array> => {
    throw new Error("no seed: a resume never signs");
  },
  sleep: async () => {},
  pollMs: 0,
});

test("the recorded reads: both of the pair answer UNKNOWN_TRANSACTION, both archival RPCs FINAL SuccessValue", () => {
  const txs = V.answers.filter((a) => (a.body as { method: string }).method === "tx");
  const of = (url: string) => txs.filter((a) => a.url === url).map((a) => a.answer as { error?: { cause?: { name?: string } }; result?: { final_execution_status?: string; status?: object } });
  for (const url of [NET.fastnear[0], NET.drpc]) {
    assert.ok(of(url).length > 0, url);
    for (const a of of(url)) assert.equal(a.error?.cause?.name, "UNKNOWN_TRANSACTION", url);
  }
  for (const url of NET.archival) {
    const arch = of(url);
    assert.equal(arch.length, 1, `${url} is read once`);
    assert.equal(arch[0]!.result?.final_execution_status, "FINAL", url);
    assert.ok(Object.hasOwn(arch[0]!.result!.status!, "SuccessValue"), url);
  }
});

test("real-gc: the landed, forgotten 2Q4pYKQ9..., U at 587,365 since: a resume answers open, the record is history, never Moved; nothing signed or sent", async () => {
  const r = replay();
  const s = store();
  const out = await moveOutHeld("op1", null, deps(r.fetchFn, s.ops));
  assert.deepEqual(out, { kind: "open" });
  const op = s.db.get("op1") as DepositOp;
  assert.notEqual(op.follow.why, "moved_out");
  assert.equal(op.follow.out, undefined);
  assert.deepEqual(op.follow.out_past?.map((x) => x.hash), [V.record.hash]);
  // U holds 587,365: the archival hosts' word would not be read, so they are not asked (delta review 4, item 2)
  assert.deepEqual(r.asked.filter((x) => (NET.archival as readonly string[]).some((u) => x.startsWith(u))), [], "no archival RPC asked");
  assert.ok(!r.asked.some((x) => x.endsWith(" send_tx")), "nothing sent");
});

test("real-gc with the archival RPCs silent, only one answering, or none listed: U's 587,365 is open the same, never Moved and never failed (F1, F1b on the real reads)", async () => {
  const cases: [string, ReturnType<typeof replay>, boolean][] = [
    ...NET.archival.map((url): [string, ReturnType<typeof replay>, boolean] => [`${url} silent`, replay((a) => a.url === url), true]),
    ["both silent", replay((a) => (NET.archival as readonly string[]).includes(a.url)), true],
    ["none listed", replay(), false],
  ];
  for (const [why, r, listed] of cases) {
    const s = store();
    const out = await moveOutHeld("op1", null, deps(r.fetchFn, s.ops, listed)).catch((e: Error) => ({ kind: `threw ${e.message}` }));
    assert.deepEqual(out, { kind: "open" }, why);
    const op = s.db.get("op1") as DepositOp;
    assert.notEqual(op.follow.why, "moved_out", why);
    assert.deepEqual(op.follow.out_past?.map((x) => x.hash), [V.record.hash], why);
    assert.ok(!r.asked.some((x) => x.endsWith(" send_tx")), `${why}: nothing sent`);
  }
});
