// The Solana set send (markets paper T2.1 "Sending" and LD2, docs/plan1/markets.md l.93 and l.336-346; row M1.3).
// Device side. It carries only bytes the device already signed: it holds no key, builds no transaction and changes no
// byte. Signed bytes cannot be altered by whoever carries them and the first copy to land wins, so every path gets
// the same bytes at once and no single path can hold a trade back (LD2).
//
// - Send: every tx of the set goes to every path in the same tick, before sendSolanaSet returns: Helius Sender
//   `/fast?swqos_only=true`, the Jito block engine `/api/v1/transactions` and a public RPC, keyless from the device, and
//   the helper's `/v1/rpc/solana` `sendTransaction`, keyed on the helper's side, when the app has a helper. A path that
//   is down, refusing (keyless Sender answers 429 above 1 rps) or slow is recorded and holds nothing else back.
// - Rebroadcast: every SOLANA_REBROADCAST_MS (2 s, the paper's DESIGN interval from P4S) until the tx is decided, and
//   never once both providers' finalized block height is past the tx's lastValidBlockHeight (06c §3.4).
// - Fill: read on two providers (the same [A, B] pair the quote checks read, checks/solana/checks.ts SolanaQuoteReads;
//   §2.0 LD1: at least one device-direct, the second may be the helper's /v1/rpc). A tx is filled only when both read
//   it at `confirmed` or `finalized` with no error, failed only when both read it landed with an error, and dead
//   (expired) only when both report a finalized height past lastValidBlockHeight and then neither has the signature
//   (06c A4). Anything else, one provider's word included, decides nothing; at the deadline it stays "unknown", which
//   the caller must re-read before it moves money on, never a fill and never dead.
//
// Every answer from a path or a provider is hostile input: it is size-bounded, shape-checked, and an answer that fails
// a check counts as no answer.
import { base58, base64 } from "@scure/base";
import { HELPER_FETCH_INIT, HELPER_V1_PREFIX } from "../../helper/v1.ts";
import { SOLANA_MAX_TX_BYTES, solanaDecodeTransaction } from "../../checks/solana/message.ts";

// Helius Sender, the global HTTPS endpoint with the SWQoS-only route: https://www.helius.dev/docs/sending-transactions/sender.md
// ("https://sender.helius-rpc.com/fast # Global HTTPS endpoint", which "resolves CORS preflight failures ... with
// browser-based applications"; "Add `?swqos_only=true` to any endpoint URL"; keyless "limited to 1 request per second").
// Its preflight answered Access-Control-Allow-Origin: * on 2026-11-02 01:56Z.
export const SOLANA_SENDER_FAST_URL = "https://sender.helius-rpc.com/fast?swqos_only=true";
// The Jito block engine's sendTransaction: https://docs.jito.wtf/lowlatencytxnsend/ ("this method always sets
// skip_preflight=true"; its examples send params [tx, { encoding }] only). Its preflight from the app's origin answered
// that origin on 2026-11-02 01:56Z.
export const SOLANA_JITO_TRANSACTIONS_URL = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
// The public mainnet RPC: https://solana.com/docs/references/clusters (100 requests per 10 s per IP). Its preflight
// from the app's origin answered that origin on 2026-11-02 01:56Z.
export const SOLANA_PUBLIC_RPC_URL = "https://api.mainnet-beta.solana.com";

/** The paper's rebroadcast interval (T2.1, DESIGN from P4S). */
export const SOLANA_REBROADCAST_MS = 2_000;
/** How often the fill is read on each provider: about one slot (P4S measured slots of 214-219 ms; 400 ms is the
 * cluster's target slot time). A read still open when the next is due is not stacked. */
export const SOLANA_STATUS_POLL_MS = 400;
/** One path call or provider read is given up after this. */
export const SOLANA_CALL_TIMEOUT_MS = 5_000;
/** The set is given up after this, its undecided txs "unknown": a blockhash lives about 150 blocks (P4S [J1], about
 * 60 s) and a finalized height trails by about 32 slots, so a tx past this with no verdict needs a fresh read. */
export const SOLANA_SET_DEADLINE_MS = 120_000;
/** An answer larger than this is refused unread. A status or send answer is well under 64 KiB for a set of 256. */
export const SOLANA_ANSWER_MAX_BYTES = 1024 * 1024;
/** getSignatureStatuses takes at most 256 signatures a call (Solana RPC docs); a larger set is read in chunks. */
const STATUS_CHUNK = 256;

export type SolanaFetch = (url: string, init: RequestInit) => Promise<Response>;
/** One JSON-RPC call on one Solana provider: resolves the call's `result`, rejects on any other answer. */
export type SolanaRpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
/** One send path: posts the base64 bytes, resolves the signature the path answered. */
export type SolanaSendPath = { readonly name: string; readonly send: (base64Tx: string) => Promise<string> };
/** A tx the device signed, and the lastValidBlockHeight of its blockhash from the device's own getLatestBlockhash. */
export type SolanaSignedTx = { readonly wire: Uint8Array; readonly lastValidBlockHeight: number };

export type SolanaSendAttempt = { path: string; attempt: number; ok: boolean; ms: number; error?: string };
export type SolanaTxState = "filled" | "failed" | "expired" | "unknown";
export type SolanaTxOutcome = {
  signature: string;
  state: SolanaTxState;
  /** The landed slot as provider A read it, when filled or failed. */
  slot?: number;
  /** Each provider's error, when failed. */
  err?: readonly [unknown, unknown];
  /** From the first send to the read that decided it. */
  ms?: number;
  sends: SolanaSendAttempt[];
};
export type SolanaSetResult = { txs: SolanaTxOutcome[] };
export type SolanaSetHandle = {
  readonly signatures: readonly string[];
  readonly done: Promise<SolanaSetResult>;
  /** Stops every send and read now; undecided txs end "unknown". */
  stop(): void;
};
export type SolanaSetOptions = {
  readonly paths: readonly SolanaSendPath[];
  /** Provider A (device-direct) and provider B, as the quote checks read them. */
  readonly providers: readonly [SolanaRpc, SolanaRpc];
  readonly rebroadcastMs?: number;
  readonly pollMs?: number;
  readonly deadlineMs?: number;
  readonly callTimeoutMs?: number;
};

const errText = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 200);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`no answer in ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

async function readBounded(r: Response): Promise<string> {
  if (Number(r.headers.get("content-length") ?? "0") > SOLANA_ANSWER_MAX_BYTES) throw new Error("answer too large");
  if (!r.body) return "";
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > SOLANA_ANSWER_MAX_BYTES) {
      void reader.cancel().catch(() => {});
      throw new Error("answer too large");
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

function httpsUrl(raw: string, what: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${what} must be an https URL`); }
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`${what} must be an https URL`);
  if (u.username || u.password || u.hash) throw new Error(`${what} must carry no credentials or fragment`);
  return u;
}

let nextId = 1;
/** JSON-RPC over HTTP POST to one URL. `init` is merged into every request (the helper's HELPER_FETCH_INIT). */
export function solanaJsonRpc(url: string, opts: { fetch?: SolanaFetch; init?: RequestInit; timeoutMs?: number } = {}): SolanaRpc {
  httpsUrl(url, "an RPC URL");
  const doFetch: SolanaFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  return (method, params) => {
    const id = nextId++;
    const init: RequestInit = {
      ...opts.init,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    };
    // fetch is called here, synchronously: a caller that starts several calls starts them all in one tick.
    return doFetch(url, init).then(async (r) => {
      const text = await readBounded(r);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(text) as unknown;
      if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("not a JSON-RPC answer");
      const o = j as Record<string, unknown>;
      if (o.id !== id) throw new Error(`answer id ${JSON.stringify(o.id)} is not request id ${id}`);
      if (o.error !== undefined) {
        const e = o.error as { code?: unknown; message?: unknown } | null;
        throw new Error(`RPC error ${String(e?.code)}: ${String(e?.message).slice(0, 120)}`);
      }
      if (!("result" in o)) throw new Error("no result");
      return o.result;
    });
  };
}

/** The helper's POST /v1/rpc/solana (helper/v1.ts HELPER_RPC_METHODS: sendTransaction, getSignatureStatuses and
 * getBlockHeight are on its list), with the kit's HELPER_FETCH_INIT. `origin` is the helper's origin only. */
export function solanaHelperRpc(origin: string, opts: { fetch?: SolanaFetch; timeoutMs?: number } = {}): SolanaRpc {
  const u = httpsUrl(origin, "the helper origin");
  if (u.pathname !== "/" || u.search !== "" || !(origin === u.origin || origin === `${u.origin}/`)) throw new Error("the helper origin must be an origin only");
  return solanaJsonRpc(`${u.origin}${HELPER_V1_PREFIX}/rpc/solana`, { ...opts, init: HELPER_FETCH_INIT });
}

const SEND_CONFIG = { encoding: "base64", skipPreflight: true, maxRetries: 0 } as const;

function rpcPath(name: string, rpc: SolanaRpc, config: Record<string, unknown>): SolanaSendPath {
  return {
    name,
    send: (b64) => rpc("sendTransaction", [b64, config]).then((sig) => {
      if (typeof sig !== "string") throw new Error("the path answered no signature");
      return sig;
    }),
  };
}

/**
 * The paper's send paths: Sender, Jito and a public RPC from the device, keyless, and the helper's keyed send when
 * the app has a helper. With no helper the set goes on three paths; nothing waits for a fourth.
 */
export function solanaSendPaths(opts: { helper?: SolanaRpc | null; rpcUrl?: string; fetch?: SolanaFetch; timeoutMs?: number } = {}): SolanaSendPath[] {
  const o = { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) };
  const paths = [
    rpcPath("sender", solanaJsonRpc(SOLANA_SENDER_FAST_URL, o), SEND_CONFIG),
    rpcPath("jito", solanaJsonRpc(SOLANA_JITO_TRANSACTIONS_URL, o), { encoding: "base64" }),
    rpcPath("rpc", solanaJsonRpc(opts.rpcUrl ?? SOLANA_PUBLIC_RPC_URL, o), SEND_CONFIG),
  ];
  if (opts.helper) paths.push(rpcPath("helper", opts.helper, SEND_CONFIG));
  return paths;
}

type Prepared = { signature: string; b64: string; lvbh: number };

/** The set's own checks before anything is sent: signed bytes the kit can decode, each once, a usable height. */
function prepare(set: readonly SolanaSignedTx[], opts: Pick<SolanaSetOptions, "paths" | "providers">): Prepared[] {
  if (!Array.isArray(set) || set.length === 0) throw new Error("the set is empty");
  if (!Array.isArray(opts.paths) || opts.paths.length === 0) throw new Error("no send path");
  if (!Array.isArray(opts.providers) || opts.providers.length !== 2 || typeof opts.providers[0] !== "function" || typeof opts.providers[1] !== "function") throw new Error("two providers are needed");
  const seen = new Set<string>();
  return set.map((t, i) => {
    if (!(t?.wire instanceof Uint8Array)) throw new Error(`tx ${i}: no wire bytes`);
    if (t.wire.length > SOLANA_MAX_TX_BYTES) throw new Error(`tx ${i}: ${t.wire.length} bytes, over ${SOLANA_MAX_TX_BYTES}`);
    const decoded = solanaDecodeTransaction(t.wire); // throws on bytes that are not one whole transaction
    if (decoded.signatures < 1 || decoded.signatures > 0x7f) throw new Error(`tx ${i}: ${decoded.signatures} signature slots`);
    for (let s = 0; s < decoded.signatures; s++) {
      if (t.wire.subarray(1 + 64 * s, 65 + 64 * s).every((b: number) => b === 0)) throw new Error(`tx ${i}: signature ${s} is not signed`);
    }
    if (!Number.isSafeInteger(t.lastValidBlockHeight) || t.lastValidBlockHeight < 0 || t.lastValidBlockHeight >= 2 ** 53 - 1) throw new Error(`tx ${i}: lastValidBlockHeight ${String(t.lastValidBlockHeight)}`);
    const signature = base58.encode(t.wire.subarray(1, 65));
    if (seen.has(signature)) throw new Error(`tx ${i}: the same tx is in the set twice`);
    seen.add(signature);
    return { signature, b64: base64.encode(t.wire), lvbh: t.lastValidBlockHeight };
  });
}

// One provider's read of one signature, after the shape checks.
type Read = "none" | "pending" | "ok" | "err" | "bad";
type StatusRead = { kind: Read; slot?: number; err?: unknown };
const STATUSES = new Set(["processed", "confirmed", "finalized"]);

function readStatuses(answer: unknown, n: number): StatusRead[] | null {
  if (typeof answer !== "object" || answer === null) return null;
  const v = (answer as { value?: unknown }).value;
  if (!Array.isArray(v) || v.length !== n) return null;
  return v.map((s): StatusRead => {
    if (s === null) return { kind: "none" };
    if (typeof s !== "object" || Array.isArray(s)) return { kind: "bad" };
    const o = s as Record<string, unknown>;
    if (typeof o.confirmationStatus !== "string" || !STATUSES.has(o.confirmationStatus) || !("err" in o) || !Number.isSafeInteger(o.slot)) return { kind: "bad" };
    if (o.confirmationStatus === "processed") return { kind: "pending" };
    return o.err === null ? { kind: "ok", slot: o.slot as number } : { kind: "err", slot: o.slot as number, err: o.err };
  });
}

/**
 * Sends a signed set on every path at once and reads its fills on two providers. Throws before any send when the set
 * fails its own checks; after that it never throws, and `done` resolves with one outcome per tx, in set order.
 */
export function sendSolanaSet(set: readonly SolanaSignedTx[], opts: SolanaSetOptions): SolanaSetHandle {
  const txs = prepare(set, opts);
  const rebroadcastMs = opts.rebroadcastMs ?? SOLANA_REBROADCAST_MS;
  const pollMs = opts.pollMs ?? SOLANA_STATUS_POLL_MS;
  const deadlineMs = opts.deadlineMs ?? SOLANA_SET_DEADLINE_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  const t0 = Date.now();
  const outcomes: SolanaTxOutcome[] = txs.map((t) => ({ signature: t.signature, state: "unknown", sends: [] }));
  const decided = txs.map(() => false);
  // Per provider: the latest status reads and the event count at that read's start; the latest finalized height and
  // the event count when it arrived. A status read counts for "dead" only if it started after its provider's latest
  // height answer, so a landing the height already covers is in that read. A provider whose status reads stay slower
  // than its heights rise only delays "dead" until the deadline ("unknown"); it never makes a tx dead early.
  let events = 0;
  const latest: [StatusRead[] | null, StatusRead[] | null] = [null, null];
  const latestAt: [number, number] = [-1, -1];
  const height: [number | null, number | null] = [null, null];
  const heightAt: [number, number] = [Infinity, Infinity];
  const inFlight = [false, false];
  let attempt = 0;
  let over = false;
  let finish!: (r: SolanaSetResult) => void;
  const done = new Promise<SolanaSetResult>((r) => { finish = r; });

  const past = (i: number): boolean => {
    const lvbh = txs[i]!.lvbh;
    return height[0] !== null && height[1] !== null && height[0] > lvbh && height[1] > lvbh;
  };

  function broadcast(): void {
    const n = attempt++;
    for (let i = 0; i < txs.length; i++) {
      if (decided[i] || past(i)) continue;
      const t = txs[i]!;
      for (const p of opts.paths) {
        const start = Date.now();
        let sent: Promise<string>;
        try {
          sent = p.send(t.b64);
        } catch (e) {
          sent = Promise.reject(e);
        }
        withTimeout(Promise.resolve(sent), callTimeoutMs).then(
          (sig) => {
            if (over) return; // the result is final once `done` resolves
            const ok = sig === t.signature;
            outcomes[i]!.sends.push({ path: p.name, attempt: n, ok, ms: Date.now() - start, ...(ok ? {} : { error: "the path answered another signature" }) });
          },
          (e) => { if (!over) outcomes[i]!.sends.push({ path: p.name, attempt: n, ok: false, ms: Date.now() - start, error: errText(e) }); },
        );
      }
    }
  }

  function decide(): void {
    const [a, b] = latest;
    if (!a || !b) return;
    for (let i = 0; i < txs.length; i++) {
      if (decided[i]) continue;
      const ra = a[i]!;
      const rb = b[i]!;
      const o = outcomes[i]!;
      if (ra.kind === "ok" && rb.kind === "ok") {
        o.state = "filled";
        o.slot = ra.slot!;
      } else if (ra.kind === "err" && rb.kind === "err") {
        o.state = "failed";
        o.slot = ra.slot!;
        o.err = [ra.err, rb.err];
      } else if (ra.kind === "none" && rb.kind === "none" && past(i) && latestAt[0] > heightAt[0] && latestAt[1] > heightAt[1]) {
        o.state = "expired";
      } else continue;
      o.ms = Date.now() - t0;
      decided[i] = true;
    }
    if (decided.every(Boolean)) end();
  }

  function readStatus(p: 0 | 1): void {
    if (inFlight[p] || over) return;
    inFlight[p] = true;
    const startedAt = ++events;
    const sigs = txs.map((t) => t.signature);
    const chunks: string[][] = [];
    for (let i = 0; i < sigs.length; i += STATUS_CHUNK) chunks.push(sigs.slice(i, i + STATUS_CHUNK));
    const rpc = opts.providers[p];
    Promise.all(chunks.map((c) => withTimeout(Promise.resolve().then(() => rpc("getSignatureStatuses", [c, { searchTransactionHistory: false }])), callTimeoutMs).then((ans) => readStatuses(ans, c.length))))
      .then(
        (parts) => {
          if (over) return; // reads of one provider never overlap (inFlight), so this is its newest
          if (parts.some((x) => x === null)) return; // a broken answer is no answer
          latest[p] = (parts as StatusRead[][]).flat();
          latestAt[p] = startedAt;
          decide();
        },
        () => {},
      )
      .finally(() => { inFlight[p] = false; });
  }

  function readHeights(): void {
    for (const p of [0, 1] as const) {
      const rpc = opts.providers[p];
      withTimeout(Promise.resolve().then(() => rpc("getBlockHeight", [{ commitment: "finalized" }])), callTimeoutMs).then(
        (h) => {
          if (over || typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) return;
          if (height[p] !== null && h < height[p]!) return; // a height never goes back
          if (height[p] !== null && h === height[p]) return;
          height[p] = h;
          heightAt[p] = ++events;
        },
        () => {},
      );
    }
  }

  broadcast(); // the first send, in this tick, before anything is awaited
  const rebroadcast = setInterval(() => { readHeights(); broadcast(); }, rebroadcastMs);
  const poll = setInterval(() => { readStatus(0); readStatus(1); }, pollMs);
  const deadline = setTimeout(end, deadlineMs);

  function end(): void {
    if (over) return;
    over = true;
    clearInterval(rebroadcast);
    clearInterval(poll);
    clearTimeout(deadline);
    finish({ txs: outcomes });
  }

  return { signatures: txs.map((t) => t.signature), done, stop: end };
}

export type SolanaDryTx = {
  signature: string;
  state: "simulated" | "sim-failed";
  /** Each provider's simulation: its error (null when clean) and compute units, or why it gave none. */
  simulations: readonly [{ err: unknown; units: number | null } | { error: string }, { err: unknown; units: number | null } | { error: string }];
};

/**
 * The --dry form (row M1.3's proof): the set's own checks, then each tx simulated on both providers
 * (simulateTransaction, sigVerify off, the blockhash replaced, at `confirmed`). No path is called and nothing is sent.
 * `paths` names the paths a real send would use, each getting the same base64 the simulations read.
 */
export async function dryRunSolanaSet(set: readonly SolanaSignedTx[], opts: SolanaSetOptions): Promise<{ paths: string[]; txs: SolanaDryTx[] }> {
  const txs = prepare(set, opts);
  const timeoutMs = opts.callTimeoutMs ?? SOLANA_CALL_TIMEOUT_MS;
  const config = { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" };
  const one = (rpc: SolanaRpc, b64: string) =>
    withTimeout(Promise.resolve().then(() => rpc("simulateTransaction", [b64, config])), timeoutMs).then(
      (ans) => {
        const v = (ans as { value?: { err?: unknown; unitsConsumed?: unknown } } | null)?.value;
        if (typeof v !== "object" || v === null || !("err" in v)) return { error: "not a simulation answer" };
        return { err: v.err, units: Number.isSafeInteger(v.unitsConsumed) ? (v.unitsConsumed as number) : null };
      },
      (e) => ({ error: errText(e) }),
    );
  const out = await Promise.all(
    txs.map(async (t): Promise<SolanaDryTx> => {
      const sims = (await Promise.all([one(opts.providers[0], t.b64), one(opts.providers[1], t.b64)])) as SolanaDryTx["simulations"];
      const clean = sims.every((s) => "err" in s && s.err === null);
      return { signature: t.signature, state: clean ? "simulated" : "sim-failed", simulations: sims };
    }),
  );
  return { paths: opts.paths.map((p) => p.name), txs: out };
}
