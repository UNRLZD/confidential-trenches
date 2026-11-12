// src/main.ts booted top-level as the mainnet build (card restore-shows-the-balance-in-seconds): the restore it makes
// walks each pool's lanes in Workers, the page's walkWorkerPort (src/walk-workers.ts: a module Worker from this origin's
// /walk-worker.js through the Trusted Types policy walk-worker). A load hook records the host main.ts hands poolRestore;
// the test fails when main passes no `walkers`, or another spawn. The DOM is the minimal one main.ts touches (as
// test/main-withdraw-settle.test.ts). Every fetch is refused.
// A separate file: main.ts is imported once per process, and the network is read once, at import.
//   node --test test/main-walk-workers.test.ts      (from packages/signpage)
/// <reference types="node" />
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { walkWorkerPort } from "../src/walk-workers.ts";

(globalThis as { __SIGN_NETWORK__?: string }).__SIGN_NETWORK__ = "mainnet";
registerHooks({
  load(url, context, next) {
    const r = next(url, context);
    if (url.endsWith("/signpage/src/pool-restore.ts")) {
      const s = String(r.source);
      const anchor = "export function poolRestore(h: PoolRestoreHost): PoolRestore {";
      if (!s.includes(anchor)) throw new Error("poolRestore: its line moved; update this test's hook");
      return { ...r, source: s.replace(anchor, `${anchor}\n  ((globalThis as { __ctRestoreHosts?: PoolRestoreHost[] }).__ctRestoreHosts ??= []).push(h);`) };
    }
    return r;
  },
});
const gl = globalThis as Record<string, unknown>;

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

test("the mainnet page's restore walks in the page's walk Workers: main hands poolRestore walkWorkerPort", async () => {
  await import("../src/main.ts");
  const hosts = (gl.__ctRestoreHosts ?? []) as { walkers?: unknown }[];
  assert.equal(hosts.length, 1, "one restore on the page");
  assert.equal(hosts[0]!.walkers, walkWorkerPort);
});
