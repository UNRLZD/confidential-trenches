// The Connected apps list on SIGN_HOST's /connect (src/connected-apps.ts), card signpage-other-apps-connect, slice 2.
//   node --test test/connected-apps.test.ts      (from packages/signpage)
// Every origin kept in the approvals store (bare origins only) is listed with a Disconnect. Disconnect removes the
// approval and only then drops the row; the bound origin's next request is refused not_allowed with no wallet read and
// no state event follows. A failed remove keeps the row and the approval and says so in one line. main.ts draws it on
// /connect only, Disconnect guarded like Allow; the terminal's path is test/main-terminal-no-connect.test.ts's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { CONNECTED_APPS_TITLE, DISCONNECT_FAILED, DISCONNECT_LABEL, connectedApps } from "../src/connected-apps.ts";
import { CONNECTIONS_DB, connections, type Connections } from "../src/connections.ts";
import { signedOutState, startApi, type IncomingMessage } from "../src/api.ts";

const OUT = "https://app.example";
const OTHER = "http://localhost:5173";

type El = { tagName: string; text: string; dataset: Record<string, string>; style: Record<string, string>; children: El[]; parent: El | null; click?: () => void; append(...c: El[]): void; replaceChildren(...c: El[]): void; remove(): void };
function el(tag: string, text = ""): El {
  const e: El = {
    tagName: tag.toUpperCase(),
    text,
    dataset: {},
    style: {},
    children: [],
    parent: null,
    append(...c) {
      for (const x of c) (x.remove(), (x.parent = e), e.children.push(x));
    },
    replaceChildren(...c) {
      for (const x of [...e.children]) x.remove();
      e.append(...c);
    },
    remove() {
      if (e.parent) e.parent.children.splice(e.parent.children.indexOf(e), 1);
      e.parent = null;
    },
  };
  return e;
}
const texts = (e: El): string[] => [e.text, ...e.children.flatMap(texts)].filter((t) => t !== "");
const buttons = (e: El): El[] => [...(e.tagName === "BUTTON" ? [e] : []), ...e.children.flatMap(buttons)];

function view(store: Pick<Connections, "list" | "remove">) {
  const root = el("main");
  const removed: string[] = [];
  const v = connectedApps(root as unknown as HTMLElement, {
    doc: { createElement: (t: string) => el(t) } as unknown as Document,
    store,
    text: (tag, t) => el(tag, t) as unknown as HTMLElement,
    origin: (t) => el("div", t) as unknown as HTMLElement,
    button: (action, label, onClick) => {
      const b = el("button", label);
      b.dataset.action = action;
      b.click = onClick;
      return b as unknown as HTMLElement;
    },
    removed: (o) => void removed.push(o),
  });
  const disconnect = (o: string) => buttons(root).find((b) => b.parent?.dataset.origin === o)!.click!();
  return { root, removed, refresh: () => v.refresh(), disconnect };
}
async function until(cond: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}
/** Writes `key` into the store's database as nothing but the page would: a key that is not a bare origin. */
async function plant(idb: IDBFactory, key: string): Promise<void> {
  await connections(idb).list(); // the database and its object store made
  await new Promise<void>((ok, no) => {
    const r = idb.open(CONNECTIONS_DB, 1);
    r.onsuccess = () => {
      const tx = r.result.transaction("origins", "readwrite");
      tx.objectStore("origins").put({ v: 1 }, key);
      tx.oncomplete = () => (r.result.close(), ok());
      tx.onerror = () => no(tx.error);
    };
    r.onerror = () => no(r.error);
  });
}

test("the list: every kept origin as it is, bare origins only, sorted, each with Disconnect, under Connected apps", async () => {
  const idb = new IDBFactory();
  const store = connections(idb);
  await store.add(OUT);
  await store.add(OTHER);
  for (const k of [`${OUT}/path`, "null", "https://u@app.example", "app.example"]) await plant(idb, k);
  const v = view(store);
  await v.refresh();
  assert.deepEqual(texts(v.root), [CONNECTED_APPS_TITLE, OTHER, DISCONNECT_LABEL, OUT, DISCONNECT_LABEL]);
  assert.deepEqual(buttons(v.root).map((b) => b.dataset.action), ["disconnect", "disconnect"]);
});

test("no origin kept, or a list that fails: nothing drawn", async () => {
  const v = view(connections(new IDBFactory()));
  await v.refresh();
  assert.deepEqual(v.root.children, []);
  const w = view({ list: () => Promise.reject(new Error("x")), remove: () => Promise.resolve() });
  await w.refresh();
  assert.deepEqual(w.root.children, []);
});

test("Disconnect of the bound origin: its approval removed, then its row; its next request refused not_allowed with no wallet read, and no state event", async () => {
  const store = connections(new IDBFactory());
  await store.add(OUT);
  await store.add(OTHER);
  let reads = 0;
  let changed: () => void = () => {};
  const posted: { msg: unknown; to: string }[] = [];
  const parent = { postMessage: (msg: unknown, to: string) => void posted.push({ msg, to }) };
  let listener: (e: IncomingMessage) => void = () => {};
  let n = 0;
  const api = startApi({ parent, origin: OUT, admit: (o) => store.has(o), listen: (fn) => (listener = fn), state: () => (reads++, { ...signedOutState(), vault_balance: String(++n) }), watch: (fn) => (changed = fn) });
  const ask = () => {
    const id = crypto.randomUUID();
    listener({ origin: OUT, source: parent, data: { v: 1, id, type: "state" } });
    return id;
  };
  const first = ask();
  await api.idle();
  assert.equal(reads, 1);
  assert.equal((posted.find((p) => (p.msg as { id?: string }).id === first)!.msg as { ok: boolean }).ok, true);

  const v = view(store);
  await v.refresh();
  v.disconnect(OUT);
  await until(() => v.removed.length === 1, "the remove");
  assert.deepEqual(v.removed, [OUT]);
  assert.equal(await store.has(OUT), false);
  assert.deepEqual(texts(v.root), [CONNECTED_APPS_TITLE, OTHER, DISCONNECT_LABEL], "the row went, the other stays");

  changed();
  await api.idle();
  const next = ask();
  await api.idle();
  assert.deepEqual(posted.find((p) => (p.msg as { id?: string }).id === next), { msg: { v: 1, id: next, ok: false, error: { code: "not_allowed" } }, to: OUT });
  assert.equal(reads, 1, "no wallet read after Disconnect: no state answer and no state event");
  assert.equal(posted.filter((p) => (p.msg as { type?: string }).type === "state").length, 0);

  // the last row's Disconnect takes the title with it
  v.disconnect(OTHER);
  await until(() => v.removed.length === 2, "the second remove");
  assert.deepEqual(v.root.children, []);
});

test("a failed remove keeps the row and the approval, and says so in one line, once", async () => {
  const store = connections(new IDBFactory());
  await store.add(OUT);
  let tries = 0;
  const failing = { list: () => store.list(), remove: () => (tries++, Promise.reject(new Error("write failed"))) };
  const v = view(failing);
  await v.refresh();
  v.disconnect(OUT);
  await until(() => texts(v.root).includes(DISCONNECT_FAILED), "the failure line");
  v.disconnect(OUT);
  await until(() => tries === 2, "a second try");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(texts(v.root), [CONNECTED_APPS_TITLE, OUT, DISCONNECT_LABEL, DISCONNECT_FAILED]);
  assert.deepEqual(v.removed, []);
  assert.equal(await store.has(OUT), true, "the approval is still kept");
});

test("a Disconnect tapped twice while its write runs removes once", async () => {
  const store = connections(new IDBFactory());
  await store.add(OUT);
  let removes = 0;
  const v = view({ list: () => store.list(), remove: (o) => (removes++, store.remove(o)) });
  await v.refresh();
  const b = buttons(v.root)[0]!;
  b.click!();
  b.click!();
  await until(() => v.removed.length === 1, "the remove");
  assert.equal(removes, 1);
});

test("main.ts: the list on /connect only, its Disconnect guarded like Allow, and a Disconnect of the bound origin clears the page's session", () => {
  const src = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.ok(/const connectedView =\s*connected &&\s*connectedApps\(connectedList, \{/.test(src), "drawn only where the store is made (/connect)");
  assert.ok(/const GUARDED = new Set\(\[[^\]]*"disconnect"[^\]]*\]\)/.test(src), "Disconnect is a guarded control");
  assert.ok(/removed: \(o\) => \{\s*if \(o !== allowedOrigin\) return;\s*allowedOrigin = null;/.test(src), "the bound origin's Confirms end with it");
});
