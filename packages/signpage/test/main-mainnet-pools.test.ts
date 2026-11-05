// src/main.ts booted top-level as SIGN_HOST's build, the mainnet one (card signpage-pool-mainnet), with a mainnet pool
// pin planted by a load hook (SOL_POOLS.mainnet is empty until pool-sol-deploy-mainnet; the devnet pool's program
// stands in for it, and a lookup table for MAINNET_TABLE): the same pool flow and proof queue the testnet build runs
// (src/pool-testnet.ts) run here. The shell's state lists the pinned pool with the queue's ready proof as `ready`, the
// page's own price and tap_max from the Rent read on the page's mainnet pair; pool.deposit, pool.buy, pool.sell and
// pool.withdraw reach that flow, never refused not_allowed. Stand-ins as test/main-testnet-pools.test.ts: testnetPool's
// ready() answers a planted ready proof, poolPrices reads a planted price, and every RPC is a fetch that answers the
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

const DEVNET_PROGRAM = "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ";
const DEVNET_FEE_PAYER = "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb";
const SOL_LINE = `  POOL_TESTNET ? { devnet: Object.freeze({ program: "${DEVNET_PROGRAM}", feePayer: "${DEVNET_FEE_PAYER}" }) } : {},`;
const TABLE_LINE = "export const MAINNET_TABLE: string | null = null;";
const wrap = (src: string, name: string, body: string): string => {
  const anchor = `export function ${name}(`;
  if (!src.includes(anchor)) throw new Error(`${name}: its line moved; update this test's hook`);
  return `${src.replace(anchor, `function ${name}__real(`)}\n${body}\n`;
};
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pool-testnet.ts"))
      return { ...r, source: wrap(String(r.source).replace(TABLE_LINE, 'export const MAINNET_TABLE: string | null = "4cYEUrtdqrGTMZcsNp7XbYwNNNUBaWKb7fBs6kGMYPYy";'), "testnetPool", "export function testnetPool(page, over) { return { ...testnetPool__real(page, over), ready: async () => globalThis.__ctReady }; }") };
    if (url.endsWith("/wallet/src/pool/solana.ts")) {
      const src = String(r.source);
      if (!src.includes(SOL_LINE)) throw new Error("solana.ts: SOL_POOLS's line moved; update this test's hook");
      return { ...r, source: src.replace(SOL_LINE, SOL_LINE.replace(": {},", `: { mainnet: Object.freeze({ program: "${DEVNET_PROGRAM}", feePayer: "${DEVNET_FEE_PAYER}" }) },`)) };
    }
    if (url.endsWith("/signpage/src/pool-price.ts"))
      return { ...r, source: wrap(String(r.source), "poolPrices", "export function poolPrices(deps) { return poolPrices__real({ ...deps, read: globalThis.__ctPriceRead, after: (ms, fn) => void setTimeout(fn, ms).unref() }); }") };
    return r;
  },
});
const { SOL_POOLS, solanaPoolOf, SOL_TIP_CAP, solanaEpochFee } = await import("../../wallet/src/pool/solana.ts");
const { openNoteStore } = await import("../../wallet/src/notes/store.ts");
const { noteCommitment } = await import("../../wallet/src/notes/secrets.ts");
const { solanaTapSpendOf } = await import("../../wallet/src/pool/balances.ts");

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

// ---- the RPCs: the Rent sysvar's account read, and a JSON-RPC error for anything else ----
const rentData = new Uint8Array(17);
new DataView(rentData.buffer).setBigUint64(0, RENT.lamportsPerByte, true);
new DataView(rentData.buffer).setFloat64(8, 2, true);
rentData[16] = 50;
const rentReads: string[] = [];
g.fetch = async (url: unknown, init?: RequestInit) => {
  let body: { id?: unknown; method?: string; params?: unknown[] } = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {}
  const id = body.id ?? 1;
  if (body.method === "getAccountInfo" && body.params?.[0] === "SysvarRent111111111111111111111111111111111") {
    rentReads.push(String(url));
    const value = { owner: "Sysvar1111111111111111111111111111111111111", data: [base64.encode(rentData), "base64"], lamports: 1009200, executable: false, rentEpoch: 0, space: 17 };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }), { status: 200 });
  }
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "not in this test" } }), { status: 200 });
};

async function askState(): Promise<{ signed_in: boolean; pools?: { chain: string; ready?: string; tap_max?: string; price?: { price: string; expo: number } }[] }> {
  const id = crypto.randomUUID();
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, type: "state" } } });
  win.dispatchEvent(e);
  for (let t = 0; t < 500; t++) {
    const a = posted.find((m) => m.id === id) as { ok?: boolean; result?: Awaited<ReturnType<typeof askState>> } | undefined;
    if (a?.ok) return a.result!;
    if (a) throw new Error("state refused");
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error("no answer to state");
}

test("the mainnet build's state with a pinned pool: the queue's ready proof as ready, the page's price, and tap_max once the Rent is read", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  // a deposit note landed and HELD by a proof of attempt a1
  const ns = await openNoteStore(w);
  const p = await ns.planDeposit(SCOPE, () => 1n);
  await ns.move(p.id, "PLANNED", "INCOMING", { send: { signature: "1".repeat(64), value: CHUNK, last_valid_block_height: 1n } });
  await ns.move(p.id, "INCOMING", "UNSPENT", { leaf: { value: CHUNK, label: 1n, commitment: noteCommitment(CHUNK, 1n, p.precommitment), leafIndex: 0n } });
  // the holding tab's note store stays open, as the queue's does: a closed one is a dead tab, whose HELD notes are freed
  const held = await ns.move(p.id, "UNSPENT", "HELD", { deadlineMs: BigInt(Date.now() + 600_000), context: "1" });
  g.__ctReady = [{ noteId: held.id, attempt: held.attempt, poolId: `sol:${PROGRAM}`, chunk: CHUNK, binding: { feeCap: FEE_CAP, request: { tipCap: SOL_TIP_CAP } } }];

  await import("../src/main.ts");
  const app = doc.body.children.find((c) => c.tagName === "iframe");
  assert.ok(app, "the shell framed APP_HOST");
  app.dispatchEvent(new Event("load"));

  const want = `0.${solanaTapSpendOf(RENT)(CHUNK, FEE_CAP, SOL_TIP_CAP).toString().padStart(9, "0")}`.replace(/0+$/, "");
  let pool: NonNullable<Awaited<ReturnType<typeof askState>>["pools"]>[number] | undefined;
  // the first state starts the price and Rent reads; each landing is heard, so a later state carries them
  for (let t = 0; t < 300; t++) {
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

test("with a mainnet pin, pool.deposit, pool.buy, pool.sell and pool.withdraw reach the page's pool flow: none is refused not_allowed", async () => {
  for (const data of [
    { type: "pool.deposit", chain: "solana", amount: "0.02" },
    { type: "pool.buy", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "0.001", slippage_bps: 100 },
    { type: "pool.sell", chain: "solana", token: "So11111111111111111111111111111111111111112", amount: "1", slippage_bps: 100 },
    { type: "pool.withdraw", chain: "solana" },
  ]) {
    const id = crypto.randomUUID();
    const e = new Event("message");
    Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: frameWindow }, data: { value: { v: 1, id, ...data } } });
    win.dispatchEvent(e);
    let a: { ok?: boolean; error?: { code: string } } | undefined;
    for (let t = 0; t < 1500 && !a; t++) {
      a = posted.find((m) => m.id === id) as typeof a;
      if (!a) await new Promise((ok) => setTimeout(ok, 10));
    }
    assert.ok(a, `${data.type}: answered`);
    assert.notEqual(a?.error?.code, "not_allowed", `${data.type} was refused not_allowed: it never reached the flow`);
  }
});
