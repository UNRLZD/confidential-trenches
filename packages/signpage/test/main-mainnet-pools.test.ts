// src/main.ts booted top-level as SIGN_HOST's build, the mainnet one (card signpage-pool-mainnet), on the wallet's
// mainnet pool pin (SOL_POOLS.mainnet, card sol-pools-mainnet-pin) and its lookup table (MAINNET_TABLE, the deploy
// record's): the same pool flow and proof queue the testnet build runs
// (src/pool-testnet.ts) run here. The shell's state lists the pinned pool with the queue's ready proof as `ready`, the
// page's own price and tap_max from the Rent read on the page's mainnet pair; pool.deposit, pool.buy, pool.sell and
// pool.withdraw reach that flow, never refused not_allowed. Stand-ins as test/main-testnet-pools.test.ts: testnetPool's
// readyWith answers a planted ready proof, poolPrices reads a planted price, and every RPC is a fetch that answers the
// Rent sysvar's account read and refuses anything else. With no pin, every pool kind is refused not_allowed with no
// read: test/main-wiring.test.ts.
//   node --test test/main-mainnet-pools.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { base64 } from "@scure/base";
import { openWalletStore } from "@blindfill/wallet/store";
import { APP_ORIGIN } from "../src/api.ts";
import { SIGNPAGE_KIT_VERSION } from "../../kit/src/signpage/messages.ts";
import { ONECLICK_USDC_ASSETS } from "../../kit/src/checks/oneclick.ts";

const wrap = (src: string, name: string, body: string): string => {
  const anchor = `export function ${name}(`;
  if (!src.includes(anchor)) throw new Error(`${name}: its line moved; update this test's hook`);
  return `${src.replace(anchor, `function ${name}__real(`)}\n${body}\n`;
};
// the build's table of the chains whose withdraw it carries (POOL_WITHDRAW_BUILT), read live from globalThis.__ctBuilt so
// a test can plant a build without one chain's withdraw (unset: the real table)
const BUILT = "Object.freeze({ solana: true, base: true, robinhood: true })";
const plantBuilt = (src: string): string => {
  if (src.split(BUILT).length !== 2) throw new Error("POOL_WITHDRAW_BUILT: its line moved; update this test's hook");
  const live = ["solana", "base", "robinhood"].map((c) => `get ${c}() { return globalThis.__ctBuilt?.${c} ?? true; }`).join(", ");
  return src.replace(BUILT, `({ ${live} })`);
};
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pool-testnet.ts"))
      return { ...r, source: plantBuilt(wrap(String(r.source), "testnetPool", "export function testnetPool(page, over) { return { ...testnetPool__real(page, over), readyWith: async (read) => ({ ready: globalThis.__ctReady, value: await read() }) }; }")) };
    // the restore host main.ts builds, kept for the wiring test below
    if (url.endsWith("/signpage/src/pool-restore.ts"))
      return { ...r, source: wrap(String(r.source), "poolRestore", "export function poolRestore(h) { globalThis.__ctRestoreHost = h; return poolRestore__real(h); }") };
    if (url.endsWith("/signpage/src/pool-price.ts"))
      return { ...r, source: wrap(String(r.source), "poolPrices", "export function poolPrices(deps) { return poolPrices__real({ ...deps, read: globalThis.__ctPriceRead, after: (ms, fn) => void setTimeout(fn, ms).unref() }); }") };
    return r;
  },
});
const { SOL_POOLS, solanaPoolOf, SOL_TIP_CAP, solanaEpochFee } = await import("../../wallet/src/pool/solana.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteCommitment } = await import("../../wallet/src/notes/secrets.ts");
const { solanaTapSpendOf } = await import("../../wallet/src/pool/balances.ts");
// the tip the page's buy pays (card max-is-what-you-hold-after-a-trade: Max is priced at it, never at the tip cap)
const { pageBuyTip } = await import("../src/pools.ts");

const PROGRAM = SOL_POOLS.mainnet!.program;
const SCOPE = solanaPoolOf(PROGRAM).scope;
const CHUNK = 50_000_000n; // 0.05 SOL
const RENT = { lamportsPerByte: 3480n, factor: 2n } as const;
const FEE_CAP = solanaEpochFee(RENT).fee;
const PRICE = { price: 15_012_345_678n, expo: -8 };
const gl = globalThis as Record<string, unknown>;
gl.__ctPriceRead = async () => ({ chain: "solana", asset: "SOL", decimals: 9, price: PRICE.price, expo: PRICE.expo, publishedS: Math.floor(Date.now() / 1000) - 2 });

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
type Answer = { v: number; id?: string; ok?: boolean; result?: unknown; error?: { code: string } };
// each request's waiter, called in the very call the page posts its answer (card signpage-pool-address-test-no-answer):
// a wait ends on the page's own answer, never on a poll of the real clock. A page that never answers holds the test
// until its own { timeout } (HANG_MS), which the runner enforces: red, with the test's name
const waiters = new Map<string, (m: Answer) => void>();
const frameWindow = {
  postMessage: (m: Answer) => {
    if (typeof m.id === "string" && "ok" in m) waiters.get(m.id)?.(m);
  },
};
/** A test's hang bound: far past any answer this file's stand-ins give (tens of ms each), so only a page that never
 *  answers reaches it, however starved the machine. */
const HANG_MS = 120_000;
const HANG = { timeout: HANG_MS } as const;
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

// ---- the RPCs: the Rent sysvar's account read, and a JSON-RPC error for anything else ----
const rentData = new Uint8Array(17);
new DataView(rentData.buffer).setBigUint64(0, RENT.lamportsPerByte, true);
new DataView(rentData.buffer).setFloat64(8, 2, true);
rentData[16] = 50;
const rentReads: string[] = [];
/** Every JSON-RPC call the page makes: its URL and method. */
const calls: { url: string; method: string }[] = [];
const SELL_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const mintData = new Uint8Array(82);
mintData[44] = 6;
mintData[45] = 1;
/** While set, every Solana read but the Rent's and the sold mint's waits on it until the test releases it (review P3-3):
 *  the landing's settle pass's reads, held, as a provider that is down and retried holds them; heldReads counts them. */
let hold: Promise<void> | undefined;
let heldReads = 0;
// settled at the first read the hold meets, in that read's own call: the test waits for it on no clock
let heldMet!: () => void;
const firstHeld = new Promise<void>((ok) => (heldMet = ok));
g.fetch = async (url: unknown, init?: RequestInit) => {
  let body: { id?: unknown; method?: string; params?: unknown[] } = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {}
  const id = body.id ?? 1;
  calls.push({ url: String(url), method: String(body.method) });
  const rentOrMint = body.method === "getAccountInfo" && (body.params?.[0] === "SysvarRent111111111111111111111111111111111" || body.params?.[0] === SELL_MINT);
  if (hold && typeof body.method === "string" && !rentOrMint && !String(url).includes("/oneclick/")) {
    heldReads++;
    heldMet();
    await hold;
  }
  if (body.method === "getAccountInfo" && body.params?.[0] === "SysvarRent111111111111111111111111111111111") {
    rentReads.push(String(url));
    const value = { owner: "Sysvar1111111111111111111111111111111111111", data: [base64.encode(rentData), "base64"], lamports: 1009200, executable: false, rentEpoch: 0, space: 17 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }), { status: 200 });
  }
  // the sold token's mint (an SPL Token mint, 6 decimals, initialized): pool.sell's decimals read on the page's pair
  if (body.method === "getAccountInfo" && body.params?.[0] === SELL_MINT) {
    const value = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: [base64.encode(mintData), "base64"], lamports: 1461600, executable: false, rentEpoch: 0, space: 82 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }), { status: 200 });
  }
  // a sell W's holdings: no SOL and no token account, at slot 1 (the sell then answers not_funded)
  if (body.method === "getBalance") return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: 0 } }), { status: 200 });
  if (body.method === "getTokenAccountsByOwner") return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: [] } }), { status: 200 });
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not in this test" } }), { status: 200 });
};

const byId = (el: El, id: string): El | undefined => (el.id === id ? el : el.children.map((c) => byId(c, id)).find((x) => x !== undefined));
/** Sends `data` as the APP_HOST frame does, under a fresh id; the page's answer to it, once the page posts it. While a
 *  sheet shows (src/sheet.ts's layer, #screen), the shell reads no message from the frame (src/shell.ts listen) and none
 *  is ever answered: refused here at once, by name. That was PR 597's "no answer to pool.address" (job 130133309042):
 *  the pool.withdraw test ran before these asks then, and its screen took the frame away FRAME_LEAVE_MS (100 ms of real
 *  time) after it opened, so on a slow runner an ask past those 100 ms went to no frame. */
function askPage(data: Record<string, unknown>): Promise<Answer> {
  const screen = byId(doc.body, "screen");
  if (screen !== undefined && !screen.hidden) throw new Error(`${String(data.type)}: asked while a sheet shows, when the shell reads no message from the frame; ask it before the test that opens one`);
  const id = crypto.randomUUID();
  const answered = new Promise<Answer>((ok) => waiters.set(id, ok));
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, ...data } } });
  win.dispatchEvent(e);
  return answered.finally(() => waiters.delete(id));
}

/** Asks deposit.quote as the APP_HOST frame does; its answer's code (any: this test's helper refuses the quote). */
async function askQuote(): Promise<string> {
  const a = await askPage({ type: "deposit.quote", origin_asset: ONECLICK_USDC_ASSETS[1], amount: "25" });
  return a.ok ? "ok" : a.error!.code;
}

async function askState(): Promise<{ signed_in: boolean; pools?: { chain: string; ready?: string; tap_max?: string; price?: { price: string; expo: number } }[] }> {
  // the app on this kit names its version before it asks, as the kit's client does (card kit-frame-version)
  const hello = new Event("message");
  Object.defineProperties(hello, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, type: "hello", kit: SIGNPAGE_KIT_VERSION } } });
  win.dispatchEvent(hello);
  const a = await askPage({ type: "state" });
  if (!a.ok) throw new Error("state refused");
  return a.result as Awaited<ReturnType<typeof askState>>;
}

/** Asks pool.address with `data`; the page's answer. */
const askAddress = (data: Record<string, unknown>): Promise<Answer> => askPage({ type: "pool.address", ...data });

test("the mainnet build's state with a pinned pool: the queue's ready proof as ready, the page's price, and tap_max once the Rent is read", HANG, async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  // a deposit note landed and HELD by a proof of attempt a1
  const ns = await openNoteStore(w);
  const p = await ns.planDeposit(SCOPE, () => 1n);
  await ns.move(p.id, "PLANNED", "INCOMING", { send: { signature: "1".repeat(64), value: CHUNK, last_valid_block_height: 1n } });
  await ns.move(p.id, "INCOMING", "UNSPENT", { leaf: { value: CHUNK, label: 1n, commitment: noteCommitment(CHUNK, 1n, p.precommitment), leafIndex: 0n } });
  // the holding tab's note store stays open, as the queue's does: a closed one is a dead tab, whose HELD notes are freed
  const held = await ns.move(p.id, "UNSPENT", "HELD", { deadlineMs: BigInt(Date.now() + 600_000), context: "1" });
  g.__ctReady = [{ noteId: held.id, attempt: held.attempt, poolId: `sol:${PROGRAM}`, chunk: CHUNK, wallet: { l: 1n, j: 0, address: "W" }, binding: { feeCap: FEE_CAP, request: { tipCap: SOL_TIP_CAP } } }];

  // review P3-3 (card sol-pools-mainnet-pin): the landing's settle pass (src/pool-testnet.ts settle, a pool.deposit run)
  // holds the seed lock shared across its Solana reads, and a deposit.quote waits for the landing's naming, whose write
  // takes that lock exclusive: the pass starts only once the naming is written, so a slow provider never holds the quote
  // proven by order, not by a clock: the settle pass's Solana reads are held until the quote has answered, so a quote
  // that waits for them never answers
  let release!: () => void;
  hold = new Promise((ok) => (release = ok));
  await import("../src/main.ts");
  const app = doc.body.children.find((c) => c.tagName === "iframe");
  assert.ok(app, "the shell framed APP_HOST");
  app.dispatchEvent(new Event("load"));
  const quoted = await askQuote().then(() => true, () => false);
  // the settle pass did run into the hold (waited for by its first held read, on no clock): the quote above answered
  // beside it. A quote that waits behind the held reads never answers, and the test's own timeout ends it red
  await firstHeld;
  const heldSeen = heldReads;
  hold = undefined;
  release();
  assert.ok(quoted, `deposit.quote at boot never answered while the settle pass's Solana reads were held (${heldSeen} held): it waits behind them`);
  assert.ok(heldSeen > 0, "the settle pass's Solana reads never met the hold, so this test held nothing");

  const want = `0.${solanaTapSpendOf(RENT, undefined, pageBuyTip)([{ chunk: CHUNK, feeCap: FEE_CAP, tipCap: SOL_TIP_CAP }]).toString().padStart(9, "0")}`.replace(/0+$/, "");
  let pool: NonNullable<Awaited<ReturnType<typeof askState>>["pools"]>[number] | undefined;
  // the first state starts the price and Rent reads; each landing is heard, so a later state carries them
  // until both have landed: each state is the page's own answer, and a page that never lands them meets HANG_MS
  for (;;) {
    const s = await askState();
    assert.equal(s.signed_in, true);
    pool = s.pools?.find((x) => x.chain === "solana");
    if (pool?.price && pool.tap_max) break;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  assert.equal(pool?.ready, "0.05", "the queue's ready proof reaches state.pools as ready");
  assert.deepEqual([pool?.price?.price, pool?.price?.expo], [PRICE.price.toString(), PRICE.expo], "the page's own price");
  assert.equal(pool?.tap_max, want, "tap_max from the Rent sysvar read on the page's pair");
  assert.ok(rentReads.length >= 2 && new Set(rentReads.map((u) => new URL(u).host)).size === 2, `the Rent read on two hosts: ${rentReads.join(", ")}`);
  ns.close();
  w.close();
});

test("the mainnet build's pool reads on the network's own pair and fee route: SIGN_HOST's provider A and the helper's keyed route, and GET /v1/pool/fee with cluster=mainnet", async () => {
  const { pageSolanaRpcs, poolRelayFee, PAGE_CLUSTER, PAGE_SOL_PIN, PAGE_TABLES } = await import("../src/pool-testnet.ts");
  const { SOL_MAINNET_DEPLOY, SOL_POOL_TABLES } = await import("../../wallet/src/pool/solana.ts");
  assert.equal(PAGE_CLUSTER, "mainnet");
  assert.equal(PAGE_SOL_PIN, SOL_POOLS.mainnet, "the mainnet pin, never the devnet one");
  assert.ok(PAGE_SOL_PIN !== undefined && PAGE_SOL_PIN.program === SOL_MAINNET_DEPLOY.program, "the deploy record's program");
  assert.equal(PAGE_TABLES, SOL_POOL_TABLES.mainnet, "pool.buy loads the mainnet tables by venue");
  assert.equal(PAGE_TABLES["pump-curve"]?.[0], SOL_MAINNET_DEPLOY.table, "the curve's first generation is the deploy record's lookup table");
  // the pair: one read each, to two hosts
  const before = rentReads.length;
  const [a, b] = pageSolanaRpcs();
  await a("getAccountInfo", ["SysvarRent111111111111111111111111111111111", { encoding: "base64" }]);
  await b("getAccountInfo", ["SysvarRent111111111111111111111111111111111", { encoding: "base64" }]);
  assert.deepEqual(
    rentReads.slice(before).map((u) => new URL(u).origin),
    ["https://solana-rpc.publicnode.com", "https://ct-api.unrealized.trade"],
  );
  const pool = solanaPoolOf(PROGRAM).pool;
  const asked: string[] = [];
  const fetchFn = (async (url: string | URL | Request) => (asked.push(String(url)), new Response("{}", { status: 404 }))) as typeof fetch;
  await assert.rejects(poolRelayFee(pool, 1_800_000_000_000n, undefined, fetchFn), /HTTP 404/);
  assert.equal(asked[0], `https://ct-api.unrealized.trade/v1/pool/fee?cluster=mainnet&pool=${pool}&epoch=1800000000000`);
});

test("pool.address's quote reads the price for the origin asked (main.ts pricedFor, review of eb2dfdc5 W2): USDC goes on to the floor read; any other origin gets no price, refused not_allowed with no read", HANG, async () => {
  const ask = askAddress;
  // the page names U_X under the pinned pool's scope, and holds its own price
  let named: { ok?: boolean } = {};
  for (let t = 0; t < 50 && !named.ok; t++) named = await ask({ chain: "solana" });
  assert.equal(named.ok, true, JSON.stringify(named));
  assert.ok((await askState()).pools?.find((p) => p.chain === "solana")?.price, "the page holds its price");
  // USDC: priced, so the quote goes on to the floor read on the page's pair, which this test's RPCs refuse: down
  const usdc = await ask({ chain: "solana", origin_asset: ONECLICK_USDC_ASSETS[1], amount: "25" });
  assert.equal(usdc.error?.code, "down", JSON.stringify(usdc));
  // another origin: no price for it, so no floor read and no quote asked
  const from = calls.length;
  const other = await ask({ chain: "solana", origin_asset: "nep141:wrap.near", amount: "25" });
  assert.equal(other.error?.code, "not_allowed", JSON.stringify(other));
  assert.deepEqual(calls.slice(from).filter((c) => c.url.includes("/oneclick/")), [], "no quote asked for an unpriced origin");
});

test("card evm-deposit-on-mainnet: on the mainnet build pool.address gives Base's and Robinhood's U_X as it gives Solana's, each the one-time wallet of the chain's pool scope (the build carries their withdraw)", HANG, async () => {
  const ask = askAddress;
  let named: { ok?: boolean } = {};
  for (let t = 0; t < 50 && !named.ok; t++) named = await ask({ chain: "solana" });
  assert.equal(named.ok, true, JSON.stringify(named));
  for (const chain of ["base", "robinhood"]) {
    let got: { ok?: boolean; result?: unknown; error?: { code: string } } = {};
    for (let t = 0; t < 50 && !got.ok; t++) got = await ask({ chain });
    assert.equal(got.ok, true, `${chain}: ${JSON.stringify(got)}`);
    const address = (got.result as { address?: unknown } | undefined)?.address;
    assert.match(String(address), /^0x[0-9a-fA-F]{40}$/, `${chain}: an EVM U_X`);
  }
});

test("review of 56a57ed2, card evm-deposit-on-mainnet: main.ts's restore host says this mainnet build gives a deposit address on Solana, Base and Robinhood, as pool.address does", () => {
  const h = (globalThis as { __ctRestoreHost?: { addressed?: (chain: string) => boolean; ux?: (chain: string) => unknown } }).__ctRestoreHost;
  assert.ok(h?.addressed, "the page's restore host has its addressed wiring");
  assert.deepEqual(["solana", "base", "robinhood"].map((c) => [c, h.addressed!(c)]), [["solana", true], ["base", true], ["robinhood", true]]);
  // and each addressed chain has its U_X reads, so a restore reads every U_X it could have paid and none stalls it unread
  assert.deepEqual(["solana", "base", "robinhood"].map((c) => [c, h.ux?.(c) != null]), [["solana", true], ["base", true], ["robinhood", true]]);
});

test("review P2-1 (G3), the one rule at its doors: a build planted to carry no Base withdraw gives no Base deposit address on pool.address, and its restore host says Base is not addressed; Robinhood as before", HANG, async () => {
  const ask = askAddress;
  const h = (globalThis as { __ctRestoreHost?: { addressed?: (chain: string) => boolean } }).__ctRestoreHost;
  gl.__ctBuilt = { base: false };
  try {
    const got = await ask({ chain: "base" });
    assert.notEqual(got.ok, true, `base: ${JSON.stringify(got)}`);
    assert.equal(got.error?.code, "not_allowed", `base: ${JSON.stringify(got)}`);
    assert.equal(h?.addressed?.("base"), false, "the restore host: no Base address on this build");
    assert.equal(h?.addressed?.("robinhood"), true, "the restore host: Robinhood as before");
    let rh: { ok?: boolean } = {};
    for (let t = 0; t < 50 && !rh.ok; t++) rh = await ask({ chain: "robinhood" });
    assert.equal(rh.ok, true, `robinhood: ${JSON.stringify(rh)}`);
  } finally {
    delete gl.__ctBuilt;
  }
});

// last in this file: pool.withdraw opens the page's screen, and while a sheet shows the shell reads no message from the
// frame (src/shell.ts listen), so a test after it would get no answer (card signing-views-open-over-the-app)
test("with a mainnet pin, pool.deposit, pool.buy, pool.sell and pool.withdraw reach the page's pool flow: none is refused not_allowed", HANG, async () => {
  // a note of the pool's scope another device spent: its buy's W is the sell's to read, on the helper's keyed route only
  const w = await openWalletStore({});
  const ns = await openNoteStore(w);
  const p = await ns.planDeposit(SCOPE, () => 2n);
  await ns.move(p.id, "PLANNED", "INCOMING", { send: { signature: "2".repeat(64), value: CHUNK, last_valid_block_height: 1n } });
  await ns.move(p.id, "INCOMING", "UNSPENT", { leaf: { value: CHUNK, label: 2n, commitment: noteCommitment(CHUNK, 2n, p.precommitment), leafIndex: 1n } });
  await ns.move(p.id, "UNSPENT", "SPENT", {});
  const ask = async (data: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const a = await askPage(data);
    assert.notEqual(a.error?.code, "not_allowed", `${String(data.type)} was refused not_allowed: it never reached the flow`);
    const { v: _v, id: _id, ...got } = a as Record<string, unknown>;
    return got;
  };
  let from = calls.length;
  // each answer is the flow's own (src/pool-testnet.ts): the deposit's reads fail on this test's RPCs, the buy finds no
  // proof it may spend and the sell no W holding the token, and the withdraw opens the page's screen
  for (const [data, want] of [
    [{ type: "pool.deposit", chain: "solana", amount: "0.02" }, { ok: false, error: { code: "failed" } }],
    [{ type: "pool.buy", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.001", slippage_bps: 100 }, { ok: false, error: { code: "not_funded" } }],
    [{ type: "pool.sell", chain: "solana", token: SELL_MINT, amount: "1", slippage_bps: 100 }, { ok: false, error: { code: "not_funded" } }],
  ] as const) {
    assert.deepEqual(await ask(data), want, `${data.type}: the flow's own answer`);
  }
  // the page's own positions pass at sign in kept a whole pass that lists no W (card pool-sell-legs-side-by-side):
  // this device has no buy record of its W, so the sell reads that W through the finder, on the helper's keyed route
  // only (review of 55d4c6eb, P2-A: a W from before a sign out); no provider is asked for any W's accounts
  const reads = (c: { method: string }) => c.method === "getBalance" || c.method === "getTokenAccountsByOwner" || c.method === "getMultipleAccounts";
  const kept = calls.slice(from).filter(reads);
  assert.ok(kept.some((c) => c.method === "getTokenAccountsByOwner"), "the unrecorded W read through the finder");
  assert.deepEqual([...new Set(kept.map((c) => c.url))], ["https://ct-api.unrealized.trade/v1/rpc/solana"], "a kept pass and an unrecorded W: the W's reads on the helper's route only");
  // with no pass kept (a device whose passes have not run), the sell finds its Ws by their holdings, and only through
  // the helper's keyed route: never on the public provider, which would see the user's W asked from the user's own address
  await w.delete("meta", "owed/positions-sol");
  from = calls.length;
  const sell = { type: "pool.sell", chain: "solana", token: SELL_MINT, amount: "1", slippage_bps: 100 } as const;
  assert.deepEqual(await ask(sell), { ok: false, error: { code: "not_funded" } }, "pool.sell with no pass kept: the flow's own answer");
  const holdings = calls.slice(from).filter((c) => c.method === "getBalance" || c.method === "getTokenAccountsByOwner");
  assert.ok(holdings.length >= 3, `the sell's W holdings were read: ${holdings.length} call(s)`);
  assert.deepEqual([...new Set(holdings.map((c) => c.url))], ["https://ct-api.unrealized.trade/v1/rpc/solana"], "the W's holdings on the helper's route only");
  // pool.withdraw last: its flow opens the page's screen, which takes the app's frame away (shell.ts open, in the open's
  // own task), so an answer after it reaches no frame; its flow opens the screen only as withdraw.open does, on the
  // signed-in page (main.ts openPoolWithdraw): the page is set to it here, since this DOM draws no page
  const find = (el: El): El | undefined => (el.id === "signin" ? el : el.children.map(find).find((x) => x !== undefined));
  const root = find(doc.body);
  assert.ok(root, "the page's root is in the document");
  root.dataset.signin = "signed-in";
  assert.deepEqual(await ask({ type: "pool.withdraw", chain: "solana", return_key: "portfolio" }), { ok: true, result: { pending: true, closes: true } }, "pool.withdraw: the flow's own answer, at kit 1.13 with closes (card signing-layer-says-when-it-closes)");
  ns.close();
  w.close();
});
