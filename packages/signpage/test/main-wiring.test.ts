// src/main.ts booted top-level on a minimal DOM with the real namer, the wallet's real store and note store
// (fake-indexeddb) and the shell's own message path (card signpage-deposit-quote-wire): each wire from main.ts to the
// namer is checked through deposit.quote as the APP_HOST frame asks it.
// - a landing names U (landed() calls the namer, top: !framed), and a quote at boot waits for that naming (named());
// - a notes change (another tab: money reached the index) names again, so the next quote names the next index;
// - another tab's sign out and sign-in: a quote asked as the resync starts waits for the resync's naming (resyncing).
// - state.pools (card balances-per-chain): the shell's state carries the balance of this page's own notes per chain of
//   the page's pool table, which a second hook gives one pool of the vault's scope (mainnet's table has no NEAR entry); a note that
//   lands is counted in the next state. The state read never writes: pageNotes reads with the wallet's readNotes and
//   never opens the note store (whose open and list free a dead tab's notes and finish a parent); a third hook records
//   who calls each of the two. The framed side is test/main-framed-pools.test.ts.
// - The page's pool pins: a fourth hook loads the wallet's SOL_POOLS with no pool on either cluster, so the pool kinds
//   and the restore are checked on a network with no pin (the mainnet build pins the Solana pool since card
//   sol-pools-mainnet-pin; that build's pinned flow is test/main-mainnet-pools.test.ts), and no pool read sits among
//   the helper's requests this file reads.
// The scope is mainnet's real one: the v1 deploy record's (contracts/vault/deployments/mainnet-v1.json), which
// checks.ts's vaultScope answers unhooked for the page's network (the first test holds the two equal). The helper is a fetch that
// records each request and answers 503, so a quote that reached it answers "down" and carries U in its body.
//   node --test test/main-wiring.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { noteCommitment } from "../../wallet/src/notes/secrets.ts";
import { APP_ORIGIN } from "../src/api.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { ONECLICK_USDC_ASSETS } from "../../kit/src/checks/oneclick.ts";

const SCOPE = BigInt(JSON.parse(readFileSync(new URL("../../../contracts/vault/deployments/mainnet-v1.json", import.meta.url), "utf8")).scope as string);
// Solana's USDC: this test's helper answers 503, so no 1Click answer is checked and no mock key is needed
const SOL_USDC = ONECLICK_USDC_ASSETS[1]!;
const TABLE = 'export const PAGE_POOLS: readonly BalancePool[] = pagePoolsOf(POOL_TESTNET ? "testnet" : "mainnet");';
// this file plants SOL_POOLS empty: the wiring of a page that pins no pool (every pool kind refused, a restore that reads
// nothing); the mainnet pin's own wiring, the landing's settle pass beside deposit.quote among it, is
// test/main-mainnet-pools.test.ts's (card sol-pools-mainnet-pin)
const SOL_PINS = "export const SOL_POOLS: Readonly<Partial<Record<\"devnet\" | \"mainnet\", SolanaPoolPin>>> = Object.freeze(";
// each call of the note store's openNoteStore and readNotes, with the stack it was called from
const calls: { name: string; stack: string }[] = ((globalThis as { __ctNoteCalls?: unknown }).__ctNoteCalls = []) as never;
const record = (src: string, name: string): string => {
  const anchor = `export async function ${name}(`;
  if (!src.includes(anchor)) return src; // not there: never called, which the test then reads
  return `${src.replace(anchor, `async function ${name}__recorded(`)}
export async function ${name}(...a) { globalThis.__ctNoteCalls.push({ name: "${name}", stack: String(new Error().stack) }); return ${name}__recorded(...a); }
`;
};
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pools.ts")) {
      const src = String(r.source);
      if (!src.includes(TABLE)) throw new Error("pools.ts: PAGE_POOLS's line moved; update this test's hook");
      return { ...r, source: src.replace(TABLE, `export const PAGE_POOLS = Object.freeze([{ id: "near:t", chain: "near", scope: ${SCOPE}n, asset: "USDC" }]);`) };
    }
    if (url.endsWith("/wallet/src/pool/solana.ts")) {
      const src = String(r.source);
      if (!src.includes(SOL_PINS)) throw new Error("solana.ts: SOL_POOLS's line moved; update this test's hook");
      return { ...r, source: src.replace(SOL_PINS, `export const SOL_POOLS = Object.freeze({});\nconst SOL_POOLS__real = Object.freeze(`) };
    }
    if (url.endsWith("/wallet/src/notes/store.ts")) return { ...r, source: record(record(String(r.source), "openNoteStore"), "readNotes") };
    // card wallet-deposit-follow: the follows' storeClosed and settle calls are recorded, so the test reads what main.ts
    // does when its store's connection closes
    if (url.endsWith("/signpage/src/deposit-follow.ts")) {
      const src = String(r.source);
      const anchor = "export function depositFollows(h: FollowHost) {";
      if (!src.includes(anchor)) throw new Error("deposit-follow.ts: depositFollows's line moved; update this test's hook");
      return { ...r, source: `${src.replace(anchor, "function depositFollows__recorded(h: FollowHost) {")}
export function depositFollows(h) { const api = depositFollows__recorded(h); const log = (globalThis.__ctFollowCalls ??= []); for (const k of ["storeClosed", "settle"]) { const f = api[k]; api[k] = (...a) => (log.push(k === "settle" && /at open \\(.*\\/src\\/main\\.ts/.test(String(new Error().stack)) ? "settle:open" : k), f(...a)); } return api; }
` };
    }
    return r;
  },
});

// after the hooks, so the note store module is the recorded one (a static import would load it first)
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");

// the published 7f..7f entropy vector (BIP-39's)
const ENTROPY = () => new Uint8Array(16).fill(0x7f);
const SEED64 = wordsToSeed64(entropyToWords(ENTROPY()));
const U = (i: number): string => {
  const u = depositId(SEED64, SCOPE, i);
  u.secretKey.fill(0);
  return u.id;
};

// ---- a minimal DOM: what main.ts, src/shell.ts and src/backdrop.ts touch ----
class El extends EventTarget {
  id = "";
  hidden = false;
  textContent = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
  attrs: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  append(...c: El[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: El[]) {
    this.children = c;
  }
  insertBefore(n: El, ref: El) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
  }
  remove() {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
}
const posted: { v: number; id?: string; ok?: boolean; error?: { code: string } }[] = [];
const frameWindow = { postMessage: (m: (typeof posted)[number]) => void posted.push(m) };
class Frame extends El {
  src = "";
  contentWindow = frameWindow;
}
const win = new EventTarget();
const doc = Object.assign(new EventTarget(), {
  body: new El("body"),
  visibilityState: "visible",
  defaultView: globalThis,
  createElement: (t: string) => (t === "iframe" ? new Frame(t) : new El(t)),
});
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  window: globalThis,
  top: globalThis,
  document: doc,
  addEventListener: win.addEventListener.bind(win),
  removeEventListener: win.removeEventListener.bind(win),
  location: { origin: "https://sign.test", pathname: "/", search: "", href: "https://sign.test/", reload() {} },
  history: { replaceState() {} },
  matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  KeyboardEvent: class extends Event {},
});
// main.ts's channels live as long as the page: let the test's process end with them open
const BC = globalThis.BroadcastChannel;
g.BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};

// ---- the helper: every request recorded, each answered 503 ----
const asked: string[] = [];
g.fetch = async (_url: unknown, init?: RequestInit) => {
  asked.push(String(init?.body ?? ""));
  return new Response("{}", { status: 503 });
};

/** Asks deposit.quote as the APP_HOST frame does, and waits for its answer. */
async function quote(): Promise<{ code: string; body: string | undefined }> {
  const id = crypto.randomUUID();
  const from = asked.length;
  const e = new Event("message");
  Object.defineProperties(e, {
    origin: { value: APP_ORIGIN },
    source: { value: frameWindow },
    data: { value: { v: 1, id, type: "deposit.quote", origin_asset: SOL_USDC, amount: "25" } },
  });
  win.dispatchEvent(e);
  for (let t = 0; t < 500; t++) {
    const a = posted.find((m) => m.id === id);
    if (a) return { code: a.ok ? "ok" : a.error!.code, body: asked.slice(from).find((b) => b.length > 0) };
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("no answer to deposit.quote");
}
/** Asks `state` as the APP_HOST frame does, and waits for its result. */
async function askState(): Promise<{ signed_in: boolean; pools?: unknown }> {
  const id = crypto.randomUUID();
  // the app on this kit names its version before it asks, as the kit's client does (card kit-frame-version)
  const hello = new Event("message");
  Object.defineProperties(hello, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION } } });
  win.dispatchEvent(hello);
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, type: "state" } } });
  win.dispatchEvent(e);
  for (let t = 0; t < 500; t++) {
    const a = posted.find((m) => m.id === id) as { ok?: boolean; result?: { signed_in: boolean; pools?: unknown } } | undefined;
    if (a?.ok) return a.result!;
    if (a) throw new Error("state refused");
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("no answer to state");
}
const recordOf = async (w: WalletStore) => (await w.get("meta", `deposit/${SCOPE}`)) as { index: number; id: string } | undefined;
const plannedOf = async (w: WalletStore) => {
  const ns = await openNoteStore(w);
  try {
    return (await ns.list()).filter((n) => n.ref.kind === "deposit" && n.state === "PLANNED");
  } finally {
    ns.close();
  }
};
async function until(what: string, ok: () => Promise<boolean>): Promise<void> {
  for (let t = 0; t < 300; t++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never: ${what}`);
}

test("main.ts wires the namer: a landing names, a quote waits for it, a notes change and a resync name again", async () => {
  // another tab signed in before this page loads: the 12 words typed, saved
  let other = await openWalletStore({});
  await other.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 1 });

  // the page's own scope, read unhooked, is the v1 record's
  const { vaultScope } = await import("../src/withdraw/checks.ts");
  assert.equal(vaultScope("mainnet"), SCOPE);
  await import("../src/main.ts");
  const app = doc.body.children.find((c) => c.tagName === "iframe");
  assert.ok(app, "the shell framed APP_HOST");
  app.dispatchEvent(new Event("load"));

  // 1. at boot: the quote waits for the first load's landing and its naming, then asks the helper with U of the
  // note store's one PLANNED deposit index
  const first = await quote();
  assert.equal(first.code, "down", "the quote at boot did not reach the helper (no U named, or not waited for)");
  const rec1 = await recordOf(other);
  const planned1 = await plannedOf(other);
  assert.equal(planned1.length, 1);
  assert.equal(rec1?.index, (planned1[0]!.ref as { i: number }).i);
  assert.equal(rec1?.id, U(rec1!.index));
  assert.ok(first.body?.includes(U(rec1!.index)), "the helper was not asked with U of the planned index");

  // 2. another tab: money reached that index and the note left PLANNED; this page hears the notes change and names
  // the next index, and the next quote carries it
  const ns = await openNoteStore(other);
  await ns.move(planned1[0]!.id, "PLANNED", "INCOMING");
  ns.close();
  await until("the notes change named the next index", async () => (await recordOf(other))?.index !== rec1!.index);
  const rec2 = (await recordOf(other))!;
  const second = await quote();
  assert.equal(second.code, "down");
  assert.ok(second.body?.includes(U(rec2.index)), "the second quote did not carry the next index's U");
  assert.ok(!second.body?.includes(U(rec1!.index)), "the second quote carried the funded index's U");

  // state.pools: an INCOMING note has no value yet; once it lands (UNSPENT, its leaf) the next state counts it
  const s0 = await askState();
  assert.equal(s0.signed_in, true);
  const fromPageNotes = (name: string) => calls.filter((c) => c.name === name && /\bpageNotes\b/.test(c.stack));
  assert.equal(fromPageNotes("openNoteStore").length, 0, "pageNotes opened the note store, which writes on open and list");
  assert.ok(fromPageNotes("readNotes").length > 0, "pageNotes did not read with readNotes");
  assert.deepEqual(s0.pools, [{ chain: "near", asset: "USDC", balance: "0" }], "the shell's state carries no pools of the page's notes");
  const n2 = await openNoteStore(other);
  const p1 = planned1[0]!;
  await n2.move(p1.id, "INCOMING", "UNSPENT", { leaf: { value: 25_000_000n, label: 77n, commitment: noteCommitment(25_000_000n, 77n, p1.precommitment), leafIndex: 0n } });
  n2.close();
  assert.deepEqual((await askState()).pools, [{ chain: "near", asset: "USDC", balance: "25" }]);
  assert.equal(fromPageNotes("openNoteStore").length, 0, "pageNotes opened the note store");

  // 3. another tab signs out and signs in again: the store starts over (no record), the page resyncs and names; a quote
  // asked as the resync starts waits for that naming
  const layer = doc.body.children.find((c) => c.tagName === "section")!;
  const root = layer.children.find((c) => c.tagName === "main")!;
  assert.equal(root.dataset.signin, "signed-in");
  await other.signOut();
  await until("this page shows signed out", async () => root.dataset.signin !== "signed-in");
  other = await openWalletStore({});
  await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(await recordOf(other), undefined);
  const heard = new BC("ct-wallet");
  let once = false;
  const asking = new Promise<{ code: string; body: string | undefined }>((ok, no) => {
    heard.onmessage = (m) => {
      const e = m.data as { kind?: string; stores?: string[] };
      if (once || e?.kind !== "changed" || !e.stores?.includes("meta")) return;
      once = true;
      quote().then(ok, no);
    };
  });
  await other.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 2 });
  const third = await asking;
  heard.close();
  assert.equal(third.code, "down", "a quote asked as the resync started did not wait for the resync's naming");
  const rec3 = (await recordOf(other))!;
  assert.ok(third.body?.includes(U(rec3.index)));
  other.close();
});

test("main.ts wires the pool kinds: on a page that pins no pool (this file plants SOL_POOLS empty), each is refused not_allowed and nothing is fetched", async () => {
  const cases = [
    { type: "pool.deposit", chain: "solana", amount: "1" },
    { type: "pool.buy", chain: "base", token: "0xF111111111111111111111111111111111111111", amount: "1", slippage_bps: 100 },
    { type: "pool.sell", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "1", slippage_bps: 100 },
    // Solana's buy and withdraw: refused by the missing pin itself (src/pool-kinds.ts deps.pinned and the flow's own
    // pin), so a pinned pool would answer them otherwise
    { type: "pool.buy", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.001", slippage_bps: 100 },
    { type: "pool.withdraw", chain: "solana", return_key: "portfolio" },
    // a Robinhood withdraw is refused whatever the pins: the flow runs Solana only until its EVM card
    { type: "pool.withdraw", chain: "robinhood", return_key: "portfolio" },
  ] as const;
  const want = cases.map((c) => `${c.type} ${c.chain}: not_allowed, 0 fetch(es)`);
  const got: string[] = [];
  for (const data of cases) {
    const id = crypto.randomUUID();
    const from = asked.length;
    const e = new Event("message");
    Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, ...data } } });
    win.dispatchEvent(e);
    let a: { ok?: boolean; error?: { code: string } } | undefined;
    for (let t = 0; t < 500 && !a; t++) {
      a = posted.find((m) => m.id === id) as typeof a;
      if (!a) await new Promise((ok) => setTimeout(ok, 10));
    }
    got.push(`${data.type} ${data.chain}: ${a?.ok === false ? a.error?.code : a?.ok ? "ok" : "no answer"}, ${asked.length - from} fetch(es)`);
  }
  // every case at once, so a change names each kind it lets through
  assert.deepEqual(got, want);
});

// card pool-restore-wired: the app's restore (apps/terminal/src/screens/signin/source.tsx) reaches a kind of the page's
// own: answered started, then its progress to done; this file plants SOL_POOLS empty, so it reads nothing (the pinned
// mainnet page: test/main-mainnet-pools.test.ts and scripts/live-checks/pool-restore-wired.mjs).
// Signed in again here (the test above ended signed out), as a sign-in from another tab
test("main.ts wires the restore kind: answered started, its progress reading then done, no fetch on a page that pins no pool (planted)", async () => {
  // its own wait, 15 s: a loaded machine runs the store's open, the locks and the run slower than until's 3 s
  const long = async (what: string, ok: () => Promise<boolean>) => {
    for (let t = 0; t < 1500; t++) if (await ok()) return;
    else await new Promise((r) => setTimeout(r, 10));
    throw new Error(`never: ${what}`);
  };
  const w = await openWalletStore({});
  if (!(await w.get("meta", "seed"))) await w.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 3 });
  await long("signed in", async () => (await askState()).signed_in);
  const id = crypto.randomUUID();
  const from = asked.length;
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, type: "restore" } } });
  win.dispatchEvent(e);
  const mine = () => (posted as { id?: string; ok?: boolean; result?: unknown; error?: { code: string }; stage?: string }[]).filter((m) => m.id === id);
  await long("restore answered", async () => mine().length > 0);
  assert.deepEqual(mine()[0], { v: 1, id, ok: true, result: { stage: "started" } });
  await long("restore done", async () => mine().some((m) => m.stage === "done"));
  assert.deepEqual(mine().slice(1).map((m) => m.stage), ["reading", "done"]);
  assert.equal(asked.length - from, 0);
  assert.equal(((await w.get("ops", id)) as { kind?: string; stage?: string } | undefined)?.stage, "done");
  w.close();
});

// review of e31892ef (P3-5): the page's restore host tells each reason a run ends stalled; the run tells it however it
// ends (src/pool-restore.ts, its planted test)
test("main.ts wires the restore's end: a stalled run's reasons go to this device's console", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const host = /const restore = !framed\n  \? poolRestore\(\{\n([\s\S]*?)\n    \}\)\n  : null;/.exec(src)?.[1] ?? "";
  assert.match(host, /^      ended: \(stage, why\) => void \(stage === "stalled" && console\.warn\(`restore stalled: \$\{why\.join\("; "\)\}`\)\),$/m);
});

// fold 5 (review LOW): the page's seed re-read on another tab's write is walletSeedMoved's call, which skips an owed
// send's write (meta owed/<op id>); its behaviour is the store's test (packages/wallet/test/store.test.ts)
test("main.ts reads its seed again on another tab's write only as walletSeedMoved says: an owed send's write is none", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const body = /function storeMoved\(e: WalletEvent\): void \{\n([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  assert.match(body, /^  if \(walletSeedMoved\(e\)\) moved \+= 1;\n  else return;/, "storeMoved counts a move only by walletSeedMoved");
  assert.ok(!/e\.stores\.includes\("meta"\)/.test(body), "no meta test of its own");
  assert.match(src, /import \{[^}]*\bwalletSeedMoved\b[^}]*\} from "@blindfill\/wallet\/store";/);
});

test("main.ts wires the deposit follows to the store's connection: a close ends them, and the next open settles them again (card wallet-deposit-follow)", async () => {
  // main.ts is booted by the first test
  const follows = ((globalThis as { __ctFollowCalls?: string[] }).__ctFollowCalls ??= []);
  const other = await openWalletStore({});
  await other.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 3 });
  await new Promise((ok) => setTimeout(ok, 50));
  // a quote opens the store: with no close before it, the follows are not settled from open()
  const from = follows.length;
  await quote();
  assert.ok(!follows.slice(from).includes("storeClosed"));
  assert.ok(!follows.slice(from).includes("settle:open"), "settled from open() with no close");
  // a delete with no sign out (another tab's upgrade closes the connection the same way, versionchange): the page's
  // connection closes and the follows end at once
  other.close();
  await new Promise<void>((ok, no) => {
    const r = indexedDB.deleteDatabase("ct-wallet");
    r.onsuccess = () => ok();
    r.onerror = () => no(r.error);
  });
  await until("the close ended the follows", async () => follows.slice(from).includes("storeClosed"));
  assert.ok(!follows.slice(from).includes("settle:open"), "settled before the store opened again");
  // the next step that opens the store (here a quote and a state read, after a sign in in another tab) opens it again,
  // and the follows are settled on it
  const again = await openWalletStore({});
  await again.insertSeed({ v: 1, entropy: ENTROPY(), source: "code", code_saved: true, created_ms: 4 });
  await new Promise((ok) => setTimeout(ok, 50));
  await quote();
  await askState().catch(() => {});
  await until("the follows settled from open() on the store opened again", async () => follows.slice(from).includes("settle:open"));
  assert.equal(follows.slice(from).filter((k) => k === "settle:open").length, 1, "settled from open() once");
  again.close();
});
