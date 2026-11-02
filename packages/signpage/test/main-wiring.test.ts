// src/main.ts booted top-level on a minimal DOM with the real namer, the wallet's real store and note store
// (fake-indexeddb) and the shell's own message path (card signpage-deposit-quote-wire): each wire from main.ts to the
// namer is checked through deposit.quote as the APP_HOST frame asks it.
// - a landing names U (landed() calls the namer, top: !framed), and a quote at boot waits for that naming (named());
// - a notes change (another tab: money reached the index) names again, so the next quote names the next index;
// - another tab's sign out and sign-in: a quote asked as the resync starts waits for the resync's naming (resyncing).
// The release names no vault on the page's network yet (vaultScope is null on mainnet), so a load hook makes checks.ts's
// vaultScope answer this test's scope; nothing else of main.ts or its imports is changed. The helper is a fetch that
// records each request and answers 503, so a quote that reached it answers "down" and carries U in its body.
//   node --test test/main-wiring.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { depositId, entropyToWords, wordsToSeed64 } from "@blindfill/wallet/derive";
import { openWalletStore, type WalletStore } from "@blindfill/wallet/store";
import { openNoteStore } from "../../wallet/src/notes/store.ts";
import { APP_ORIGIN } from "../src/api.ts";
import { SOL_USDC } from "./oneclick-mock.ts";

const SCOPE = 4242n;
const ANCHOR = "export function vaultScope(network: NearNetwork): bigint | null {";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (!url.endsWith("/src/withdraw/checks.ts")) return r;
    const src = String(r.source);
    if (!src.includes(ANCHOR)) throw new Error("checks.ts: vaultScope's line moved; update this test's hook");
    return { ...r, source: src.replace(ANCHOR, `${ANCHOR}\n  if (network === "mainnet") return ${SCOPE}n;`) };
  },
});

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
