// node --test apps/terminal/test/return-hop.test.ts: the return record of the same-tab hop to SIGN_HOST (APU-01,
// app.md:1331; A1.3, app.md:1441). Written once before the hop, read once on load and deleted on read, ignored when
// older than 5 minutes; a missing, expired, garbled, other-kind or hand-edited return gives the default route, and no
// input yields a navigation target other than a route of the app's own table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_KINDS } from "@blindfill/kit";
import { ROUTES } from "../src/routes/routes.ts";
import {
  DEFAULT_PATH,
  HOP_RECORD,
  HOP_TTL_MS,
  land,
  makeRecord,
  parseRecord,
  RETURN_KEYS,
  returnPath,
  takeRecord,
  writeRecord,
} from "../src/shell/return-hop.ts";

const NOW = 1_800_000_000_000;
const VIEW = { route: "portfolio", sheet: "export", control: "export-solana", fields: { note: "abc" }, scroll: 1200 } as const;
const PATHS = new Set(ROUTES.map((r) => r.path));
const url = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

class Store {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

test("each of the five open kinds has one return key and one return path, and nothing else does", () => {
  assert.deepEqual(Object.keys(RETURN_KEYS).sort(), [...OPEN_KINDS].sort());
  const keys = Object.values(RETURN_KEYS);
  assert.equal(new Set(keys).size, 5);
  for (const k of keys) {
    assert.match(k, /^[a-z][a-z0-9_-]{0,63}$/, "the kit's return_key shape");
    assert.equal(returnPath(k), `/return/${k}`);
  }
});

test("a record written before the hop restores its screen at its kind's return path, once", () => {
  for (const kind of OPEN_KINDS) {
    const s = new Store();
    writeRecord(s, makeRecord(kind, VIEW, NOW));
    const raw = s.getItem(HOP_RECORD)!;
    assert.ok(!/"\w*(key|seed|words|secret)\w*"\s*:/i.test(raw.replace(/"return_key"/, "")), raw);
    const rec = takeRecord(s, NOW + 1_000);
    assert.equal(s.getItem(HOP_RECORD), null, "deleted on read");
    assert.equal(takeRecord(s, NOW + 1_000), null, "read once");
    assert.deepEqual(land(url(returnPath(RETURN_KEYS[kind])), rec), {
      to: "/portfolio",
      view: { route: "portfolio", sheet: "export", control: "export-solana", fields: { note: "abc" }, scroll: 1200 },
    });
  }
});

test("Back from SIGN_HOST: a load at the route the record left restores it in place; any other route ignores it", () => {
  const rec = parseRecord(JSON.stringify(makeRecord("signin.open", VIEW, NOW)), NOW + 10)!;
  assert.deepEqual(land(url("/portfolio"), rec), { to: null, view: { ...VIEW, fields: { ...VIEW.fields } } });
  assert.deepEqual(land(url("/orders"), rec), { to: null, view: null });
  assert.deepEqual(land(url("/orders"), null), { to: null, view: null });
});

test("no record, a stale one, one from the future, one for another kind or a hand-edited return: the default route", () => {
  const fresh = (kind: (typeof OPEN_KINDS)[number], at = NOW) => parseRecord(JSON.stringify(makeRecord(kind, VIEW, at)), NOW);
  assert.equal(DEFAULT_PATH, "/discover");
  const def = { to: DEFAULT_PATH, view: null };
  assert.deepEqual(land(url("/return/signin"), null), def);
  assert.equal(fresh("signin.open", NOW - HOP_TTL_MS - 1), null, "older than 5 minutes");
  assert.notEqual(fresh("signin.open", NOW - HOP_TTL_MS), null, "5 minutes exactly still holds");
  assert.equal(fresh("signin.open", NOW + 1), null, "made after now");
  assert.deepEqual(land(url("/return/backup"), fresh("signin.open")), def, "another kind's return");
  for (const [p, s, h] of [
    ["/return/signin", "?x=1", ""],
    ["/return/signin", "", "#a"],
    ["/return/signin/", "", ""],
    ["/return/signin/x", "", ""],
    ["/return/SIGNIN", "", ""],
    ["/return/", "", ""],
    ["/return", "", ""],
    ["/return/nope", "", ""],
    ["/return//evil.ct.test", "", ""],
  ]) {
    assert.deepEqual(land(url(p, s, h), fresh("signin.open")), def, `${p}${s}${h}`);
  }
});

test("parseRecord refuses every record that is not exactly the shape", () => {
  const good = makeRecord("export.open", VIEW, NOW);
  const bad: unknown[] = [
    null,
    "",
    "{",
    "null",
    "[]",
    "1",
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, kind: "buy" }),
    JSON.stringify({ ...good, return_key: "withdraw" }),
    JSON.stringify({ ...good, route: "//evil.ct.test" }),
    JSON.stringify({ ...good, route: "https://evil.ct.test/" }),
    JSON.stringify({ ...good, route: "javascript:alert(1)" }),
    JSON.stringify({ ...good, route: "../../x" }),
    JSON.stringify({ ...good, route: "/portfolio" }),
    JSON.stringify({ ...good, sheet: "<b>" }),
    JSON.stringify({ ...good, control: "" }),
    JSON.stringify({ ...good, control: 7 }),
    JSON.stringify({ ...good, fields: [] }),
    JSON.stringify({ ...good, fields: { note: 1 } }),
    JSON.stringify({ ...good, fields: { "__proto__x": "a", Note: "a" } }),
    JSON.stringify({ ...good, fields: { note: "x".repeat(257) } }),
    JSON.stringify({ ...good, fields: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`f${i}`, "a"])) }),
    JSON.stringify({ ...good, scroll: -1 }),
    JSON.stringify({ ...good, scroll: "1" }),
    JSON.stringify({ ...good, at: "now" }),
    JSON.stringify({ ...good, extra: 1 }),
    '{"__proto__":{"route":"portfolio"}}',
    JSON.stringify({ ...good, sheet: "a".repeat(9000) }),
  ];
  for (const b of bad) assert.equal(parseRecord(b, NOW), null, String(b).slice(0, 80));
  assert.notEqual(parseRecord(JSON.stringify(good), NOW), null);
  assert.notEqual(parseRecord(JSON.stringify({ ...good, sheet: null }), NOW), null);
});

test("1,000 fuzzed records at fuzzed return URLs never yield a target outside the route table, and never throw", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const nasty = ["//host", "https://host", "javascript:alert(1)", "data:text/html,x", "../..", "/..", "%2e%2e", "\r\nx", "x".repeat(5000), "", "portfolio", "discover", "__proto__", "constructor"];
  const kinds = [...OPEN_KINDS, "buy", "state", ""];
  const keys = [...Object.values(RETURN_KEYS), ...nasty];
  const routes = [...ROUTES.map((r) => r.id), ...nasty];
  let restored = 0;
  for (let i = 0; i < 1_000; i++) {
    const rec: Record<string, unknown> = {
      v: pick([1, 1, 1, 2, "1"]),
      kind: pick(kinds),
      return_key: pick(keys),
      route: pick(routes),
      sheet: pick([null, "export", ...nasty]),
      control: pick(["c1", ...nasty]),
      fields: pick([{}, { note: pick(nasty) }, { [pick(nasty)]: "a" }, nasty]),
      scroll: pick([0, 10, -5, 1e12, Number.NaN]),
      at: NOW - pick([0, 1000, HOP_TTL_MS, HOP_TTL_MS + 1, -1000]),
    };
    const coherent = rnd() < 0.5;
    if (coherent) {
      // a good record half the time with one field maybe spoiled, so the restore path is fuzzed too
      const kind = pick(OPEN_KINDS);
      const route = pick(ROUTES);
      Object.assign(rec, { v: 1, kind, return_key: RETURN_KEYS[kind], route: route.id, sheet: "export", control: "c1", fields: { note: "a" }, scroll: 10, at: NOW - 1000 });
      if (rnd() < 0.3) rec[pick(Object.keys(rec))] = pick(nasty);
    }
    const raw = rnd() < 0.1 ? JSON.stringify(rec).slice(0, Math.floor(rnd() * 80)) : JSON.stringify(rec);
    const s = new Store();
    s.setItem(HOP_RECORD, raw);
    const own = ROUTES.find((r) => r.id === rec.route);
    const where = pick([
      returnPath(pick(Object.values(RETURN_KEYS))),
      returnPath(String(rec.return_key)),
      own ? own.path : "/",
      `/return/${pick(nasty)}`,
      ...ROUTES.map((r) => r.path),
      pick(nasty),
    ]);
    const parsed = takeRecord(s, NOW);
    assert.equal(s.getItem(HOP_RECORD), null);
    const l = land(url(where, pick(["", "", "?x", "?//evil"]), pick(["", "", "#x"])), parsed);
    assert.ok(l.to === null || PATHS.has(l.to), `target ${l.to}`);
    if (where.startsWith("/return")) assert.ok(l.to !== null, "a return always lands");
    if (l.view) {
      restored++;
      assert.ok(ROUTES.some((r) => r.id === l.view!.route));
    }
  }
  assert.ok(restored > 50, `the fuzz restored only ${restored}`);
});

test("a storage that throws gives no record and no exception", () => {
  const broken = {
    getItem() {
      throw new Error("denied");
    },
    removeItem() {
      throw new Error("denied");
    },
  };
  assert.equal(takeRecord(broken, NOW), null);
});
