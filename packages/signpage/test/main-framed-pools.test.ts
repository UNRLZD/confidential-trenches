// src/main.ts booted in a frame (APP_HOST frames SIGN_HOST) on a minimal DOM with the wallet's real store
// (fake-indexeddb), card balances-per-chain: the frame keeps no note data. Its state carries no `pools`, and nothing on
// the framed path calls the note store's open or withPools, at boot, on a state request or on another tab's change.
// The frame loads the same bundle as the top-level page, so both modules are loaded; a load hook wraps each one's
// export to record every call, and gives the page's pool table one pool, so a call would read notes. The top-level
// side (pools read and sent) is test/main-wiring.test.ts. A separate file: main.ts is imported once per process.
//   node --test test/main-framed-pools.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { APP_ORIGIN } from "../src/api.ts";

const calls: string[] = [];
(globalThis as Record<string, unknown>).__ctPoolCalls = calls;
/** Renames `export async function <name>(` and exports a wrapper that records each call, then calls it. */
const spy = (src: string, name: string, anchor: string): string => {
  if (!src.includes(anchor)) throw new Error(`${name}: its line moved; update this test's hook`);
  return `${src.replace(anchor, `async function ${name}__spied(`)}
export async function ${name}(...a) { globalThis.__ctPoolCalls.push("${name}"); return ${name}__spied(...a); }
`;
};
const TABLE = "export const PAGE_POOLS: readonly BalancePool[] = Object.freeze([]);";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pools.ts")) {
      let src = String(r.source);
      if (!src.includes(TABLE)) throw new Error("pools.ts: PAGE_POOLS's line moved; update this test's hook");
      src = src.replace(TABLE, `export const PAGE_POOLS = Object.freeze([{ id: "near:t", chain: "near", scope: 4242n, one: 1000000n }]);`);
      return { ...r, source: spy(src, "withPools", "export async function withPools(") };
    }
    if (url.endsWith("/wallet/src/notes/store.ts")) return { ...r, source: spy(String(r.source), "openNoteStore", "export async function openNoteStore(") };
    return r;
  },
});

// ---- a minimal DOM: what main.ts touches in a frame ----
class El extends EventTarget {
  id = "";
  hidden = false;
  textContent = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: El[] = [];
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
  remove() {}
  setAttribute() {}
}
type Posted = { v: number; type?: string; id?: string; ok?: boolean; result?: Record<string, unknown>; state?: Record<string, unknown> };
const posted: Posted[] = [];
const parentWin = { postMessage: (m: Posted) => void posted.push(m) };
const win = new EventTarget();
const doc = Object.assign(new EventTarget(), {
  body: new El("body"),
  visibilityState: "visible",
  defaultView: globalThis,
  createElement: (t: string) => new El(t),
});
const g = globalThis as Record<string, unknown>;
Object.assign(g, {
  window: globalThis,
  top: {}, // framed: the top window is APP_HOST's
  parent: parentWin,
  document: doc,
  addEventListener: win.addEventListener.bind(win),
  removeEventListener: win.removeEventListener.bind(win),
  location: { origin: "https://sign.test", pathname: "/", search: "", href: "https://sign.test/", reload() {} },
  history: { replaceState() {} },
  matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
  KeyboardEvent: class extends Event {},
});
// main.ts's channel lives as long as the page: let the test's process end with it open
const BC = globalThis.BroadcastChannel;
g.BroadcastChannel = class extends BC {
  constructor(name: string) {
    super(name);
    (this as unknown as { unref?: () => void }).unref?.();
  }
};

async function until<T>(what: string, f: () => T | undefined): Promise<T> {
  for (let t = 0; t < 300; t++) {
    const v = f();
    if (v !== undefined) return v;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error(`never: ${what}`);
}
/** Asks `state` as APP_HOST does, and waits for its answer. */
async function askState(): Promise<Record<string, unknown>> {
  const id = crypto.randomUUID();
  const e = new Event("message");
  Object.defineProperties(e, { origin: { value: APP_ORIGIN }, source: { value: parentWin }, data: { value: { v: 1, id, type: "state" } } });
  win.dispatchEvent(e);
  const a = await until("the state answer", () => posted.find((m) => m.id === id));
  assert.equal(a.ok, true);
  return a.result!;
}

test("the framed page: signed in, its state has no pools, and nothing calls the note store or withPools", async () => {
  const pools = await import("../src/pools.ts");
  assert.equal(pools.PAGE_POOLS.length, 1, "the hook gave the table a pool, so a call would read notes");
  const other = await openWalletStore({});
  await other.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  calls.length = 0;

  await import("../src/main.ts");
  await until("the frame's ready", () => posted.find((m) => m.type === "ready"));
  const s = await askState();
  assert.equal(s.signed_in, true);
  assert.equal(Object.hasOwn(s, "pools"), false, "the frame's state carries pools");

  // another tab's change: the frame reads its state again and posts it; still no note store, no pools
  const events = posted.length;
  await other.put("ops", crypto.randomUUID(), { kind: "deposit", stage: "waiting", txs: [], created_ms: 2 });
  const ev = await until("the state event", () => posted.slice(events).find((m) => m.type === "state"));
  assert.equal(Object.hasOwn(ev.state!, "pools"), false);
  assert.equal((ev.state!.ops as unknown[]).length, 1);
  assert.equal(Object.hasOwn(await askState(), "pools"), false);
  assert.deepEqual(calls, [], `called on the framed path: ${calls.join(", ")}`);
  other.close();
});
