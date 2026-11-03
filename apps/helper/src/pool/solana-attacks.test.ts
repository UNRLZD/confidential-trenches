// node --test apps/helper/src/pool/solana-attacks.test.ts: the review of a514150 (M356 (1), (2), item 9) and its
// surviving mutants S8, S13 and S14. Each case is a release W signed with every other field good: only the named field
// is off, and the refusal comes before any read unless the case says the read is the check (a lookup table). Test keys
// only: ed25519 of sha256("helper-pool-senders/attack/<name>").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  SOLANA_ALT_PROGRAM,
  SOLANA_COMPUTE_BUDGET_PROGRAM,
  SOLANA_JITO_TIP_ACCOUNTS,
  solanaPoolStepPrograms,
  SOLANA_SYSTEM_PROGRAM,
  SOLANA_TOKEN_2022_PROGRAM,
  solanaCompileV0,
  solanaDecodeLookupTable,
  solanaEncodePoolRelease,
  solanaEncodePoolTag3,
  solanaPoolAccount,
  solanaPoolReleaseAccounts,
  type SolanaApiAccount,
  type SolanaApiInstruction,
  type SolanaPoolRelease,
  type SolanaRpc,
  type SolanaSendPath,
} from "@blindfill/kit";
import { base58 } from "../bind/checks.ts";
import { POOL_EPOCH_MS } from "./fee.ts";
import { solanaPoolPriorityBudget, type SolanaRent } from "@blindfill/kit";
import { checkSolanaPoolTx, solanaPoolSender, type PoolSendAnswer } from "./solana.ts";
import { jitoSender, SOLANA_JITO_BLOCK_ENGINES, type JitoFetch } from "./jito.ts";

const key = (n: string) => {
  const seed = new Uint8Array(createHash("sha256").update(`helper-pool-senders/attack/${n}`).digest());
  const pub = ed25519.getPublicKey(seed);
  return { seed, address: base58(pub), secret: base58(Uint8Array.from([...seed, ...pub])) };
};
const FP = key("FP");
const W = key("W");
const PROGRAM = key("PROGRAM").address;
const POOL = solanaPoolAccount(PROGRAM);
const ATTACKER = key("ATTACKER_PROGRAM").address; // a program W deployed: passes simulation, fails on chain
const TO = key("TO").address;
const BH = key("BH").address;
const TABLE = key("TABLE").address;
const MAINNET: SolanaRent = { lamportsPerByte: 5_080n, factor: 1n };
const FEE = 1_300_000n; // the kit's fee at mainnet rent (M355)
const NOW = 1_800_000_000_000;
const CFG = { program: PROGRAM, pool: POOL, feePayer: FP.address, fee: FEE, budget: solanaPoolPriorityBudget(MAINNET, FEE), nowMs: NOW };
const u32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u64 = (n: bigint) => Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
const cuLimit = (n: number): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([2, ...u32(n)]) });
const cuPrice = (n: bigint): SolanaApiInstruction => ({ program: SOLANA_COMPUTE_BUDGET_PROGRAM, accounts: [], data: Uint8Array.from([3, ...u64(n)]) });
const f32 = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const rel = (o: Partial<SolanaPoolRelease> = {}): SolanaPoolRelease => ({
  proof: new Uint8Array(256).fill(7), newCommitmentHash: f32(1), existingNullifierHash: f32(2), withdrawnValue: 50_000_000n,
  stateRootIndex: 5, stateTreeDepth: 3, labelRootIndex: 5, labelTreeDepth: 3, relayFee: FEE, relayFeeCap: FEE, tipCap: 10_000n,
  deadlineMs: BigInt(NOW + 270_000), salt: new Uint8Array(16).fill(9), ...o,
});
/** A lookup table's account data: the 56-byte meta (type 1, never deactivated unless `deactivated`), then the keys. */
const tableData = (keys: string[], deactivated = false): Uint8Array => {
  const meta = new Uint8Array(56);
  const dv = new DataView(meta.buffer);
  dv.setUint32(0, 1, true);
  dv.setBigUint64(4, deactivated ? 5n : (1n << 64n) - 1n, true);
  return Uint8Array.from([...meta, ...keys.flatMap((k) => [...base58decodeKey(k)])]);
};
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58decodeKey(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

type Opt = {
  /** load these keys each from its own table instead (one table per key) */
  tables?: string[];
  r?: Partial<SolanaPoolRelease>;
  /** tag 3: the inner instruction's program key (account 8) */
  inner?: string;
  pre?: SolanaApiInstruction[];
  /** keys loaded from TABLE instead of static */
  table?: string[];
  /** replace the pool instruction's accounts before compiling */
  accounts?: (a: SolanaApiAccount[]) => SolanaApiAccount[];
  /** the tag 3 inner instruction's account and program indexes */
  innerIx?: { program: number; accounts: number[] };
  /** edit the message bytes before W signs */
  edit?: (m: Uint8Array) => void;
  /** tag 3: a Jito tip, paid to `tipTo` (account 8, before the inner program and TO) */
  tip?: bigint;
  tipTo?: string;
};
function wire(o: Opt = {}): Uint8Array {
  const r = rel(o.r);
  let accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, r, 6);
  let data: Uint8Array;
  if (o.inner === undefined && o.innerIx === undefined) data = solanaEncodePoolRelease(r);
  else {
    const tipped = o.tip !== undefined && o.tip > 0n;
    if (tipped) accounts.push({ key: o.tipTo ?? SOLANA_JITO_TIP_ACCOUNTS[0]!, signer: false, writable: true });
    accounts.push({ key: o.inner ?? SOLANA_SYSTEM_PROGRAM, signer: false, writable: false }, { key: TO, signer: false, writable: true });
    const transfer = Uint8Array.from([2, 0, 0, 0, ...u64(1_000n)]);
    data = solanaEncodePoolTag3(r, false, o.tip ?? 0n, [{ ...(o.innerIx ?? (tipped ? { program: 9, accounts: [1, 10] } : { program: 8, accounts: [1, 9] })), data: transfer }]);
  }
  if (o.accounts) accounts = o.accounts(accounts);
  const tables = o.table
    ? [{ address: TABLE, table: solanaDecodeLookupTable(tableData(o.table)) }]
    : (o.tables ?? []).map((k, i) => ({ address: key(`TABLE_${i}`).address, table: solanaDecodeLookupTable(tableData([k])) }));
  const { message } = solanaCompileV0(FP.address, [...(o.pre ?? [cuLimit(400_000), cuPrice(1_000n)]), { program: PROGRAM, accounts, data }], BH, tables, [FP.address, W.address]);
  o.edit?.(message);
  return Uint8Array.from([2, ...new Uint8Array(64), ...ed25519.sign(message, W.seed), ...message]);
}
const verdict = (w: Uint8Array, nowMs = NOW) => {
  const c = checkSolanaPoolTx(w, { ...CFG, nowMs });
  return c.ok ? "ok" : c.code;
};

type Calls = string[];
const stub = (calls: Calls, tables: Record<string, Uint8Array | null> = {}): SolanaRpc =>
  Object.assign(
    async (m: string, p: readonly unknown[]) => {
      calls.push(m);
      if (m === "simulateTransaction") return { context: { slot: 1 }, value: { err: null } };
      if (m === "getLatestBlockhash") return { context: { slot: 1 }, value: { blockhash: BH, lastValidBlockHeight: 1000 } };
      if (m === "getAccountInfo") {
        const d = tables[p[0] as string];
        return { context: { slot: 1 }, value: d ? { owner: SOLANA_ALT_PROGRAM, data: [Buffer.from(d).toString("base64"), "base64"] } : null };
      }
      throw new Error(m);
    },
    { url: `https://stub.invalid/${Math.random()}` },
  );
function sender(o: { a?: Calls; tablesA?: Record<string, Uint8Array | null>; tablesB?: Record<string, Uint8Array | null>; sent?: Uint8Array[]; end?: string; now?: () => number } = {}) {
  return solanaPoolSender(
    { cluster: "devnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) },
    {
      providers: [stub(o.a ?? [], o.tablesA), stub([], o.tablesB ?? o.tablesA)],
      now: o.now ?? (() => NOW),
      readRent: async () => MAINNET,
      send: (set) => {
        o.sent?.push(set[0]!.wire);
        const sig = base58(set[0]!.wire.subarray(1, 65));
        return { signatures: [sig], done: Promise.resolve({ txs: [{ signature: sig, state: (o.end ?? "filled") as "filled", sends: [] }] }), stop() {} };
      },
    },
  );
}
const body = (w: Uint8Array) => ({ pool: POOL, tx: Buffer.from(w).toString("base64") });
const code = (a: PoolSendAnswer) => ("error" in a.body ? a.body.error.code : "ok");

test("A1: a tag 3 inner instruction invoking a program off the kit's list is refused before any read (inner_program)", async () => {
  assert.equal(verdict(wire({ inner: ATTACKER })), "inner_program");
  for (const p of solanaPoolStepPrograms()) assert.equal(verdict(wire({ inner: p })), "ok", p);
  const calls: Calls = [];
  assert.equal(code(await sender({ a: calls }).carry(body(wire({ inner: ATTACKER })))), "inner_program");
  assert.deepEqual(calls, []);
});

test("M362 (1): a tag 3 inner step invoking Token-2022 (a transfer that runs the mint's hook) is refused before any read (inner_program)", async () => {
  assert.equal(verdict(wire({ inner: SOLANA_TOKEN_2022_PROGRAM })), "inner_program");
  const calls: Calls = [];
  assert.equal(code(await sender({ a: calls }).carry(body(wire({ inner: SOLANA_TOKEN_2022_PROGRAM })))), "inner_program");
  assert.deepEqual(calls, []);
});

test("M362 (5): a tag 2 W signed with a 9th account is refused before any read (not_pool)", async () => {
  const nine = wire({ accounts: (a) => [...a, { key: TO, signer: false, writable: false }] });
  assert.equal(verdict(nine), "not_pool");
  assert.equal(verdict(wire()), "ok");
  const calls: Calls = [];
  assert.equal(code(await sender({ a: calls }).carry(body(nine))), "not_pool");
  assert.deepEqual(calls, []);
});

test("A1, loaded: an inner program from a lookup table is checked once the table is read on both providers", async () => {
  const off = [ATTACKER, TO];
  const on = [SOLANA_SYSTEM_PROGRAM, TO];
  // a program invoked only inside tag 3 is an account of the pool instruction, so the compiler may load it
  const wOff = wire({ inner: ATTACKER, table: off });
  const c = checkSolanaPoolTx(wOff, CFG);
  assert.ok(c.ok && c.tx.message.lookups.length === 1, "loaded from the table, so the pure check passes it on");
  const calls: Calls = [];
  assert.equal(code(await sender({ a: calls, tablesA: { [TABLE]: tableData(off) } }).carry(body(wOff))), "inner_program");
  assert.ok(!calls.includes("simulateTransaction"), "refused before the simulation");
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData(on) } }).carry(body(wire({ inner: SOLANA_SYSTEM_PROGRAM, table: on })))), "ok");
});

test("item 9: a pool account loaded from a lookup table is checked at account 0 (not_pool), and a bad table is refused (bad_table)", async () => {
  const other = solanaPoolAccount(key("OTHER_PROGRAM").address);
  const swap = (a: SolanaApiAccount[]) => a.map((x, i) => (i === 0 ? { ...x, key: other } : x));
  const w = wire({ table: [other], accounts: swap });
  assert.equal(verdict(w), "ok", "a loaded pool needs its table");
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData([other]) } }).carry(body(w))), "not_pool");
  // our own pool, loaded: carried
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData([POOL]) } }).carry(body(wire({ table: [POOL] })))), "ok");
  // the providers disagree, the table is deactivated, or it is missing on one
  const w2 = wire({ table: [POOL] });
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData([POOL]) }, tablesB: { [TABLE]: tableData([other]) } }).carry(body(w2))), "bad_table");
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData([POOL], true) } }).carry(body(w2))), "bad_table");
  assert.equal(code(await sender({ tablesA: { [TABLE]: tableData([POOL]) }, tablesB: {} }).carry(body(w2))), "bad_table");
});

test("A2: a deadline past, or under now plus 90 s, is refused before any read (deadline_near)", async () => {
  assert.equal(verdict(wire({ r: { deadlineMs: 1n } })), "deadline_near");
  assert.equal(verdict(wire({ r: { deadlineMs: BigInt(NOW + 1_000) } })), "deadline_near");
  assert.equal(verdict(wire({ r: { deadlineMs: BigInt(NOW + 89_999) } })), "deadline_near");
  assert.equal(verdict(wire({ r: { deadlineMs: BigInt(NOW + 90_000) } })), "ok");
  const calls: Calls = [];
  assert.equal(code(await sender({ a: calls }).carry(body(wire({ r: { deadlineMs: 1n } })))), "deadline_near");
  assert.deepEqual(calls, []);
});

test("A3: a release that failed on chain is sent once per epoch, not again and again (failed_this_epoch)", async () => {
  const sent: Uint8Array[] = [];
  let now = NOW;
  const s = sender({ sent, end: "failed", now: () => now });
  const tx = wire({ inner: SOLANA_SYSTEM_PROGRAM });
  assert.equal(code(await s.carry(body(tx))), "ok");
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 24; i++) assert.equal(code(await s.carry(body(tx))), "failed_this_epoch");
  assert.equal(sent.length, 1, "one paid failure for the note in this epoch");
  now += POOL_EPOCH_MS;
  assert.equal(code(await s.carry(body(tx))), "ok");
  assert.equal(sent.length, 2, "the next epoch may try once more");
});

test("A4: 50 concurrent variants of one nullifier give one simulation and one send", async () => {
  const sent: Uint8Array[] = [];
  const calls: Calls = [];
  const s = sender({ a: calls, sent });
  const variants = Array.from({ length: 50 }, (_, i) => body(wire({ pre: [cuLimit(400_000), cuPrice(BigInt(i + 1))] })));
  await Promise.all(variants.map((b) => s.carry(b)));
  assert.equal(sent.length, 1);
  assert.equal(calls.filter((c) => c === "simulateTransaction").length, 1);
});

test("A5: W's priority fee is held to the kit's budget, which keeps the 715-lamport page reserve (fee_below_cost)", () => {
  const budget = solanaPoolPriorityBudget(MAINNET, FEE); // 1,300,000 - 1,066,640 - 715 = 232,645
  assert.equal(budget, 232_645n);
  const top = (budget * 1_000_000n) / 400_000n;
  assert.equal(verdict(wire({ pre: [cuLimit(400_000), cuPrice(top)] })), "ok");
  assert.equal(verdict(wire({ pre: [cuLimit(400_000), cuPrice(top + 1n)] })), "fee_below_cost");
});

test("A6: a compute unit price without a limit is refused before any read (no_cu_limit)", () => {
  assert.equal(verdict(wire({ pre: [cuPrice(370_000n)] })), "no_cu_limit");
  assert.equal(verdict(wire({ pre: [cuLimit(200_000), cuPrice(370_000n)] })), "ok");
  assert.equal(verdict(wire({ pre: [cuLimit(200_000)] })), "ok", "a limit alone prices nothing");
  assert.equal(verdict(wire({ pre: [] })), "ok");
});

test("S8: W signed as a read-only signer is refused (bad_shape), W's signature valid", () => {
  // the header's second byte counts read-only signers: 1 makes W (the last signer) read-only
  const w = wire({ edit: (m) => void (m[2] = 1) });
  assert.equal(verdict(w), "bad_shape");
  assert.equal(verdict(wire({ edit: () => {} })), "ok");
});

test("S13: a tag 3 inner index past the pool instruction's accounts is refused (not_pool), W's signature valid", () => {
  assert.equal(verdict(wire({ innerIx: { program: 8, accounts: [1, 10] } })), "not_pool");
  assert.equal(verdict(wire({ innerIx: { program: 10, accounts: [1, 9] } })), "not_pool");
  assert.equal(verdict(wire({ innerIx: { program: 8, accounts: [1, 9] } })), "ok");
});

test("S14: the pool instruction's account 1 not W is refused (bad_shape), W's signature valid", () => {
  // W still signs (a signer of the message, named at account 10), but the pool's account 1 is another key
  const w = wire({
    inner: SOLANA_SYSTEM_PROGRAM,
    accounts: (a) => [...a.map((x, i) => (i === 1 ? { key: key("NOT_W").address, signer: false, writable: true } : x)), { key: W.address, signer: true, writable: true }],
  });
  assert.equal(verdict(w), "bad_shape");
});

test("a message loading more than SOLANA_POOL_LOOKUPS_MAX (4) tables is refused before any read (bad_shape)", () => {
  // tag 3 with the tip and TO: the pool, the spent mark, the pages, the tip account and TO are loadable, each distinct
  const accounts = solanaPoolReleaseAccounts({ program: PROGRAM, pool: POOL }, W.address, FP.address, rel(), 6);
  const loadable = [...new Set([0, 3, 4, 5, 6].map((i) => accounts[i]!.key)), TO];
  assert.ok(loadable.length >= 5);
  const five = checkSolanaPoolTx(wire({ inner: SOLANA_SYSTEM_PROGRAM, tables: loadable.slice(0, 5) }), CFG);
  assert.equal(five.ok ? "ok" : five.code, "bad_shape");
  const four = checkSolanaPoolTx(wire({ inner: SOLANA_SYSTEM_PROGRAM, tables: loadable.slice(0, 4) }), CFG);
  assert.ok(four.ok && four.tx.message.lookups.length === 4);
});

// ------------------------------------------------------------------------------------------------ M362 (4): Jito
// A fake block engine: per region (by host), the answer to give; it records every request. "ok" answers the signature
// of the transaction posted.
type Engine = "ok" | "429" | "503" | "throw" | "rpc_error" | "rate_error";
function blockEngine(plan: (host: string, n: number) => Engine) {
  const seen: { host: string; url: string; body: { method: string; params: [string, { encoding: string }] } }[] = [];
  const fetchFn = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const body = JSON.parse(String(init.body));
    seen.push({ host: u.host, url, body });
    const what = plan(u.host, seen.length - 1);
    if (what === "throw") throw new Error("connect ECONNREFUSED");
    if (what === "429") return new Response("rate limited", { status: 429 });
    if (what === "503") return new Response("", { status: 503 });
    if (what === "rpc_error") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bundle must tip" } }), { status: 400 });
    if (what === "rate_error") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32097, message: "Rate limit exceeded" } }), { status: 200 });
    const w = Buffer.from(body.params[0], "base64");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: base58(w.subarray(1, 65)) }), { status: 200 });
  };
  return { seen, fetchFn };
}
const REGIONS = SOLANA_JITO_BLOCK_ENGINES;
/** A mainnet sender on a fake block engine; the kit's send is faked as the chain: a bundle-only send that would fail
 * never lands (expired), a plain one that fails lands as a paid failure. */
type Sent = { sig: string; wire: Uint8Array; paths: readonly SolanaSendPath[] };
type Done = Promise<{ txs: { signature: string; state: "filled" | "failed" | "expired" | "unknown"; sends: [] }[] }>;
/** A mainnet sender on a fake block engine; the kit's send is faked as the chain: a bundle-only send that would fail
 * never lands (expired), a plain one that fails lands as a paid failure. `done`, when set, decides each send instead.
 * The block engine's pacer runs at `intervalMs` (0 unless a test is about the pacing). */
function mainnet(o: { engine: ReturnType<typeof blockEngine> | { fetchFn: JitoFetch }; a?: Calls; now?: () => number; paths?: string[][]; end?: "failed" | "filled"; done?: (s: Sent) => Done; intervalMs?: number }) {
  return solanaPoolSender(
    { cluster: "mainnet", program: PROGRAM, feePayerSecret: FP.secret, fee: String(FEE) },
    {
      providers: [stub(o.a ?? []), stub([])],
      now: o.now ?? (() => NOW),
      readRent: async () => MAINNET,
      jito: jitoSender({ fetch: o.engine.fetchFn, timeoutMs: 1_000, intervalMs: o.intervalMs ?? 0 }),
      send: (set, opts) => {
        const names = opts.paths.map((p) => p.name);
        o.paths?.push(names);
        const sig = base58(set[0]!.wire.subarray(1, 65));
        if (o.done) return { signatures: [sig], done: o.done({ sig, wire: set[0]!.wire, paths: opts.paths }) as never, stop() {} };
        const end = (o.end ?? "failed") === "filled" ? "filled" : names.includes("jito") ? "expired" : "failed";
        return { signatures: [sig], done: Promise.resolve({ txs: [{ signature: sig, state: end as "filled", sends: [] }] }), stop() {} };
      },
    },
  );
}
const tipped = (o: Opt = {}) => wire({ inner: SOLANA_SYSTEM_PROGRAM, tip: 1_000n, ...o });
const MCFG = { ...CFG, jito: true };
const mverdict = (w: Uint8Array) => {
  const c = checkSolanaPoolTx(w, MCFG);
  return c.ok ? "ok" : c.code;
};

test("M362 (4): on mainnet a tag 3 tips at least 1,000 lamports to a Jito tip account named statically, or is refused before any read (tip_low)", async () => {
  assert.equal(mverdict(tipped()), "ok");
  for (const t of SOLANA_JITO_TIP_ACCOUNTS) assert.equal(mverdict(tipped({ tipTo: t })), "ok", t);
  assert.equal(mverdict(tipped({ tip: 999n })), "tip_low");
  assert.equal(mverdict(wire({ inner: SOLANA_SYSTEM_PROGRAM })), "tip_low", "no tip at all");
  assert.equal(mverdict(tipped({ tipTo: TO })), "tip_low", "a tip to an account that is not Jito's");
  // the kit's compiler never loads a Jito tip account (M362 (4)), so a loaded account 8 is another key: refused unread
  const loaded = key("TIP_LOADED").address;
  const wl = tipped({ tipTo: loaded, table: [loaded] });
  const c = checkSolanaPoolTx(wl, CFG);
  assert.ok(c.ok && c.tx.message.lookups.length === 1, "account 8 is loaded from the table");
  assert.equal(mverdict(wl), "tip_low", "account 8 loaded from a table");
  assert.equal(mverdict(wire()), "ok", "a tag 2 carries no tip");
  assert.equal(verdict(wire({ inner: SOLANA_SYSTEM_PROGRAM })), "ok", "devnet: no tip asked");
  const engine = blockEngine(() => "ok");
  const calls: Calls = [];
  assert.equal(code(await mainnet({ engine, a: calls }).carry(body(tipped({ tip: 999n })))), "tip_low");
  assert.deepEqual(calls, []);
  assert.equal(engine.seen.length, 0);
});

test("M362 (4): a mainnet tag 3 goes bundle-only to a block engine and is rebroadcast only there", async () => {
  const engine = blockEngine(() => "ok");
  const paths: string[][] = [];
  const a = await mainnet({ engine, paths, end: "filled" }).carry(body(tipped()));
  assert.equal(code(a), "ok");
  assert.equal(engine.seen.length, 1);
  const u = new URL(engine.seen[0]!.url);
  assert.equal(u.pathname, "/api/v1/transactions");
  assert.equal(u.searchParams.get("bundleOnly"), "true");
  assert.equal(engine.seen[0]!.body.method, "sendTransaction");
  assert.equal(engine.seen[0]!.body.params[1].encoding, "base64");
  assert.deepEqual(paths, [["jito"]]);
  assert.ok(REGIONS.every((r) => new URL(r).searchParams.get("bundleOnly") === "true" && new URL(r).host.endsWith(".mainnet.block-engine.jito.wtf")));
  assert.equal(REGIONS.length, 8);
});

test("M362 (4): a 429 from one region goes to the next; sends start at the next region each time", async () => {
  const engine = blockEngine((host) => (host.startsWith("amsterdam.") ? "429" : "ok"));
  const s = mainnet({ engine, end: "filled" });
  assert.equal(code(await s.carry(body(tipped()))), "ok");
  assert.deepEqual(engine.seen.map((x) => x.host.split(".")[0]), ["amsterdam", "dublin"]);
  assert.equal(code(await s.carry(body(tipped({ r: { existingNullifierHash: f32(77) } })))), "ok");
  // the next send starts one region further on, at the first region no send has used yet (its second comes first)
  assert.deepEqual(engine.seen.slice(2).map((x) => x.host.split(".")[0]), ["frankfurt"], "the next send starts further on");
  assert.equal(code(await s.carry(body(tipped({ r: { existingNullifierHash: f32(78) } })))), "ok");
  assert.deepEqual(engine.seen.slice(3).map((x) => x.host.split(".")[0]), ["london"]);
  const rate = blockEngine((host) => (host.startsWith("amsterdam.") ? "rate_error" : "ok"));
  assert.equal(code(await mainnet({ engine: rate, end: "filled" }).carry(body(tipped()))), "ok");
  assert.equal(rate.seen.length, 2, "a JSON-RPC rate-limit answer counts as busy too");
});

test("M362 (4): the plain send only when every region fails on transport; busy or refused everywhere sends nothing (503)", async () => {
  const engine = blockEngine(() => "throw");
  const paths: string[][] = [];
  assert.equal(code(await mainnet({ engine, paths, end: "filled" }).carry(body(tipped()))), "ok");
  assert.equal(engine.seen.length, 8);
  assert.deepEqual(paths, [["rpc0", "rpc1"]], "the plain send");
  // M369 (L1): a 5xx from every region is busy, not transport: 503 and nothing plain
  for (const status of ["503"] as const) {
    const e5 = blockEngine(() => status);
    const p5: string[][] = [];
    const a5 = await mainnet({ engine: e5, paths: p5, end: "filled" }).carry(body(tipped()));
    assert.deepEqual([a5.status, code(a5)], [503, "upstream"], "a 5xx everywhere");
    assert.equal(e5.seen.length, 8, "every region asked");
    assert.deepEqual(p5, [], "nothing plain");
  }
  const mixed = blockEngine((host) => (host.startsWith("tokyo.") ? "429" : "throw"));
  const p1: string[][] = [];
  const a = await mainnet({ engine: mixed, paths: p1 }).carry(body(tipped()));
  assert.deepEqual([a.status, code(a)], [503, "upstream"], "one region busy: not every region failed on transport");
  assert.deepEqual(p1, []);
  const refused = blockEngine(() => "rpc_error");
  const p2: string[][] = [];
  const b = await mainnet({ engine: refused, paths: p2 }).carry(body(tipped()));
  assert.deepEqual([b.status, code(b)], [503, "upstream"]);
  assert.equal(refused.seen.length, 1, "a refusal ends the try");
  assert.deepEqual(p2, []);
  // and a 503 frees the nullifier: the next carry tries again
  const s = mainnet({ engine: blockEngine((_, n) => (n === 0 ? "rpc_error" : "ok")), end: "filled" });
  assert.equal(code(await s.carry(body(tipped()))), "upstream");
  assert.equal(code(await s.carry(body(tipped()))), "ok");
});

test("M362 (4): a mainnet tag 2 goes plain, never to a block engine", async () => {
  const engine = blockEngine(() => "ok");
  const paths: string[][] = [];
  assert.equal(code(await mainnet({ engine, paths, end: "filled" }).carry(body(wire()))), "ok");
  assert.equal(engine.seen.length, 0);
  assert.deepEqual(paths, [["rpc0", "rpc1"]]);
});

test("R2-D1 rerun (M362 (4)): ten notes, sixty epochs on mainnet: bundle-only, so no failure lands and the drain is 0", async () => {
  const engine = blockEngine(() => "ok");
  const paths: string[][] = [];
  let now = NOW;
  const s = mainnet({ engine, paths, now: () => now });
  const budget = solanaPoolPriorityBudget(MAINNET, FEE);
  const top = (budget * 1_000_000n) / 1_400_000n;
  const notes = Array.from({ length: 10 }, (_, i) => tipped({ pre: [cuLimit(1_400_000), cuPrice(top)], r: { existingNullifierHash: f32(100 + i), deadlineMs: BigInt(NOW + 3_700_000) } }));
  for (let e = 0; e < 60; e++) {
    for (const n of notes) assert.equal(code(await s.carry(body(n))), "not_landed", "never landed: no fill, so no signature (M369 (H1))");
    await new Promise((r) => setImmediate(r));
    now += POOL_EPOCH_MS;
  }
  assert.equal(paths.length, 600, "each carry sent (a send that never lands frees its note)");
  const plain = paths.filter((p) => !p.includes("jito")).length;
  assert.equal(plain, 0, "no plain send, so no paid failure: the fee payer's drain is 0");
});

// ------------------------------------------------------------------------------------------------ M369
const deferred = () => {
  let resolve!: (v: Awaited<Done>) => void;
  const p = new Promise<Awaited<Done>>((r) => (resolve = r));
  return { p, resolve };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = async (p: Promise<unknown>, ms = 50) => (await Promise.race([p.then(() => "settled"), sleep(ms).then(() => "pending")])) === "pending";
function base58decode64(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  const out = new Uint8Array(64);
  for (let i = 63; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}

// The review's R3-H1 rebuilt the fully signed tag 3 from the caller's own bytes and the 200 answer's signature, and could
// then send it plainly, outside the bundle, as a failure the fee payer pays. Inverted: no answer names that signature
// while the bundle is undecided, and only a fill answers it.
test("M369 (H1), R3-H1 inverted: no answer carries the fee payer's signature while the bundle is undecided; only a fill does", async () => {
  for (const end of ["expired", "unknown", "failed", "no answer"] as const) {
    const engine = blockEngine(() => "ok");
    const d = deferred();
    let sent: Sent | undefined;
    const s = mainnet({ engine, done: (x) => ((sent = x), end === "no answer" ? d.p.then(() => Promise.reject(new Error("no answer"))) : d.p) });
    const w = tipped();
    const first = s.carry(body(w), "c");
    await sleep(20);
    assert.ok(sent, `${end}: sent bundle-only`);
    const sig = sent!.sig;
    assert.ok(await pending(first), `${end}: no answer before the send is decided`);
    const repeat = s.carry(body(w), "c");
    assert.ok(await pending(repeat), `${end}: a repeat waits for the same answer`);
    d.resolve({ txs: [{ signature: sig, state: end === "no answer" ? "unknown" : end, sends: [] }] });
    for (const a of [await first, await repeat]) {
      assert.equal(code(a), "not_landed", end);
      assert.equal(a.status, end === "failed" ? 422 : 503, end);
      assert.ok(!JSON.stringify(a.body).includes(sig), `${end}: the answer never names the fee payer's signature`);
    }
    const again = await s.carry(body(w), "c");
    if (end === "expired") {
      assert.equal(engine.seen.length, 2, "expired: never landed, so the note is free and is sent again");
    } else if (end === "failed") {
      assert.equal(code(again), "failed_this_epoch");
      assert.equal(engine.seen.length, 1);
    } else {
      assert.deepEqual([again.status, code(again)], [503, "not_landed"], `${end}: held to the deadline, unsent`);
      assert.equal(engine.seen.length, 1);
    }
    assert.ok(!JSON.stringify(again.body).includes(sig));
  }
  // a fill: 200 with the signature, once decided, and it is the transaction the block engine took, now on chain
  const engine = blockEngine(() => "ok");
  const d = deferred();
  let sent: Sent | undefined;
  const s = mainnet({ engine, done: (x) => ((sent = x), d.p) });
  const w = tipped({ pre: [cuLimit(1_400_000), cuPrice(166_175n)] });
  const p = s.carry(body(w), "c");
  await sleep(20);
  assert.ok(await pending(p), "filled: no answer before the fill");
  d.resolve({ txs: [{ signature: sent!.sig, state: "filled", sends: [] }] });
  const a = await p;
  assert.equal(code(a), "ok");
  const sig = (a.body as { signature: string }).signature;
  assert.equal(sig, sent!.sig);
  const rebuilt = Uint8Array.from(w);
  rebuilt.set(base58decode64(sig), 1);
  assert.deepEqual(Buffer.from(rebuilt), Buffer.from(engine.seen[0]!.body.params[0], "base64"));
  assert.ok(ed25519.verify(rebuilt.subarray(1, 65), rebuilt.subarray(129), ed25519.getPublicKey(FP.seed)));
  // the plain send after every region failed on transport is decided the same way
  const t = blockEngine(() => "throw");
  const dt = deferred();
  let st: Sent | undefined;
  const plain = mainnet({ engine: t, done: (x) => ((st = x), dt.p) });
  const q = plain.carry(body(tipped()), "c");
  await sleep(20);
  assert.ok(await pending(q), "plain fallback: no answer before the decision");
  dt.resolve({ txs: [{ signature: st!.sig, state: "expired", sends: [] }] });
  assert.ok(!JSON.stringify((await q).body).includes(st!.sig));
});

test("M369 (M1): a client has at most two mainnet tag 3 carries waiting for their fill; the third is refused unsent (in_flight)", async () => {
  const engine = blockEngine(() => "ok");
  const ds: { sig: string; d: ReturnType<typeof deferred> }[] = [];
  const s = mainnet({ engine, done: (x) => { const d = deferred(); ds.push({ sig: x.sig, d }); return d.p; } });
  const n = (i: number) => tipped({ r: { existingNullifierHash: f32(200 + i) } });
  const fill = (k: number) => ds[k]!.d.resolve({ txs: [{ signature: ds[k]!.sig, state: "filled", sends: [] }] });
  const a = s.carry(body(n(1)), "x");
  const b = s.carry(body(n(2)), "x");
  await sleep(20);
  const c = await s.carry(body(n(3)), "x");
  assert.deepEqual([c.status, code(c)], [429, "in_flight"]);
  assert.equal(engine.seen.length, 2, "the third sent nothing");
  assert.ok(await pending(s.carry(body(n(1)), "x")), "a repeat of a carry in flight is no new carry: it waits for the first answer");
  const y = s.carry(body(n(4)), "y");
  await sleep(20);
  assert.equal(engine.seen.length, 3, "another client goes on");
  fill(0);
  assert.equal(code(await a), "ok");
  const x5 = s.carry(body(n(5)), "x");
  await sleep(20);
  assert.equal(engine.seen.length, 4, "a fill frees the client's place");
  fill(1);
  fill(2);
  fill(3);
  for (const p of [b, y, x5]) assert.equal(code(await p), "ok");
  // a mainnet tag 2 and a devnet carry answer at once, so the cap is not theirs
  const t2 = mainnet({ engine: blockEngine(() => "ok"), end: "filled" });
  for (let i = 0; i < 4; i++) assert.equal(code(await t2.carry(body(wire({ r: { existingNullifierHash: f32(220 + i) } })), "x")), "ok");
});

test("M369 (M1): a rebroadcast goes to the region that took the first send only, through its one shared pacer, and rejects when it is not sent (J14)", async () => {
  let refuse = false;
  const engine = blockEngine(() => (refuse ? "rpc_error" : "ok"));
  let path: SolanaSendPath | undefined;
  let b64 = "";
  const s = mainnet({ engine, intervalMs: 50, done: (x) => ((path = x.paths[0]), (b64 = Buffer.from(x.wire).toString("base64")), Promise.resolve({ txs: [{ signature: x.sig, state: "filled", sends: [] }] })) });
  const a = await s.carry(body(tipped()));
  assert.equal(code(a), "ok");
  const sig = (a.body as { signature: string }).signature;
  assert.equal(path!.name, "jito");
  assert.equal(path!.paceKey, engine.seen[0]!.url, "the kit paces it per region, shared by every carry rebroadcasting there");
  await assert.rejects(path!.send(b64), /block engine busy/, "the first send's second: not sent, and the kit's record says so");
  assert.equal(engine.seen.length, 1);
  await sleep(60);
  assert.equal(await path!.send(b64), sig);
  await sleep(60);
  refuse = true;
  await assert.rejects(path!.send(b64), /block engine refused/);
  assert.equal(new Set(engine.seen.map((x) => x.url)).size, 1, "never another region");
});

// The review's capacity run, on the helper: the keyless limit is one request a second per region from the helper's
// address, refused requests counted too. Sixteen carries from eight clients (two each, the most M1 lets them) wait for
// a fill that never comes and rebroadcast once a second, as the kit would; an honest client's carry comes every 700 ms.
// Real time, about 6 s.
test("M369 (M1): sixteen carries rebroadcasting never keep an honest first send out of a region for over 1 s", async () => {
  const times = new Map<string, number[]>();
  let refused = 0;
  const fetchFn: JitoFetch = async (url, init) => {
    const host = new URL(url).host;
    const now = performance.now();
    const seen = (times.get(host) ?? []).filter((t) => now - t < 990);
    seen.push(now);
    times.set(host, seen);
    if (seen.length > 1) return (refused++, new Response("", { status: 429 }));
    const w = Buffer.from(JSON.parse(String(init.body)).params[0], "base64");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: base58(w.subarray(1, 65)) }));
  };
  const honest = new Set<string>();
  const loops: ReturnType<typeof setInterval>[] = [];
  const s = mainnet({
    engine: { fetchFn },
    intervalMs: 1_000,
    done: (x) => {
      if (honest.has(Buffer.from(x.wire.subarray(65, 129)).toString("hex"))) return Promise.resolve({ txs: [{ signature: x.sig, state: "filled", sends: [] }] });
      const b64 = Buffer.from(x.wire).toString("base64");
      loops.push(setInterval(() => void Promise.resolve().then(() => x.paths[0]!.send(b64)).catch(() => {}), 1_000));
      return new Promise(() => {});
    },
  });
  try {
    for (let i = 0; i < 16; i++) void s.carry(body(tipped({ r: { existingNullifierHash: f32(1 + i) } })), `attacker${i % 8}`);
    await sleep(1_200);
    const ms: number[] = [];
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) {
      const w = tipped({ r: { existingNullifierHash: f32(150 + i) } });
      honest.add(Buffer.from(w.subarray(65, 129)).toString("hex"));
      const t0 = performance.now();
      codes.push(code(await s.carry(body(w), "honest")));
      ms.push(performance.now() - t0);
      await sleep(700);
    }
    const sorted = [...ms].sort((x, y) => x - y);
    console.log(`honest first sends with 16 carries rebroadcasting: ${codes.join(",")}; ms p50 ${Math.round(sorted[3]!)} max ${Math.round(sorted[6]!)}; 429s ${refused}`);
    assert.deepEqual(codes, Array(7).fill("ok"));
    assert.ok(sorted[6]! < 1_100, `the slowest honest first send took ${Math.round(sorted[6]!)} ms`);
  } finally {
    for (const l of loops) clearInterval(l);
  }
});
