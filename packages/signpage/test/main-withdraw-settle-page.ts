// src/main.ts's page for the settle pass's tests (test/main-withdraw-settle.test.ts, test/main-withdraw-settle-own.test.ts),
// booted top-level as the testnet build: a load hook records each withdrawSettle call's page signal and answers no
// outcomes (the pass itself is held in test/withdraw-handoff.test.ts); a second one hands the test main.ts's signOut,
// which the page runs from its guarded Sign out button (a trusted press, which Node cannot make). The store is the
// wallet's real one (fake-indexeddb). Every fetch is refused. Imported before main.ts, once per process: a landed sign
// out reloads the page (card sign-out-stops-the-pages-reads), so each sign out's case has a file, and a document, of
// its own.
/// <reference types="node" />
import "fake-indexeddb/auto";
import { registerHooks } from "node:module";

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
      return { ...r, source: wrap(String(r.source), "withdrawSettle", "export async function withdrawSettle(page, over) { void withdrawSettle__real; globalThis.__ctSettles.push(page.signal); return { outcomes: globalThis.__ctOutcomes ?? {} }; }") };
    if (url.endsWith("/signpage/src/main.ts")) {
      const s = String(r.source);
      if (!s.includes("async function signOut(): Promise<void> {")) throw new Error("signOut: its line moved; update this test's hook");
      if (!s.includes("function withdrawDeps()")) throw new Error("withdrawDeps: its line moved; update this test's hook");
      return { ...r, source: `${s}\nglobalThis.__ctSignOut = signOut;\nglobalThis.__ctWithdrawDeps = withdrawDeps;\n` };
    }
    return r;
  },
});
export const gl = globalThis as Record<string, unknown>;
export const settles: (AbortSignal | undefined)[] = [];
gl.__ctSettles = settles;
// the settle pass answers one drift (a RESERVED note whose spend's change is not the device's) and one landing
gl.__ctOutcomes = { n1: "unmatched", n2: "arrived" };

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
// each reload the page asks for (a landed sign out, a landing on a closed gate): the stub keeps this document
export const reloads = { n: 0 };
Object.assign(g, {
  window: globalThis,
  top: globalThis,
  document: doc,
  addEventListener: win.addEventListener.bind(win),
  removeEventListener: win.removeEventListener.bind(win),
  location: { origin: "https://sign.test", pathname: "/", search: "", href: "https://sign.test/", reload: () => void reloads.n++ },
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
  // the store's own "signout" post (wallet store signOut, before it deletes the database): the test reads the wait's
  // signal at that moment, so this tab's sign out is seen to stop the wait itself, before the store goes
  override postMessage(m: unknown): void {
    if ((m as { kind?: string } | null)?.kind === "signout") (gl.__ctAtSignoutPost as (() => void) | undefined)?.();
    super.postMessage(m);
  }
};

g.fetch = async () => new Response("{}", { status: 503 });

export const until = async (what: string, ok: () => boolean) => {
  for (let t = 0; t < 500; t++) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never: ${what}`);
};
