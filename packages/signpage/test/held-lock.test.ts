// src/main.ts booted top-level as the testnet build (card held-deposit-way-out, delta review of the fold D2): the held
// page's move takes U's own lock, FOLLOW_LOCK/<network>/<U>, only if it is free (heldULock). While another tab's deposit
// follow of U holds it, the move reads nothing and signs nothing; once free it reads. The boot is held-main.test.ts's:
// a load hook wraps held.ts drawHeldMoveOut and exposes main.ts's heldDeps; the store is the wallet's real one
// (fake-indexeddb); every fetch is refused. A separate file: main.ts is imported once per process.
//   node --test test/held-lock.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const gl = globalThis as Record<string, unknown>;
const moveOuts: (string | null)[] = [];
gl.__ctMoveOut = moveOuts;
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/withdraw/held.ts")) {
      const s = String(r.source);
      const anchor = "export function drawHeldMoveOut(";
      if (!s.includes(anchor)) throw new Error("drawHeldMoveOut: its line moved; update this test's hook");
      return { ...r, source: `${s.replace(anchor, "function drawHeldMoveOut__real(")}
export function drawHeldMoveOut(doc, deps, button, run) {
  const d = { ...deps, moveOut: async (to) => { globalThis.__ctMoveOut.push(to); const r = await deps.recorded(); return { kind: "sent", to: r.to, amount: BigInt(r.amount), hash: r.hash }; } };
  const page = drawHeldMoveOut__real(doc, d, button, run);
  globalThis.__ctHeldPage = page;
  return page;
}
` };
    }
    if (url.endsWith("/signpage/src/main.ts")) {
      const s = String(r.source);
      if (!s.includes("function decide(")) throw new Error("decide: its line moved; update this test's hook");
      return { ...r, source: `${s}\nglobalThis.__ctDecide = decide;\nglobalThis.__ctBusy = () => busy;\nglobalThis.__ctRoot = root;\nglobalThis.__ctHeldDeps = heldDeps;\n` };
    }
    return r;
  },
});

class El extends EventTarget {
  id = ""; hidden = false; textContent = ""; readOnly = false; value = ""; disabled = false; type = ""; autocomplete = ""; spellcheck = true;
  dataset: Record<string, string> = {}; style: Record<string, string> = {}; children: El[] = []; attrs: Record<string, string> = {};
  readonly tagName: string;
  constructor(tagName: string) { super(); this.tagName = tagName; }
  append(...c: El[]) { this.children.push(...c); }
  replaceChildren(...c: El[]) { this.children = c; }
  insertBefore(n: El, ref: El) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); }
  remove() {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() {}
  find(p: (e: El) => boolean): El | undefined {
    for (const c of this.children) { if (typeof c !== "object") continue; if (p(c)) return c; const d = c.find?.(p); if (d) return d; }
    return undefined;
  }
}
class Frame extends El { src = ""; contentWindow = { postMessage: () => {} }; }
const win = new EventTarget();
const doc = Object.assign(new EventTarget(), { body: new El("body"), visibilityState: "visible", defaultView: globalThis, createElement: (t: string) => (t === "iframe" ? new Frame(t) : new El(t)) });
Object.assign(gl, {
  window: globalThis, top: globalThis, document: doc,
  addEventListener: win.addEventListener.bind(win), removeEventListener: win.removeEventListener.bind(win),
  location: { origin: "https://sign.test", pathname: "/", search: "", href: "https://sign.test/", reload() {} },
  history: { replaceState() {} }, matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0), KeyboardEvent: class extends Event {},
});
const BC = globalThis.BroadcastChannel;
gl.BroadcastChannel = class extends BC { constructor(name: string) { super(name); (this as unknown as { unref?: () => void }).unref?.(); } };
const fetched: string[] = [];
gl.fetch = async (url: string, init?: RequestInit) => (fetched.push(`${url} ${String(init?.body ?? "").slice(0, 80)}`), new Response("{}", { status: 503 }));
const until = async (what: string, ok: () => boolean) => {
  for (let t = 0; t < 500; t++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never: ${what}`);
};
const U = "0fddd0bfdaa562c5cc85461d6d8f33b344d054d48490c5dac1ffe17ad178dd22";

test("another tab's deposit follow holds FOLLOW_LOCK/testnet/<U>: the page's move reads nothing and signs nothing; once free it reads", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  await w.put("ops", "op1", { kind: "deposit", stage: "held", txs: [], created_ms: 1, held_id: U, follow: { network: "testnet", s: "1", i: 0, u: U, address: "a", deadline_ms: 1, origin: "nep141:x", min_out: "1", why: "note" } });
  w.close();
  await import("../src/main.ts");
  const root = gl.__ctRoot as { dataset: Record<string, string> };
  await until("signed in", () => root.dataset.signin === "signed-in" && !(gl.__ctBusy as () => boolean)());
  const heldDeps = gl.__ctHeldDeps as (id: string) => { moveOut: (to: string | null) => Promise<{ kind: string }> };
  let release!: () => void;
  const holding = new Promise<void>((ok) => (release = ok));
  let taken!: () => void;
  const got = new Promise<void>((ok) => (taken = ok));
  const lock = navigator.locks.request(`ct-wallet/deposit-follow/testnet/${U}`, { mode: "exclusive" }, async () => (taken(), await holding));
  await got;
  await new Promise((r) => setTimeout(r, 50));
  fetched.length = 0;
  const o1 = await Promise.race([heldDeps("op1").moveOut("alice.testnet"), new Promise<{ kind: string }>((ok) => setTimeout(() => ok({ kind: "waited 3 s" }), 3000))]);
  const reads1 = fetched.filter((f) => f.includes("rpc")).length;
  release();
  await lock;
  fetched.length = 0;
  const o2 = await heldDeps("op1").moveOut("alice.testnet");
  const reads2 = fetched.filter((f) => f.includes("rpc")).length;
  assert.equal(o1.kind, "unread");
  assert.equal(reads1, 0, "nothing read while U's follow lock is held");
  assert.ok(reads2 > 0, "once free, the move reads");
});
