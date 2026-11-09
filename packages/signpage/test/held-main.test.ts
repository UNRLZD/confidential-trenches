// src/main.ts booted top-level as the testnet build (card held-deposit-way-out, review of d791adda H1): withdraw.open
// with the from_id of a held op that already holds a move draws the held page with the recorded account in the field,
// read-only, and resumes it with moveOut(null) at once. main.ts's run() drops a step while its own opening step is busy,
// so the page's resume must not go through it (the review booted this and saw the resume asked once, run 0 times).
// A load hook wraps held.ts drawHeldMoveOut: the page it draws is kept, and its moveOut answers "sent" for the recorded
// account without reading a chain (the move itself is held in packages/wallet/test/deposit-moveout.test.ts). The store
// is the wallet's real one (fake-indexeddb). Every fetch is refused. A separate file: main.ts is imported once per process.
//   node --test test/held-main.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";
import { NEAR_NETWORKS } from "../../wallet/src/deposit/account.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const gl = globalThis as Record<string, unknown>;
const moveOuts: (string | null)[] = [];
gl.__ctMoveOut = moveOuts;
const settled: string[] = [];
gl.__ctSettled = settled;
const settledArchival: string[][] = [];
gl.__ctSettledArchival = settledArchival;
const settledArchivalRpcs: { tx: (p: unknown) => Promise<unknown> }[][] = [];
gl.__ctSettledArchivalRpcs = settledArchivalRpcs;
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
      const resume = "await moveOutHeld(k, null, {";
      if (s.split(resume).length !== 2) throw new Error("settleHeld: its resume line moved; update this test's hook");
      return { ...r, source: `${s.replace(resume, "await ((k1, t1, d1) => (globalThis.__ctSettled.push(k1), globalThis.__ctSettledArchival.push(d1.archival.map((h) => h.name)), globalThis.__ctSettledArchivalRpcs.push(d1.archival), moveOutHeld(k1, t1, d1)))(k, null, {")}\nglobalThis.__ctDecide = decide;\nglobalThis.__ctBusy = () => busy;\nglobalThis.__ctRoot = root;\n` };
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
// every fetch refused (503), unless a test hands its own answers
let answers: ((url: string) => Response) | null = null;
gl.fetch = async (url: string) => (answers ? answers(url) : new Response("{}", { status: 503 }));
const until = async (what: string, ok: () => boolean) => {
  for (let t = 0; t < 500; t++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never: ${what}`);
};
const U = "0fddd0bfdaa562c5cc85461d6d8f33b344d054d48490c5dac1ffe17ad178dd22";

test("withdraw.open with the from_id of a held op holding a move: the recorded account drawn read-only, resumed with moveOut(null)", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  const out = { to: "alice.testnet", amount: "1999999", nonce: "8", height: 1000, register: false, hash: "11111111111111111111111111111111", signed: "AA==" };
  await w.put("ops", "op1", { kind: "deposit", stage: "held", txs: [], created_ms: 1, held_id: U, follow: { network: "testnet", s: "1", i: 0, u: U, address: "a", deadline_ms: 1, origin: "nep141:x", min_out: "1", why: "note", out } });
  // a moved one: the sign-in's resume reads it too, so a later deposit in its U is open again (delta review of c3e71713, item 2)
  await w.put("ops", "op0", { kind: "deposit", stage: "held", txs: [], created_ms: 2, held_id: U, follow: { network: "testnet", s: "1", i: 1, u: U, address: "b", deadline_ms: 1, origin: "nep141:x", min_out: "1", why: "moved_out", out } });
  w.close();
  await import("../src/main.ts");
  const root = gl.__ctRoot as { dataset: Record<string, string> };
  await until("signed in", () => root.dataset.signin === "signed-in" && !(gl.__ctBusy as () => boolean)());
  // the sign-in's own resume (settleHeld) runs the real wallet move on refused fetches; only the page's calls count here
  const a = (gl.__ctDecide as (k: string, w: unknown, f?: string) => { then: () => void } | null)("withdraw.open", undefined, U);
  assert.ok(a, "withdraw.open taken");
  a!.then();
  await until("the held page drawn", () => root.dataset.signin === "held");
  await until("the page's resume", () => moveOuts.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  const page = gl.__ctHeldPage as El;
  const input = page.find((e) => e.dataset.input === "to")!;
  assert.deepEqual(moveOuts, [null], "resumed once, no account handed over");
  assert.equal(input.value, "alice.testnet", "the recorded account is drawn");
  assert.equal(input.readOnly, true);
  assert.equal(page.dataset.outcome, "sent");
  // op0 sorts first, so settleHeld reads it before op1's follow polls
  await until("op1's resume", () => settled.includes("op1"));
  assert.deepEqual(settled, ["op0", "op1"], "the sign-in's resume reads every held op with a move, a moved one too");
  for (const names of settledArchival) assert.deepEqual(names, [...NEAR_NETWORKS.testnet.archival], "each resume is handed the network's whole archival list");
  // each archival host is asked again after a throttle (the wallet's archivalRpc, delta review 3 F4): a 429, then the answer
  const asked: string[] = [];
  const host = NEAR_NETWORKS.testnet.archival[0];
  answers = (url) => (url !== host ? new Response("{}", { status: 503 }) : (asked.push(url), asked.length === 1 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ result: { ok: 1 } })));
  try {
    assert.deepEqual(await settledArchivalRpcs[0]![0]!.tx({ tx_hash: "x", sender_account_id: "y", wait_until: "NONE" }), { result: { ok: 1 } });
  } finally {
    answers = null;
  }
  assert.deepEqual(asked, [host, host], "asked again once after the 429");
});
