// node --test apps/terminal/test/in-shell.test.ts: a top-level visit to APP_HOST moves to SIGN_HOST's shell with the
// same path and query, replacing the history entry; a framed terminal stays and draws. The shell keeps the app's path
// and query in the top window's address (nav), and the update screen's Reload reloads the top window (reload).
import assert from "node:assert/strict";
import { test } from "node:test";
import { appPath, isTopLevel, moveToShell, reloadAll, shellUrl, tellShell } from "../src/shell/in-shell.ts";

const SIGN = "https://sign.confidential.unrealized.trade";

function fakeWindow(pathname: string, search: string, framed: boolean) {
  const moves: { how: string; to: string }[] = [];
  const w = {
    location: { pathname, search, replace: (to: string) => void moves.push({ how: "replace", to }), assign: (to: string) => void moves.push({ how: "assign", to }) },
    self: {} as object,
    top: {} as object,
  };
  if (!framed) w.top = w.self;
  return { w: w as unknown as Window, moves };
}

test("top-level: moves to SIGN_HOST with the same path and query, by replace", () => {
  for (const [p, q] of [["/", ""], ["/discover", ""], ["/token/So11111111111111111111111111111111111111112", "?tab=trades&x=1"], ["/portfolio", "?a=%2F%3F"]] as const) {
    const { w, moves } = fakeWindow(p, q, false);
    assert.equal(moveToShell(w, SIGN), true);
    assert.deepEqual(moves, [{ how: "replace", to: `${SIGN}${p}${q}` }]);
  }
});

test("framed (inside the shell): stays, no move", () => {
  const { w, moves } = fakeWindow("/discover", "?a=1", true);
  assert.equal(isTopLevel(w), false);
  assert.equal(moveToShell(w, SIGN), false);
  assert.deepEqual(moves, []);
});

test("the shell URL is always on SIGN_HOST's origin: a path cannot name another host", () => {
  for (const p of ["//evil.ct.test/x", "/@evil.ct.test", "/%2F%2Fevil.ct.test"]) {
    assert.equal(new URL(shellUrl(SIGN, { pathname: p, search: "" })).origin, SIGN, p);
  }
});

/** A client that answers each kind with `answers[kind]` (default ok), and keeps what was asked. */
function fakeClient(answers: Record<string, unknown> = {}) {
  const asked: { kind: string; params: unknown }[] = [];
  const client = {
    request: (kind: string, params: unknown) => {
      asked.push({ kind, params });
      return { id: String(asked.length), outcome: Promise.resolve(answers[kind] ?? { ok: true, result: {} }) };
    },
  };
  return { client: client as never, asked };
}

test("nav: the app tells the shell its path and query, so the address bar, a reload and a shared link follow it", async () => {
  for (const [p, q] of [["/", ""], ["/discover", "?ref=x"], ["/token/solana/So11111111111111111111111111111111111111112", "?tab=trades"]] as const) {
    const { client, asked } = fakeClient();
    assert.equal(appPath({ pathname: p, search: q }), `${p}${q}`);
    await tellShell(client, { pathname: p, search: q });
    assert.deepEqual(asked, [{ kind: "nav", params: { path: `${p}${q}` } }]);
  }
});

test("Reload in the update state: the shell reloads the top window; when it does not, the frame alone reloads", async () => {
  const ok = fakeClient();
  let reloads = 0;
  await reloadAll(ok.client, { reload: () => void reloads++ });
  assert.deepEqual(ok.asked, [{ kind: "reload", params: {} }]);
  assert.equal(reloads, 0, "the shell's reload, not the frame's");
  for (const outcome of [{ ok: false, error: { code: "signpage_down" } }, { ok: false, error: { code: "client_timeout" } }, { ok: false, error: { code: "not_allowed" } }]) {
    const no = fakeClient({ reload: outcome });
    let n = 0;
    await reloadAll(no.client, { reload: () => void n++ });
    assert.equal(n, 1, JSON.stringify(outcome));
  }
});
