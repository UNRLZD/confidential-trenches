/// <reference types="node" />
// The Solana set send (markets paper T2.1 "Sending", LD2; row M1.3): the same signed bytes go to every path in one
// tick, a path that is down or slow holds nothing back, the rebroadcast stops on a fill read on two providers and when
// both providers' finalized height passes lastValidBlockHeight, and a status read the two providers disagree on is
// never a fill. Fake endpoints only: nothing here reaches a network.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { base58, base64 } from "@scure/base";
import {
  SOLANA_JITO_TRANSACTIONS_URL,
  SOLANA_PUBLIC_RPC_URL,
  SOLANA_REBROADCAST_MS,
  SOLANA_SENDER_FAST_URL,
  SOLANA_STATUS_POLL_MS,
  dryRunSolanaSet,
  sendSolanaSet,
  solanaHelperRpc,
  solanaJsonRpc,
  solanaSendPaths,
  type SolanaRpc,
  type SolanaSendPath,
  type SolanaSignedTx,
} from "../src/index.ts";

// ---- a signed-looking v0 tx: 1 signature slot, a message with one signer and the system program (test only)
function tx(seed: number, lvbh = 1_000): SolanaSignedTx {
  const sig = new Uint8Array(64).fill(seed);
  const payer = new Uint8Array(32).fill(seed + 1);
  const system = new Uint8Array(32);
  const blockhash = new Uint8Array(32).fill(7);
  // v0: prefix, header (1 signer, 0 ro signed, 1 ro unsigned), 2 keys, blockhash, 1 ix (program 1, accounts [0], no
  // data), no lookups
  const msg = [0x80, 1, 0, 1, 2, ...payer, ...system, ...blockhash, 1, 1, 1, 0, 0, 0];
  return { wire: Uint8Array.from([1, ...sig, ...msg]), lastValidBlockHeight: lvbh };
}
const sigOf = (t: SolanaSignedTx) => base58.encode(t.wire.subarray(1, 65));

type Status = null | { confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown; slot: number };
// A fake provider: per-signature status and a finalized height the test sets; it records every call.
type FakeProvider = {
  height: number;
  statusAnswer: unknown;
  hang: boolean;
  calls: { method: string; params: readonly unknown[] }[];
  set(sig: string, s: Status): void;
  rpc: SolanaRpc;
};
function provider(): FakeProvider {
  const st = new Map<string, Status>();
  const p: FakeProvider = {
    height: 0,
    statusAnswer: undefined as unknown, // when set, answered as is (a hostile reply)
    hang: false,
    calls: [] as { method: string; params: readonly unknown[] }[],
    set(sig: string, s: Status) { st.set(sig, s); },
    rpc: (async (method, params) => {
      p.calls.push({ method, params });
      if (p.hang) return new Promise(() => {});
      if (method === "getSignatureStatuses") {
        if (p.statusAnswer !== undefined) return p.statusAnswer;
        const sigs = params[0] as string[];
        return { context: { slot: 1 }, value: sigs.map((s) => st.get(s) ?? null) };
      }
      if (method === "getBlockHeight") return p.height;
      if (method === "simulateTransaction") return { context: { slot: 1 }, value: { err: null, unitsConsumed: 450, logs: [] } };
      throw new Error(`unexpected ${method}`);
    }) as SolanaRpc,
  };
  return p;
}
function path(name: string, mode: "ok" | "down" | "hang" = "ok") {
  const p = {
    calls: [] as { b64: string; tick: number }[],
    path: {
      name,
      send: (b64: string) => {
        p.calls.push({ b64, tick });
        if (mode === "down") return Promise.reject(new Error("down"));
        if (mode === "hang") return new Promise<string>(() => {});
        return Promise.resolve(base58.encode(base64.decode(b64).subarray(1, 65)));
      },
    } satisfies SolanaSendPath,
  };
  return p;
}
let tick = 0; // bumped by the test between synchronous sections, so a call's tick says when it was made
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    mock.timers.tick(100);
    await flush();
  }
}
const OK: Status = { confirmationStatus: "confirmed", err: null, slot: 9 };
const FIN: Status = { confirmationStatus: "finalized", err: null, slot: 9 };
const ERR: Status = { confirmationStatus: "confirmed", err: { InstructionError: [2, { Custom: 6001 }] }, slot: 9 };

function setup(modes: ("ok" | "down" | "hang")[] = ["ok", "ok", "ok", "ok"]) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  tick = 0;
  const paths = modes.map((m, i) => path(["sender", "jito", "rpc", "helper"][i]!, m));
  const a = provider();
  const b = provider();
  return { paths, a, b, opts: { paths: paths.map((p) => p.path), providers: [a.rpc, b.rpc] as const } };
}

test("all four paths get the same bytes in the same tick, before sendSolanaSet returns", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, opts } = setup();
  const set = [tx(11), tx(12), tx(13)];
  const h = sendSolanaSet(set, opts);
  tick = 1;
  for (const p of paths) {
    assert.equal(p.calls.length, 3, `${p.path.name} got every tx at once`);
    assert.deepEqual(p.calls.map((c) => c.tick), [0, 0, 0]);
    assert.deepEqual(p.calls.map((c) => c.b64), set.map((s) => base64.encode(s.wire)));
  }
  assert.deepEqual(h.signatures, set.map(sigOf));
  h.stop();
  const r = await h.done;
  assert.deepEqual(r.txs.map((x) => x.state), ["unknown", "unknown", "unknown"]);
});

test("a path that is down or hangs never delays the others: they get the bytes, the rebroadcast and the fill", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup(["down", "hang", "ok", "ok"]);
  const one = tx(21);
  const h = sendSolanaSet([one], opts);
  for (const p of paths) assert.equal(p.calls.length, 1, `${p.path.name} got the first send`);
  tick = 1;
  await advance(SOLANA_REBROADCAST_MS);
  for (const p of paths) assert.equal(p.calls.length, 2, `${p.path.name} got the rebroadcast at 2 s`);
  assert.deepEqual(paths.map((p) => p.calls[1]!.tick), [1, 1, 1, 1]);
  a.set(sigOf(one), OK);
  b.set(sigOf(one), FIN);
  await advance(SOLANA_STATUS_POLL_MS * 2);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "filled");
  const sends = r.txs[0]!.sends;
  assert.ok(sends.some((s) => s.path === "sender" && !s.ok && /down/.test(s.error ?? "")), "the down path is recorded");
  assert.ok(sends.some((s) => s.path === "rpc" && s.ok), "the good path is recorded");
});

test("rebroadcast every 2 s, and stops once both providers read the fill", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const one = tx(31);
  const h = sendSolanaSet([one], opts);
  await advance(SOLANA_REBROADCAST_MS * 3);
  for (const p of paths) assert.equal(p.calls.length, 4, "the first send and three rebroadcasts");
  a.set(sigOf(one), OK);
  b.set(sigOf(one), OK);
  await advance(SOLANA_STATUS_POLL_MS * 2);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "filled");
  assert.equal(r.txs[0]!.slot, 9);
  const after = paths.map((p) => p.calls.length);
  await advance(SOLANA_REBROADCAST_MS * 5);
  assert.deepEqual(paths.map((p) => p.calls.length), after, "nothing is sent after the fill");
});

test("rebroadcast stops when both providers' finalized height passes lastValidBlockHeight; the tx is then dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const one = tx(41, 500);
  const h = sendSolanaSet([one], opts);
  await advance(SOLANA_REBROADCAST_MS);
  a.height = 501; // one provider past: not enough
  b.height = 500; // at lastValidBlockHeight the blockhash is still valid
  await advance(SOLANA_REBROADCAST_MS * 2);
  const mid = paths[0]!.calls.length;
  await advance(SOLANA_REBROADCAST_MS);
  assert.ok(paths[0]!.calls.length > mid, "one provider's height never stops the rebroadcast");
  b.height = 501;
  await advance(SOLANA_REBROADCAST_MS * 2);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "expired");
  const after = paths.map((p) => p.calls.length);
  await advance(SOLANA_REBROADCAST_MS * 5);
  assert.deepEqual(paths.map((p) => p.calls.length), after, "nothing is sent past lastValidBlockHeight");
});

test("a landed tx read late is never called dead: past the height with a status on one provider is not expired", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(42, 500);
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 20_000 });
  a.height = 600;
  b.height = 600;
  a.set(sigOf(one), OK); // landed on A's view, B has not seen it yet
  await advance(SOLANA_REBROADCAST_MS * 3);
  b.set(sigOf(one), OK);
  await advance(SOLANA_STATUS_POLL_MS * 2);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "filled");
});

test("a status read started before the height answer never makes a tx dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(43, 500);
  let release: ((v: unknown) => void) | undefined;
  let held = 0;
  const slowA: SolanaRpc = (m, p) => {
    if (m === "getSignatureStatuses" && held === 0) {
      held++;
      return new Promise((r) => { release = r; }); // in flight while the heights arrive
    }
    return a.rpc(m, p);
  };
  const h = sendSolanaSet([one], { ...opts, providers: [slowA, b.rpc], deadlineMs: 60_000 });
  a.height = 600;
  b.height = 600;
  await advance(SOLANA_REBROADCAST_MS + 100); // heights read and past on both; A's first status read still open
  release!({ context: { slot: 1 }, value: [null] }); // an answer from before the heights: says nothing of now
  await flush();
  a.set(sigOf(one), OK);
  b.set(sigOf(one), OK);
  await advance(SOLANA_STATUS_POLL_MS * 2);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "filled");
});

test("a status the two providers disagree on is not a fill, nor a failure; both failed is a failure", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const [x, y, z, w] = [tx(51), tx(52), tx(53), tx(54)];
  const h = sendSolanaSet([x, y, z, w], { ...opts, deadlineMs: 10_000 });
  a.set(sigOf(x), OK); // B has nothing
  a.set(sigOf(y), OK);
  b.set(sigOf(y), ERR); // A says ok, B says failed
  a.set(sigOf(z), ERR);
  b.set(sigOf(z), ERR); // both failed
  a.set(sigOf(w), OK);
  b.set(sigOf(w), { confirmationStatus: "processed", err: null, slot: 9 }); // processed is not confirmed
  await advance(10_000);
  const r = await h.done;
  assert.deepEqual(r.txs.map((t) => t.state), ["unknown", "unknown", "failed", "unknown"]);
  assert.ok(r.txs.every((t) => t.state !== "filled"));
});

test("a hostile or broken status answer is never a fill", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(61);
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 10_000 });
  let settled = false;
  void h.done.then(() => { settled = true; });
  b.set(sigOf(one), OK);
  for (const bad of [
    { context: { slot: 1 }, value: [] }, // wrong length
    { context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", slot: 9 }] }, // err missing
    { context: { slot: 1 }, value: [{ confirmationStatus: "landed", err: null, slot: 9 }] }, // unknown status
    { value: [OK, OK] }, // too many
    "confirmed",
    null,
  ]) {
    a.statusAnswer = bad;
    await advance(1_000);
    assert.equal(settled, false, `answer ${JSON.stringify(bad)} decided nothing`);
  }
  await advance(5_000);
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "unknown");
});

test("a hostile height answer never stops the rebroadcast", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const h = sendSolanaSet([tx(62, 500)], { ...opts, deadlineMs: 30_000 });
  for (const bad of [1e300, 600.5, "9999999", -1]) {
    (a as { height: unknown }).height = bad;
    (b as { height: unknown }).height = bad;
    await advance(SOLANA_REBROADCAST_MS);
    const mid = paths[2]!.calls.length;
    await advance(SOLANA_REBROADCAST_MS * 2);
    assert.ok(paths[2]!.calls.length > mid, `height ${JSON.stringify(bad)} stopped nothing`);
  }
  await advance(8_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

test("in a set, a decided tx is never sent again while its siblings still are", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const [x, y] = [tx(64), tx(65)];
  const h = sendSolanaSet([x, y], { ...opts, deadlineMs: 20_000 });
  a.set(sigOf(x), OK);
  b.set(sigOf(x), OK);
  await advance(SOLANA_STATUS_POLL_MS * 2);
  const b64x = base64.encode(x.wire);
  const b64y = base64.encode(y.wire);
  const count = (s: string) => paths.map((p) => p.calls.filter((c) => c.b64 === s).length);
  const [xs, ys] = [count(b64x), count(b64y)];
  await advance(SOLANA_REBROADCAST_MS * 3);
  assert.deepEqual(count(b64x), xs, "the filled tx is not sent again");
  assert.ok(count(b64y).every((n, i) => n > ys[i]!), "its sibling still is");
  h.stop();
  const r = await h.done;
  assert.deepEqual(r.txs.map((o) => o.state), ["filled", "unknown"]);
});

test("a tx past lastValidBlockHeight on both providers is never sent again, even while its status is undecided", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const one = tx(66, 500);
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 30_000 });
  b.set(sigOf(one), { confirmationStatus: "processed", err: null, slot: 9 }); // never decided: no fill, never dead
  await advance(SOLANA_REBROADCAST_MS);
  a.height = 501;
  b.height = 501;
  await advance(SOLANA_REBROADCAST_MS * 2);
  const after = paths.map((p) => p.calls.length);
  await advance(SOLANA_REBROADCAST_MS * 5);
  assert.deepEqual(paths.map((p) => p.calls.length), after, "nothing is sent once the blockhash is past");
  await advance(30_000);
  assert.equal((await h.done).txs[0]!.state, "unknown", "processed on one provider is neither filled nor dead");
});

test("a status with no err field is neither a fill nor a failure, on both providers", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(67);
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 4_000 });
  const noErr = { confirmationStatus: "confirmed", slot: 9 } as unknown as Status;
  a.set(sigOf(one), noErr);
  b.set(sigOf(one), noErr);
  await advance(4_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

test("a provider that hangs holds no fill back from being read once it answers, and never fills alone", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(63);
  b.hang = true;
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 8_000 });
  a.set(sigOf(one), OK);
  await advance(8_000);
  assert.equal((await h.done).txs[0]!.state, "unknown", "one provider's word is not a fill");
  const reads = b.calls.filter((c) => c.method === "getSignatureStatuses").length;
  assert.ok(reads <= 2, `a hung provider's reads are not stacked: ${reads} in 8 s with a 5 s call timeout`);
});

test("the set is refused before any send: unsigned, duplicate, too large, bad lastValidBlockHeight, empty", (t) => {
  t.after(() => mock.timers.reset());
  const { paths, opts } = setup();
  const unsigned = tx(0);
  assert.throws(() => sendSolanaSet([unsigned], opts), /not signed/);
  assert.throws(() => sendSolanaSet([tx(71), tx(71)], opts), /twice/);
  assert.throws(() => sendSolanaSet([{ wire: new Uint8Array(1233), lastValidBlockHeight: 1 }], opts), /bytes|signature/);
  assert.throws(() => sendSolanaSet([{ ...tx(72), lastValidBlockHeight: -1 }], opts), /lastValidBlockHeight/);
  assert.throws(() => sendSolanaSet([{ ...tx(73), lastValidBlockHeight: 2 ** 53 }], opts), /lastValidBlockHeight/);
  assert.throws(() => sendSolanaSet([tx(74).wire.subarray(0, 40) as unknown as SolanaSignedTx], opts));
  assert.throws(() => sendSolanaSet([], opts), /empty/);
  assert.throws(() => sendSolanaSet([tx(75)], { ...opts, paths: [] }), /path/);
  for (const p of paths) assert.equal(p.calls.length, 0, "nothing was sent");
});

test("the default paths: the paper's three keyless URLs and the helper's /v1/rpc/solana, one fetch each, same bytes, in one tick", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const body = JSON.parse(String(init.body)) as { id: number; params: [string] };
    const sig = base58.encode(base64.decode(body.params[0]).subarray(1, 65));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sig }), { headers: { "content-type": "application/json" } }));
  };
  const helper = solanaHelperRpc("https://helper.example", { fetch: fakeFetch });
  const paths = solanaSendPaths({ helper, fetch: fakeFetch });
  assert.deepEqual(paths.map((p) => p.name), ["sender", "jito", "rpc", "helper"]);
  const one = tx(81);
  const b64 = base64.encode(one.wire);
  const results = paths.map((p) => p.send(b64));
  assert.equal(seen.length, 4, "every path's fetch started before any await");
  assert.deepEqual(seen.map((s) => s.url), [SOLANA_SENDER_FAST_URL, SOLANA_JITO_TRANSACTIONS_URL, SOLANA_PUBLIC_RPC_URL, "https://helper.example/v1/rpc/solana"]);
  assert.equal(SOLANA_SENDER_FAST_URL, "https://sender.helius-rpc.com/fast?swqos_only=true");
  assert.equal(SOLANA_JITO_TRANSACTIONS_URL, "https://mainnet.block-engine.jito.wtf/api/v1/transactions");
  const bodies = seen.map((s) => JSON.parse(String(s.init.body)) as { method: string; params: [string, Record<string, unknown>] });
  for (const b of bodies) {
    assert.equal(b.method, "sendTransaction");
    assert.equal(b.params[0], b64, "the same bytes on every path");
  }
  const [sender, jito, rpc, viaHelper] = bodies;
  for (const b of [sender!, rpc!, viaHelper!]) assert.deepEqual(b.params[1], { encoding: "base64", skipPreflight: true, maxRetries: 0 });
  assert.deepEqual(jito!.params[1], { encoding: "base64" }, "Jito's documented form; it always skips preflight");
  assert.equal(seen[3]!.init.credentials, "omit");
  assert.equal(seen[3]!.init.referrerPolicy, "no-referrer");
  for (const s of seen) assert.equal(s.init.method, "POST");
  assert.deepEqual(await Promise.all(results), [0, 1, 2, 3].map(() => sigOf(one)));
  assert.deepEqual(solanaSendPaths({ fetch: fakeFetch }).map((p) => p.name), ["sender", "jito", "rpc"], "no helper: one path fewer, never a wait");
});

test("solanaJsonRpc refuses an answer that is not a JSON-RPC result for its own request", async () => {
  // each answer is built from the request's own id, so only the shape under test is wrong
  const answer = (body: (id: number) => string, status = 200) => (_u: string, init: RequestInit) =>
    Promise.resolve(new Response(body((JSON.parse(String(init.body)) as { id: number }).id), { status }));
  const call = (f: (u: string, i: RequestInit) => Promise<Response>) => solanaJsonRpc("https://rpc.example", { fetch: f })("getBlockHeight", []);
  await assert.rejects(call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id: id + 1, result: 5 }))), /id/);
  await assert.rejects(call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32005, message: "x" } }))), /-32005/);
  await assert.rejects(call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id }))), /no result/);
  await assert.rejects(call(answer(() => "not json")));
  await assert.rejects(call(answer(() => "{}", 429)), /429/);
  await assert.rejects(call(answer(() => "x".repeat(2 * 1024 * 1024))), /large/);
  assert.equal(await call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id, result: 5 }))), 5);
  assert.throws(() => solanaHelperRpc("http://helper.example"), /https/);
  assert.throws(() => solanaHelperRpc("https://helper.example/path?x=1"), /origin/);
  assert.throws(() => solanaJsonRpc("ftp://rpc.example"), /https/);
});

test("dry: the set is simulated on both providers and no path is called", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const set = [tx(91), tx(92), tx(93)];
  const r = await dryRunSolanaSet(set, opts);
  for (const p of paths) assert.equal(p.calls.length, 0, `${p.path.name} was never called`);
  assert.deepEqual(r.txs.map((x) => x.state), ["simulated", "simulated", "simulated"]);
  assert.deepEqual(r.paths, ["sender", "jito", "rpc", "helper"]);
  for (const p of [a, b]) {
    const sims = p.calls.filter((c) => c.method === "simulateTransaction");
    assert.deepEqual(sims.map((c) => c.params[0]), set.map((s) => base64.encode(s.wire)));
    assert.equal(p.calls.some((c) => c.method === "sendTransaction"), false);
  }
});
