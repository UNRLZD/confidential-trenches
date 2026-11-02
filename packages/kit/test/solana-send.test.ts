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
import * as kit from "../src/index.ts";

// ---- a signed-looking v0 tx: 1 signature slot, a message with one signer and the system program (test only)
function tx(seed: number, lvbh = 1_000, firstIxData: number[] = []): SolanaSignedTx {
  const sig = new Uint8Array(64).fill(seed);
  const payer = new Uint8Array(32).fill(seed + 1);
  const system = new Uint8Array(32);
  const blockhash = new Uint8Array(32).fill(7);
  // v0: prefix, header (1 signer, 0 ro signed, 1 ro unsigned), 2 keys, blockhash, 1 ix (program 1 = System, accounts
  // [0], data), no lookups
  const msg = [0x80, 1, 0, 1, 2, ...payer, ...system, ...blockhash, 1, 1, 1, 0, firstIxData.length, ...firstIxData, 0];
  return { wire: Uint8Array.from([1, ...sig, ...msg]), lastValidBlockHeight: lvbh };
}
const sigOf = (t: SolanaSignedTx) => base58.encode(t.wire.subarray(1, 65));
const BLOCKHASH = base58.encode(new Uint8Array(32).fill(7));

type Status = null | { confirmationStatus: "processed" | "confirmed" | "finalized"; err: unknown; slot: number };
// A fake provider, one bank: its finalized block height and slot (getLatestBlockhash at finalized answers the slot and
// height + 150, Agave's MAX_PROCESSING_AGE), the processed slot its status and isBlockhashValid answers carry, whether
// the tx's blockhash is still valid at processed, and per-signature statuses, with a separate answer under
// searchTransactionHistory: true when `hist` has one. Its first isBlockhashValid answer is true (`trueFirst`), as for
// a fresh blockhash, so a later false reads as "valid, then expired"; a test of a hash never read valid turns it off.
// It records every call.
type FakeProvider = {
  height: number;
  slot: number;
  statusSlot: number;
  validSlot: number | null;
  trueFirst: boolean;
  valid: boolean;
  statusAnswer: unknown;
  hang: boolean;
  calls: { method: string; params: readonly unknown[] }[];
  set(sig: string, s: Status): void;
  hist: Map<string, Status>;
  rpc: SolanaRpc;
};
function provider(): FakeProvider {
  const st = new Map<string, Status>();
  const p: FakeProvider = {
    height: 0,
    slot: 1_000,
    statusSlot: 2_000,
    validSlot: null, // isBlockhashValid answers from statusSlot unless set
    trueFirst: true,
    valid: true,
    statusAnswer: undefined as unknown, // when set, answered as is (a hostile reply)
    hang: false,
    calls: [] as { method: string; params: readonly unknown[] }[],
    set(sig: string, s: Status) { st.set(sig, s); },
    hist: new Map(),
    rpc: (async (method, params) => {
      p.calls.push({ method, params });
      if (p.hang) return new Promise(() => {});
      if (method === "getSignatureStatuses") {
        if (p.statusAnswer !== undefined) return p.statusAnswer;
        const sigs = params[0] as string[];
        const history = (params[1] as { searchTransactionHistory?: unknown } | undefined)?.searchTransactionHistory === true;
        return { context: { slot: p.statusSlot }, value: sigs.map((s) => (history && p.hist.has(s) ? p.hist.get(s)! : st.get(s) ?? null)) };
      }
      if (method === "getBlockHeight") return p.height;
      if (method === "getLatestBlockhash") {
        const h = p.height as unknown;
        return { context: { slot: p.slot }, value: { blockhash: "fakefinalizedhash", lastValidBlockHeight: typeof h === "number" ? h + 150 : h } };
      }
      if (method === "isBlockhashValid") {
        if (params[0] !== BLOCKHASH) throw new Error(`isBlockhashValid on ${String(params[0])}`);
        const first = !p.calls.slice(0, -1).some((c) => c.method === "isBlockhashValid");
        return { context: { slot: p.validSlot ?? p.statusSlot }, value: first && p.trueFirst ? true : p.valid };
      }
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
  a.valid = false; // the height is the only gate left here
  b.valid = false;
  const h = sendSolanaSet([one], opts);
  await advance(SOLANA_REBROADCAST_MS);
  a.height = 501; // one provider past: not enough
  b.height = 500; // at lastValidBlockHeight the blockhash is still valid
  await advance(SOLANA_REBROADCAST_MS * 2);
  const mid = paths[0]!.calls.length;
  await advance(SOLANA_REBROADCAST_MS);
  assert.ok(paths[0]!.calls.length > mid, "one provider's height never stops the rebroadcast");
  b.height = 501;
  a.valid = false;
  b.valid = false;
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
  a.valid = false;
  b.valid = false;
  a.set(sigOf(one), OK); // landed on A's view, B has not seen it yet
  await advance(SOLANA_REBROADCAST_MS * 3);
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
  a.valid = b.valid = false; // the height is the only gate left here
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
  a.valid = false;
  b.valid = false;
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

test("the set is refused before any send: unsigned, duplicate, too large, bad lastValidBlockHeight, empty", async (t) => {
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
  // R4: one provider passed twice would fill on one provider's word, as the same object or the same URL
  assert.throws(() => sendSolanaSet([tx(76)], { ...opts, providers: [opts.providers[0], opts.providers[0]] }), /same provider/);
  const u1 = solanaJsonRpc("https://rpc.example/", { fetch: () => Promise.reject(new Error("no")) });
  const u2 = solanaJsonRpc("https://rpc.example/", { fetch: () => Promise.reject(new Error("no")) });
  assert.throws(() => sendSolanaSet([tx(77)], { ...opts, providers: [u1, u2] }), /same provider/);
  await assert.rejects(dryRunSolanaSet([tx(77)], { ...opts, providers: [u1, u2] }), /same provider/);
  // R5: a durable-nonce tx (first instruction System AdvanceNonceAccount, u32 LE 4) has no lastValidBlockHeight
  assert.throws(() => sendSolanaSet([tx(78, 500, [4, 0, 0, 0])], opts), /durable nonce/);
  for (const p of paths) assert.equal(p.calls.length, 0, "nothing was sent");
});

test("an RPC path's sends are in that URL's queue: 40 sendTransaction in any 10 s on a keyless one, the rest wait", async () => {
  let fetched = 0;
  const fakeFetch = (_url: string, init: RequestInit) => {
    fetched++;
    const body = JSON.parse(String(init.body)) as { id: string; params: [string] };
    const sig = base58.encode(base64.decode(body.params[0]).subarray(1, 65));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sig }), { headers: { "content-type": "application/json" } }));
  };
  const rpcPath = solanaSendPaths({ rpcUrl: "https://send-queue.example", fetch: fakeFetch }).find((p) => p.name === "rpc")!;
  const b64 = base64.encode(tx(82).wire);
  for (let i = 0; i < 45; i++) void rpcPath.send(b64).catch(() => null);
  assert.equal(fetched, kit.SOLANA_KEYLESS_RPC_LIMIT.perMethod, "the first 40 start at once, the other 5 wait for the window");
  // the queue is the URL's: another set of paths to the same URL waits behind the same 40
  void solanaSendPaths({ rpcUrl: "https://send-queue.example", fetch: fakeFetch }).find((p) => p.name === "rpc")!.send(b64).catch(() => null);
  assert.equal(fetched, kit.SOLANA_KEYLESS_RPC_LIMIT.perMethod);
});

test("one queue a provider: a call that started late moves the next one back, so the limit holds on the times calls went out", async () => {
  const at: number[] = [];
  const rpc: SolanaRpc = async () => { at.push(Date.now()); return null; };
  const paced = kit.solanaPacedRpc(rpc, { windowMs: 300, total: 1, perMethod: 1 });
  const calls = [paced("getSlot", []), paced("getSlot", []), paced("getSlot", [])];
  // the page is busy past the second call's time: it starts late, at about 500 ms
  const until = Date.now() + 500;
  while (Date.now() < until) { /* busy */ }
  await Promise.all(calls);
  const gaps = at.slice(1).map((x, i) => x - at[i]!);
  assert.ok(gaps.every((g) => g > 300), `gaps ${gaps.join(",")} ms`);
});

test("the default paths: the paper's three keyless URLs and the helper's /v1/rpc/solana, one fetch each, same bytes, in one tick", async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const body = JSON.parse(String(init.body)) as { id: string; params: [string] };
    const sig = base58.encode(base64.decode(body.params[0]).subarray(1, 65));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sig }), { headers: { "content-type": "application/json" } }));
  };
  const helper = solanaHelperRpc("https://helper.example", { fetch: fakeFetch });
  const paths = solanaSendPaths({ helper, fetch: fakeFetch });
  assert.deepEqual(paths.map((p) => p.name), ["sender", "jito", "rpc", "helper"]);
  // keyless Sender and Jito take 1 request per second per IP, 429s included: each gets one tx a second
  assert.deepEqual(paths.map((p) => p.minIntervalMs), [1_000, 1_000, undefined, undefined]);
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
  const answer = (body: (id: string) => string, status = 200) => (_u: string, init: RequestInit) =>
    Promise.resolve(new Response(body((JSON.parse(String(init.body)) as { id: string }).id), { status }));
  const call = (f: (u: string, i: RequestInit) => Promise<Response>) => solanaJsonRpc("https://rpc.example", { fetch: f })("getBlockHeight", []);
  await assert.rejects(call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id: `${id}1`, result: 5 }))), /id/);
  await assert.rejects(call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id: Number(id) + 1, result: 5 }))), /id/);
  // the id is a string of digits on every path, so an echo of it as a string or as the same number both hold
  assert.equal(await call(answer((id) => { assert.match(String(id), /^[1-9][0-9]*$/); assert.equal(typeof id, "string"); return JSON.stringify({ jsonrpc: "2.0", id, result: 6 }); })), 6);
  assert.equal(await call(answer((id) => JSON.stringify({ jsonrpc: "2.0", id: Number(id), result: 7 }))), 7);
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

// ---- the Opus review of 694ecb9 (R1-R3 ported from its repros)

test("High (R1): a tx that landed at 1 s and left the status cache is read with searchTransactionHistory and ends filled, never expired", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, opts } = setup();
  const one = tx(101, 500);
  const flags: unknown[] = [];
  // Agave keeps 300 roots of statuses (about 64 s at 212 ms slots); with searchTransactionHistory false a tx older than
  // that answers null. Provider B is down for 70 s (a phone suspended, a helper restart, a run of 429s).
  const prov = (downUntil: number): SolanaRpc => async (method, params) => {
    const now = Date.now();
    if (now < downUntil) throw new Error("HTTP 429");
    if (method === "getBlockHeight") return 600;
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "h", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") return { context: { slot: 2_000 }, value: now < 30_000 }; // a blockhash lives ~32 s
    if (method === "getSignatureStatuses") {
      const hist = (params[1] as { searchTransactionHistory?: boolean }).searchTransactionHistory;
      flags.push(hist);
      const inCache = now < 65_000;
      return { context: { slot: 2_000 }, value: (params[0] as string[]).map(() => (inCache ? OK : hist ? FIN : null)) };
    }
    throw new Error(method);
  };
  const h = sendSolanaSet([one], { ...opts, providers: [prov(0), prov(70_000)] });
  await advance(90_000);
  h.stop();
  const r = await h.done;
  assert.equal(r.txs[0]!.state, "filled", "a filled buy is never called dead");
  assert.ok(flags.includes(true), "the reads past lastValidBlockHeight search the history");
  void paths;
});

test("High: dead is decided only on reads made with searchTransactionHistory: true", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(102, 500);
  a.height = b.height = 600;
  a.valid = b.valid = false;
  a.hist.set(sigOf(one), FIN); // out of the cache: null under false, finalized under true
  b.hist.set(sigOf(one), FIN);
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 20_000 });
  await advance(20_000);
  assert.equal((await h.done).txs[0]!.state, "filled");
  for (const p of [a, b]) {
    const hist = p.calls.filter((c) => c.method === "getSignatureStatuses" && (c.params[1] as { searchTransactionHistory?: boolean }).searchTransactionHistory === true);
    assert.ok(hist.length > 0, "a history read was made once past");
  }
});

test("Medium 1 (R2): a status answer whose context.slot is below the slot its provider's height was read at never counts toward dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(103, 595);
  a.height = b.height = 600;
  a.slot = b.slot = 5_000; // the finalized bank the height came from
  a.statusSlot = b.statusSlot = 4_960; // a node 40 slots behind it answers the statuses and the blockhash
  a.valid = b.valid = false;
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 12_000 });
  await advance(12_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

test("Medium 1: a history read from a bank behind the one that read the blockhash as expired never counts toward dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(110, 595);
  a.height = b.height = 600;
  a.slot = b.slot = 5_000;
  a.validSlot = b.validSlot = 6_000; // a node ahead answered isBlockhashValid
  a.statusSlot = b.statusSlot = 5_500; // a node behind it answers the statuses
  a.valid = b.valid = false;
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 12_000 });
  await advance(12_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

test("Medium 1: the same reads at or above the height's slot do make it dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(104, 595);
  a.height = b.height = 600;
  a.slot = b.slot = 5_000;
  a.statusSlot = b.statusSlot = 5_000;
  a.valid = b.valid = false;
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 12_000 });
  await advance(12_000);
  assert.equal((await h.done).txs[0]!.state, "expired");
});

test("Medium 2: a lowered lastValidBlockHeight never makes a live tx dead: isBlockhashValid still true on either provider", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, a, b, opts } = setup();
  const one = tx(105, 500); // the caller claims 500
  a.height = b.height = 600; // both finalized heights are past the claim
  a.valid = b.valid = true; // but the blockhash is still valid at processed on both
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 24_000 });
  await advance(SOLANA_REBROADCAST_MS * 2);
  const mid = paths[2]!.calls.length;
  await advance(SOLANA_REBROADCAST_MS * 2);
  assert.ok(paths[2]!.calls.length > mid, "the rebroadcast goes on while the blockhash is valid");
  b.valid = false; // one provider's word is not enough
  await advance(SOLANA_REBROADCAST_MS * 2);
  const mid2 = paths[2]!.calls.length;
  await advance(SOLANA_REBROADCAST_MS * 2);
  assert.ok(paths[2]!.calls.length > mid2, "one provider's isBlockhashValid never stops the rebroadcast");
  await advance(12_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
  for (const p of [a, b]) {
    const v = p.calls.filter((c) => c.method === "isBlockhashValid");
    assert.ok(v.length > 0);
    assert.deepEqual(v[0]!.params, [BLOCKHASH, { commitment: "processed" }]);
  }
});

test("Medium 3 (R3): on a 1-rps path each tx of a set of 3 is admitted within 4 s; the other paths get every tx every tick", async (t) => {
  t.after(() => mock.timers.reset());
  const { paths, opts } = setup();
  let windowStart = -Infinity;
  const admitted = new Map<string, number>();
  const sent: string[] = [];
  const oneRps: SolanaSendPath = {
    name: "sender",
    minIntervalMs: 1_000,
    send: async (b64) => {
      sent.push(b64);
      const now = Date.now();
      if (now - windowStart < 1_000) throw new Error("HTTP 429");
      windowStart = now;
      admitted.set(b64, (admitted.get(b64) ?? 0) + 1);
      return base58.encode(base64.decode(b64).subarray(1, 65));
    },
  };
  const set = [tx(106), tx(107), tx(108)];
  const h = sendSolanaSet(set, { ...opts, paths: [oneRps, ...opts.paths.slice(2)] });
  assert.deepEqual(sent, [base64.encode(set[0]!.wire)], "the 1-rps path gets the first tx in the first tick");
  assert.equal(paths[2]!.calls.length, 3, "an unlimited path gets the whole set in the first tick");
  await advance(4_000);
  const counts = set.map((s) => admitted.get(base64.encode(s.wire)) ?? 0);
  assert.ok(counts.every((n) => n >= 1), `admitted per tx in 4 s: ${counts}`);
  assert.equal(sent.length - [...admitted.values()].reduce((x, y) => x + y, 0), 0, "nothing was refused for rate");
  h.stop();
  await h.done;
});

test("a provider answering 429 is backed off, and a 429 stays no answer", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts, b } = setup();
  let calls = 0;
  const limited: SolanaRpc = async () => { calls++; throw new Error("HTTP 429"); };
  const h = sendSolanaSet([tx(109)], { ...opts, providers: [limited, b.rpc], deadlineMs: 20_000 });
  b.set(sigOf(tx(109)), OK);
  await advance(20_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
  assert.ok(calls <= 12, `${calls} calls in 20 s on a provider answering 429 (25 a second-free poll would be 60+)`);
});

test("a provider that once read the tx landed never calls it dead, even when a later history read has none", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const one = tx(111, 500);
  a.set(sigOf(one), OK); // A reads it landed in the first poll
  const h = sendSolanaSet([one], { ...opts, deadlineMs: 20_000 });
  await advance(SOLANA_STATUS_POLL_MS * 2);
  a.set(sigOf(one), null); // then a node with no transaction history answers for A
  a.height = b.height = 600;
  a.valid = b.valid = false;
  await advance(20_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

// ---- the Opus re-check of 8bdcb6c (N1 ported from its repro2)

test("Medium (N1): a false isBlockhashValid from a provider that never read the hash as valid is not expiry", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  // Agave answers false for a hash its bank does not hold at all (blockhash_queue.rs:98-108 at v4.3.2), the same as
  // for an expired one: a node a few slots behind the fresh hash's block answers false. B is hostile.
  const honestA: SolanaRpc = async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") return { context: { slot: 2_090 }, value: false };
    if (method === "getSignatureStatuses") return { context: { slot: 2_110 }, value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  };
  const hostileB: SolanaRpc = async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") return { context: { slot: 1_000 }, value: false };
    if (method === "getSignatureStatuses") return { context: { slot: 9_999 }, value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  };
  const h = sendSolanaSet([tx(121, 500)], { ...opts, providers: [honestA, hostileB], deadlineMs: 10_000 });
  await advance(10_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

test("Medium (N1 control): valid at slot 1500, then false at 2500, on both providers, is expiry", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const seen = [0, 0];
  const prov = (k: 0 | 1): SolanaRpc => async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") return seen[k]!++ === 0 ? { context: { slot: 1_500 }, value: true } : { context: { slot: 2_500 }, value: false };
    if (method === "getSignatureStatuses") return { context: { slot: 2_600 }, value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  };
  const h = sendSolanaSet([tx(122, 500)], { ...opts, providers: [prov(0), prov(1)], deadlineMs: 10_000 });
  await advance(10_000);
  assert.equal((await h.done).txs[0]!.state, "expired");
});

test("Medium: the blockhash is read from the first dead cycle on, before the height is past", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const h = sendSolanaSet([tx(123, 5_000)], { ...opts, deadlineMs: 3_000 }); // heights 0: far from past
  await advance(3_000);
  await h.done;
  for (const p of [a, b]) assert.ok(p.calls.some((c) => c.method === "isBlockhashValid"), "isBlockhashValid read at the first cycle");
});

test("a valid answer from a bank above the later false one does not make it valid-then-expired", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const seen = [0, 0];
  const prov = (k: 0 | 1): SolanaRpc => async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") return seen[k]!++ === 0 ? { context: { slot: 3_000 }, value: true } : { context: { slot: 2_500 }, value: false };
    if (method === "getSignatureStatuses") return { context: { slot: 2_600 }, value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  };
  const h = sendSolanaSet([tx(124, 500)], { ...opts, providers: [prov(0), prov(1)], deadlineMs: 10_000 });
  await advance(10_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

// ---- the 1-rps lanes, through solanaSendPaths' own Sender and Jito objects and a fake fetch that refuses a second
// request to one URL within 1 s (Helius and Jito count refused requests too)
function oneRpsFetch() {
  const last = new Map<string, number>();
  const log: { url: string; at: number; b64: string; ok: boolean }[] = [];
  const fetchFn = (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; params: [string] };
    const now = Date.now();
    const limited = url === SOLANA_SENDER_FAST_URL || url === SOLANA_JITO_TRANSACTIONS_URL;
    const ok = !limited || now - (last.get(url) ?? -Infinity) >= 1_000;
    if (limited) last.set(url, now);
    log.push({ url, at: now, b64: body.params[0], ok });
    if (!ok) return Promise.resolve(new Response("{}", { status: 429 }));
    const sig = base58.encode(base64.decode(body.params[0]).subarray(1, 65));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sig })));
  };
  return { fetchFn, log };
}

test("solanaSendPaths' Sender and Jito through sendSolanaSet on a 1-rps fake: no refusal, every tx on both within 4 s, never the same tx in the same second", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const { fetchFn, log } = oneRpsFetch();
  const set = [tx(131), tx(132), tx(133)];
  const h = sendSolanaSet(set, { ...opts, paths: solanaSendPaths({ fetch: fetchFn }) });
  await advance(4_000);
  h.stop();
  await h.done;
  await advance(1_000); // the shared URL pacers leave the map before the fake clock is reset
  const lane = (u: string) => log.filter((l) => l.url === u);
  for (const u of [SOLANA_SENDER_FAST_URL, SOLANA_JITO_TRANSACTIONS_URL]) {
    assert.ok(lane(u).every((l) => l.ok), `${u}: nothing refused`);
    for (const s of set) assert.ok(lane(u).some((l) => l.b64 === base64.encode(s.wire)), `${u} carried every tx`);
  }
  for (const s of lane(SOLANA_SENDER_FAST_URL)) {
    const j = lane(SOLANA_JITO_TRANSACTIONS_URL).find((l) => Math.floor(l.at / 1_000) === Math.floor(s.at / 1_000));
    if (j) assert.notEqual(j.b64, s.b64, `second ${Math.floor(s.at / 1_000)}: Sender and Jito carry different txs`);
  }
});

test("two sets at once on the same 1-rps URLs stay at 1 request a second per URL together", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const { fetchFn, log } = oneRpsFetch();
  const h1 = sendSolanaSet([tx(141), tx(142)], { ...opts, paths: solanaSendPaths({ fetch: fetchFn }) });
  const h2 = sendSolanaSet([tx(143), tx(144)], { ...opts, paths: solanaSendPaths({ fetch: fetchFn }) });
  await advance(6_000);
  h1.stop();
  h2.stop();
  await Promise.all([h1.done, h2.done]);
  await advance(1_000); // the shared URL pacers leave the map before the fake clock is reset
  for (const u of [SOLANA_SENDER_FAST_URL, SOLANA_JITO_TRANSACTIONS_URL]) {
    const at = log.filter((l) => l.url === u).map((l) => l.at);
    assert.ok(log.filter((l) => l.url === u).every((l) => l.ok), `${u}: nothing refused`);
    assert.ok(at.length >= 5, `${u} kept sending: ${at.length}`);
    for (const x of [141, 142, 143, 144]) assert.ok(log.some((l) => l.url === u && l.b64 === base64.encode(tx(x).wire)), `${u} carried tx ${x}`);
  }
});

test("a later valid read clears an earlier expired one: a provider that reads the hash valid again is not dead", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const seen = [0, 0];
  const answers = [{ slot: 1_500, value: true }, { slot: 2_500, value: false }];
  const prov = (k: 0 | 1): SolanaRpc => async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") {
      const n = seen[k]!++;
      // A: valid, expired, then valid again from the next bank on (a fork, or a node ahead). B: valid twice, then
      // expired. Without the clear, A's one expired read and B's later one would together make it dead.
      const a = k === 0 ? (n < 2 ? answers[n]! : { slot: 2_600, value: true }) : n < 2 ? answers[0]! : answers[1]!;
      return { context: { slot: a.slot }, value: a.value };
    }
    if (method === "getSignatureStatuses") return { context: { slot: 2_700 }, value: (params[0] as string[]).map(() => null) };
    throw new Error(method);
  };
  const h = sendSolanaSet([tx(125, 500)], { ...opts, providers: [prov(0), prov(1)], deadlineMs: 12_000 });
  await advance(12_000);
  assert.equal((await h.done).txs[0]!.state, "unknown");
});

// ---- the Opus round 3 review of 2dc2cc2 (L-a ported from its repro3 and repro3c)

function laProvider(refuseValid: boolean): SolanaRpc {
  // Both status caches have dropped the landing (a phone suspended for over 64 s); the history has it.
  return async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 1_000 }, value: { blockhash: "f", lastValidBlockHeight: 750 } };
    if (method === "isBlockhashValid") {
      if (refuseValid) throw new Error("HTTP 400"); // the deployed helper's method_not_allowed, until its allowlist is redeployed
      return { context: { slot: 2_000 }, value: false };
    }
    if (method === "getSignatureStatuses") {
      const hist = (params[1] as { searchTransactionHistory?: boolean }).searchTransactionHistory;
      return { context: { slot: 2_000 }, value: (params[0] as string[]).map(() => (hist ? FIN : null)) };
    }
    throw new Error(method);
  };
}

test("Low (L-a): a refused isBlockhashValid is no answer, and that cycle's history read still runs: the filled tx ends filled", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const h = sendSolanaSet([tx(151, 500)], { ...opts, providers: [laProvider(false), laProvider(true)], deadlineMs: 10_000 });
  await advance(10_000);
  assert.equal((await h.done).txs[0]!.state, "filled");
});

test("Low (L-a control): with isBlockhashValid answered on both, the same tx ends filled", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const h = sendSolanaSet([tx(152, 500)], { ...opts, providers: [laProvider(false), laProvider(false)], deadlineMs: 10_000 });
  await advance(10_000);
  assert.equal((await h.done).txs[0]!.state, "filled");
});

test("Low: a pacer leaves the map once its last set is done and its interval has passed (a fresh path object per trade)", async (t) => {
  t.after(() => mock.timers.reset());
  const { opts } = setup();
  const count = (kit as { solanaSendPacerCount?: () => number }).solanaSendPacerCount;
  assert.equal(typeof count, "function", "solanaSendPacerCount is exported");
  const before = count!();
  for (let n = 0; n < 3; n++) {
    const fresh: SolanaSendPath = { name: "custom", minIntervalMs: 1_000, send: async (b64) => base58.encode(base64.decode(b64).subarray(1, 65)) };
    const h = sendSolanaSet([tx(153 + n)], { ...opts, paths: [fresh, ...opts.paths] });
    assert.equal(count!(), before + 1, "the running set's pacer is held");
    await advance(1_500);
    h.stop();
    await h.done;
    await advance(1_000); // its last request plus one interval
    assert.equal(count!(), before, `after set ${n}, its pacer is gone`);
  }
});

// ---- one signature a status request (the wallet paper's request table, row 8: one address per request; each
// signature names its fee payer, one of the user's wallets), spread over the poll, within the provider's rate
const statusCalls = (p: FakeProvider) => p.calls.map((c, k) => ({ ...c, k })).filter((c) => c.method === "getSignatureStatuses");

test("every status read carries one signature, on both providers, for the fill poll and the history read", async (t) => {
  t.after(() => mock.timers.reset());
  const { a, b, opts } = setup();
  const set = [tx(91), tx(92), tx(93)];
  a.height = 2_000; // past every tx's lastValidBlockHeight, so the dead check reads the history too
  b.height = 2_000;
  const h = sendSolanaSet(set, { ...opts, deadlineMs: 6_000 });
  await advance(6_000);
  await h.done;
  for (const p of [a, b]) {
    const calls = statusCalls(p);
    assert.ok(calls.some((c) => (c.params[1] as { searchTransactionHistory?: boolean }).searchTransactionHistory === true), "a history read ran");
    assert.ok(calls.length >= 6, `${calls.length} status reads`);
    for (const c of calls) assert.equal((c.params[0] as string[]).length, 1, "one signature a request");
    for (const s of set) assert.ok(calls.some((c) => (c.params[0] as string[])[0] === sigOf(s)), "every tx is read");
  }
});

test("the fill poll is spread over the interval: one tx a call, in turn, never two calls in the same tick", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  const at: number[] = [];
  const rpc: SolanaRpc = async (m, p) => { if (m === "getSignatureStatuses") at.push(Date.now()); return a.rpc(m, p); };
  const set = [tx(94), tx(95), tx(96)];
  // a fast keyed provider (100 a second), so the spread is pollMs / 3, not the rate's gap
  const h = sendSolanaSet(set, { paths: [path("rpc").path], providers: [rpc, b.rpc], pollMs: 300, rebroadcastMs: 60_000, deadlineMs: 3_000, providerRps: [100, 100] });
  for (let ms = 0; ms < 3_000; ms += 10) { mock.timers.tick(10); await flush(); }
  await h.done;
  assert.ok(at.length >= 20, `${at.length} reads`);
  const gaps = at.slice(1).map((x, i) => x - at[i]!);
  assert.ok(gaps.every((g) => g >= 90), `gaps ${gaps.join(",")}`);
  const sigs = statusCalls(a).map((c) => (c.params[0] as string[])[0]);
  assert.deepEqual(sigs.slice(0, 6), [...set, ...set].map(sigOf), "in turn");
});

test("a keyless provider stays within its published limit: 100 calls in any 10 s, 40 of one method", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  const at: { t: number; m: string }[] = [];
  const rpc: SolanaRpc = async (m, p) => { at.push({ t: Date.now(), m }); return a.rpc(m, p); };
  a.height = 2_000;
  const set = [tx(97), tx(98), tx(99), tx(100), tx(101)];
  const h = sendSolanaSet(set, { paths: [path("rpc").path], providers: [rpc, b.rpc], deadlineMs: 25_000 });
  for (let ms = 0; ms < 25_000; ms += 10) { mock.timers.tick(10); await flush(); }
  await h.done;
  const L = kit.SOLANA_KEYLESS_RPC_LIMIT;
  assert.ok(at.filter((c) => c.m === "getSignatureStatuses").length > L.perMethod, `${at.length} calls`);
  for (const x of at) {
    const win = at.filter((y) => y.t >= x.t && y.t < x.t + L.windowMs);
    assert.ok(win.length <= L.total, `${win.length} calls in the 10 s from ${x.t} ms`);
    assert.ok(win.filter((y) => y.m === x.m).length <= L.perMethod, `${x.m} over its limit from ${x.t} ms`);
  }
});

const perSecond = (at: readonly number[]): number => Math.max(0, ...at.map((x) => at.filter((y) => y >= x && y < x + 1_000).length));

test("one queue a provider: two sets in flight on it stay within its rate together", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  const at: number[] = [];
  const rpc: SolanaRpc = async (m, p) => { at.push(Date.now()); return a.rpc(m, p); };
  a.height = 2_000;
  const opts = { paths: [path("rpc").path], providers: [rpc, b.rpc] as const, deadlineMs: 5_000, providerRps: [5, 5] as const };
  const h1 = sendSolanaSet([tx(110), tx(111), tx(112)], opts);
  const h2 = sendSolanaSet([tx(113), tx(114), tx(115)], opts);
  for (let ms = 0; ms < 5_000; ms += 10) { mock.timers.tick(10); await flush(); }
  await Promise.all([h1.done, h2.done]);
  assert.ok(at.length >= 20, `${at.length} calls`);
  assert.ok(perSecond(at) <= 5, `${perSecond(at)} calls in one second`);
});

test("one queue a provider: another caller's reads through solanaPacedRpc and a set share it, first come first served", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  const at: { t: number; m: string }[] = [];
  const rpc: SolanaRpc = async (m, p) => { at.push({ t: Date.now(), m }); return a.rpc(m, p); };
  a.height = 2_000;
  const paced = kit.solanaPacedRpc(rpc, kit.solanaRpsLimit(5));
  assert.equal(kit.solanaPacedRpc(paced, kit.solanaRpsLimit(5)).length, paced.length);
  const reads = Array.from({ length: 10 }, () => paced("getMinimumBalanceForRentExemption", [165]).catch(() => null));
  const h = sendSolanaSet([tx(116), tx(117)], { paths: [path("rpc").path], providers: [paced, b.rpc], deadlineMs: 5_000, providerRps: [5, 5] });
  for (let ms = 0; ms < 5_000; ms += 10) { mock.timers.tick(10); await flush(); }
  await Promise.all([h.done, ...reads]);
  const ts = at.map((c) => c.t);
  assert.ok(perSecond(ts) <= 5, `${perSecond(ts)} calls in one second`);
  // the ten reads asked first go first, two seconds of the rate; the set's calls queue behind them
  assert.deepEqual(at.slice(0, 10).map((c) => c.m), Array(10).fill("getMinimumBalanceForRentExemption"));
  assert.ok(at.length > 12);
});

test("one queue a provider, first in first out per method: while the status budget is spent, another method's call goes at once", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const at: { t: number; m: string }[] = [];
  const rpc = Object.assign(async (m: string) => { at.push({ t: Date.now(), m }); return null; }, { url: "https://fifo.example" }) as SolanaRpc;
  const paced = kit.solanaPacedRpc(rpc);
  const L = kit.SOLANA_KEYLESS_RPC_LIMIT;
  const statuses = Array.from({ length: L.perMethod + 1 }, () => paced("getSignatureStatuses", [["x"]]));
  const read = paced("getMultipleAccounts", [["y"]]);
  await flush();
  assert.equal(at.filter((c) => c.m === "getSignatureStatuses").length, L.perMethod, "the status budget is spent, its next call waits for the window");
  assert.deepEqual(at.filter((c) => c.m === "getMultipleAccounts").map((c) => c.t), [0], "the other method starts at once");
  for (let ms = 0; ms <= L.windowMs + 10; ms += 10) { mock.timers.tick(10); await flush(); }
  await Promise.all([...statuses, read]);
  assert.equal(at.length, L.perMethod + 2);
});

test("a set unlanded and not yet expired for 25 s on a keyless provider: alone, the fill poll reads at the rate the budget allows and books no later turn, so no other read on the provider waits", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  a.height = 500; // under the txs' lastValidBlockHeight: undecided, no history read
  const at: { t: number; m: string }[] = [];
  const rpc = Object.assign(async (m: string, p: readonly unknown[]) => { at.push({ t: Date.now(), m }); return m === "getMultipleAccounts" ? { context: { slot: 1 }, value: [null] } : a.rpc(m, p); }, { url: "https://undecided.example" }) as SolanaRpc;
  const paced = kit.solanaPacedRpc(rpc);
  const h = sendSolanaSet([tx(130), tx(131), tx(132)], { paths: [path("rpc").path], providers: [rpc, b.rpc], deadlineMs: 25_000 });
  // another caller reads the same provider once a second all along: each starts in the tick it asks
  const waited: number[] = [];
  for (let ms = 0; ms < 25_000; ms += 10) {
    if (ms % 1_000 === 500) { const t0 = Date.now(); void paced("getMultipleAccounts", [["z"]]).then(() => waited.push(Date.now() - t0)); }
    mock.timers.tick(10);
    await flush();
  }
  await h.done;
  const L = kit.SOLANA_KEYLESS_RPC_LIMIT;
  assert.ok(waited.length >= 24 && waited.every((w) => w <= 10), `other reads waited ${waited.join(",")} ms`);
  const st = at.filter((c) => c.m === "getSignatureStatuses").map((c) => c.t);
  assert.equal(st.filter((x) => x < L.windowMs).length, L.perMethod, "alone, the whole budget of the first window is read");
  for (const x of at) {
    const win = at.filter((y) => y.t >= x.t && y.t < x.t + L.windowMs);
    assert.ok(win.length <= L.total && win.filter((y) => y.m === x.m).length <= L.perMethod, `over the limit from ${x.t} ms`);
  }
});

test("while another caller's status read waits on the provider, it goes at the first turn the limit allows: the fill poll never takes it", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  a.height = 500;
  const at: { t: number; who: string }[] = [];
  const rpc = Object.assign(async (m: string, p: readonly unknown[]) => { if (m === "getSignatureStatuses") at.push({ t: Date.now(), who: (p[0] as string[])[0] === "other" ? "other" : "set" }); return m === "getSignatureStatuses" && (p[0] as string[])[0] === "other" ? { context: { slot: 1 }, value: [null] } : a.rpc(m, p); }, { url: "https://other-waits.example" }) as SolanaRpc;
  const paced = kit.solanaPacedRpc(rpc);
  const h = sendSolanaSet([tx(140), tx(141), tx(142)], { paths: [path("rpc").path], providers: [rpc, b.rpc], deadlineMs: 16_000 });
  const L = kit.SOLANA_KEYLESS_RPC_LIMIT;
  let other: Promise<unknown> | null = null;
  for (let ms = 0; ms < 16_000; ms += 10) {
    if (ms === 6_000) other = paced("getSignatureStatuses", [["other"]]);
    mock.timers.tick(10);
    await flush();
  }
  await h.done;
  await other;
  const set = at.filter((c) => c.who === "set").map((c) => c.t);
  const first = set[0]!;
  const went = at.find((c) => c.who === "other")!.t;
  assert.ok(went <= first + L.windowMs + 20, `the other caller's read went at ${went} ms, the first turn is ${first + L.windowMs + 1} ms`);
  assert.equal(set.filter((x) => x > 6_000 && x < went).length, 0, "no fill read took its turn");
});

test("one URL, several limits: a providerRps 4 set beside a keyless wrapper and the RPC send path on the same URL stays at 4 a second", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const U = "https://one-url-many-limits.example";
  const a = provider();
  const b = provider();
  a.height = 2_000;
  const at: { t: number; m: string }[] = [];
  const rpcA = Object.assign(async (m: string, p: readonly unknown[]) => { at.push({ t: Date.now(), m }); return a.rpc(m, p); }, { url: U }) as SolanaRpc;
  // another object for the same URL, as another caller holds it
  const other = Object.assign(async (m: string, p: readonly unknown[]) => { at.push({ t: Date.now(), m }); return a.rpc(m, p); }, { url: U }) as SolanaRpc;
  const fakeFetch = (_url: string, init: RequestInit) => {
    at.push({ t: Date.now(), m: "sendTransaction" });
    const body = JSON.parse(String(init.body)) as { id: string; params: [string] };
    const sig = base58.encode(base64.decode(body.params[0]).subarray(1, 65));
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: sig }), { headers: { "content-type": "application/json" } }));
  };
  // the keyless wrapper is made first, so the keyless limit is named on the URL before the set names 4 a second
  const wrapped = kit.solanaPacedRpc(other);
  const rpcPath = solanaSendPaths({ rpcUrl: U, fetch: fakeFetch }).find((p) => p.name === "rpc")!;
  const h = sendSolanaSet([tx(133), tx(134)], { paths: [rpcPath], providers: [rpcA, b.rpc], deadlineMs: 6_000, providerRps: [4, undefined] });
  const reads = Array.from({ length: 12 }, () => wrapped("getMinimumBalanceForRentExemption", [165]).catch(() => null));
  for (let ms = 0; ms < 6_000; ms += 10) { mock.timers.tick(10); await flush(); }
  await Promise.all([h.done, ...reads]);
  const ts = at.map((c) => c.t);
  assert.ok(at.some((c) => c.m === "sendTransaction") && at.filter((c) => c.m === "getMinimumBalanceForRentExemption").length === 12, "every caller ran");
  assert.ok(perSecond(ts) <= 4, `${perSecond(ts)} calls in one second on the URL`);
});

test("the dry run through a direct caller's bare providers is paced: 1 a second simulates a set of 3 one a second", async (t) => {
  t.after(() => mock.timers.reset());
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  const a = provider();
  const b = provider();
  const at: number[] = [];
  const rpc: SolanaRpc = async (m, p) => { at.push(Date.now()); return a.rpc(m, p); };
  const d = dryRunSolanaSet([tx(135), tx(136), tx(137)], { paths: [path("rpc").path], providers: [rpc, b.rpc], providerRps: [1, 1] });
  for (let ms = 0; ms < 4_000; ms += 10) { mock.timers.tick(10); await flush(); }
  const r = await d;
  assert.equal(r.txs.length, 3);
  assert.equal(at.length, 3);
  assert.ok(perSecond(at) <= 1, `${perSecond(at)} simulations in one second`);
});

test("a lone set of 9 landing at 2.5 s, 120 ms a call: filled within 2 s of landing, on fresh keyless providers", async () => {
  const RTT = 120;
  const L = 2_500;
  const a = provider();
  const b = provider();
  const slow = (f: SolanaRpc, url: string): SolanaRpc => Object.assign(async (m: string, p: readonly unknown[]) => { await new Promise((r) => setTimeout(r, RTT)); return f(m, p); }, { url }) as SolanaRpc;
  const set = Array.from({ length: 9 }, (_, i) => tx(150 + i, 5_000));
  const t0 = Date.now();
  const land = setTimeout(() => { for (const t of set) for (const p of [a, b]) p.set(sigOf(t), { confirmationStatus: "confirmed", err: null, slot: 1_990 }); }, L);
  const u = Math.random().toString(36).slice(2);
  const r = await sendSolanaSet(set, { paths: [path("rpc").path], providers: [slow(a.rpc, `https://fill-a-${u}.example/`), slow(b.rpc, `https://fill-b-${u}.example/`)], deadlineMs: 30_000 }).done;
  clearTimeout(land);
  const after = Date.now() - t0 - L;
  assert.equal(r.txs.filter((x) => x.state === "filled").length, 9);
  assert.ok(after < 2_000, `filled ${after} ms after landing`);
});
