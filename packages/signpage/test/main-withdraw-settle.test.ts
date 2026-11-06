// src/main.ts booted top-level as the testnet build (card signpage-withdraw-handoff): a sign-in that lands runs the
// vault withdrawals' settle pass (src/withdraw/handoff.ts withdrawSettle), and the signal that pass waits on aborts on
// another tab's sign out (heard on the wallet's channel) and on this tab's own. A load hook records each withdrawSettle
// call's page signal and answers no outcomes (the pass itself is held in test/withdraw-handoff.test.ts); a second one
// hands this test main.ts's signOut, which the page runs from its guarded Sign out button (a trusted press, which Node
// cannot make). The store is the wallet's real one (fake-indexeddb). Every fetch is refused.
// A separate file: main.ts is imported once per process, and the network is read once, at import.
//   node --test test/main-withdraw-settle.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { openWalletStore } from "@blindfill/wallet/store";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "testnet";
const wrap = (src: string, name: string, body: string): string => {
  const anchor = `export async function ${name}(`;
  if (!src.includes(anchor)) throw new Error(`${name}: its line moved; update this test's hook`);
  return `${src.replace(anchor, `async function ${name}__real(`)}\n${body}\n`;
};
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/withdraw/handoff.ts"))
      return { ...r, source: wrap(String(r.source), "withdrawSettle", "export async function withdrawSettle(page, over) { void withdrawSettle__real; globalThis.__ctSettles.push(page.signal); return { outcomes: {} }; }") };
    if (url.endsWith("/signpage/src/main.ts")) {
      const s = String(r.source);
      if (!s.includes("async function signOut(): Promise<void> {")) throw new Error("signOut: its line moved; update this test's hook");
      return { ...r, source: `${s}\nglobalThis.__ctSignOut = signOut;\n` };
    }
    return r;
  },
});
const gl = globalThis as Record<string, unknown>;
const settles: (AbortSignal | undefined)[] = [];
gl.__ctSettles = settles;

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

g.fetch = async () => new Response("{}", { status: 503 });

const until = async (what: string, ok: () => boolean) => {
  for (let t = 0; t < 500; t++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never: ${what}`);
};

test("the testnet page: a landing runs the withdrawals' settle pass, and its wait stops on another tab's sign out and on this tab's", async () => {
  const w = await openWalletStore({});
  await w.insertSeed({ v: 1, entropy: new Uint8Array(16).fill(0x7f), source: "code", code_saved: true, created_ms: 1 });
  w.close();

  await import("../src/main.ts");
  await until("the boot landing's settle pass", () => settles.length >= 1);
  const first = settles[0];
  assert.ok(first instanceof AbortSignal, "the pass waits on the page's sign-out signal");
  assert.equal(first.aborted, false);

  // another tab signs out: the wallet's channel carries it
  const other = new BC("ct-wallet");
  other.postMessage({ kind: "signout" });
  await until("another tab's sign out stops the wait", () => first.aborted);
  other.close();

  // this tab's sign out, on the signal a pass would wait on now
  await until("a later landing's settle pass", () => settles.length >= 2);
  const second = settles.at(-1)!;
  assert.equal(second.aborted, false);
  await (gl.__ctSignOut as () => Promise<void>)();
  assert.ok(second.aborted, "this tab's sign out stops the wait");
});
