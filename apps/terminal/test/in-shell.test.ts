// node --test apps/terminal/test/in-shell.test.ts: a top-level visit to APP_HOST moves to SIGN_HOST's shell with the
// same path and query, replacing the history entry; a framed terminal stays and draws.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTopLevel, moveToShell, shellUrl } from "../src/shell/in-shell.ts";

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
