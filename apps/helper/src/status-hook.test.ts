// node --test apps/helper/src/status-hook.test.ts: the proxy route hands a 1Click status answer it carried to the
// deposit's creation (card helper-create-u; bind/env.ts delivered, bind/create.ts onStatusAnswer), after the answer and
// off its path. The proxy is the real one on a fake 1Click that answers the recorded status (bind/fixtures/
// oneclick-status.json); the bind sender is a fake that records what it is handed.
// - the device's answer is byte-equal with the hook on and off, and the hook gets that same body once;
// - a hook that throws or never ends changes no answer;
// - only a 200 of oneclick /v0/status reaches it: another path, another vendor or a refused call does not.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { BindSender } from "./bind/env.ts";
import { createProxy } from "./proxy/proxy.ts";
import { start } from "./server.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ENV = { ONECLICK_JWT: "test-oneclick-0001", RELAY_API_KEY: "test-relay-0001" };
const RECORDED = JSON.parse(readFileSync(join(import.meta.dirname, "bind/fixtures/oneclick-status.json"), "utf8")) as { answers: { success_usdc: unknown } };
/** The upstream's bytes, as 1Click sends them (no spaces). */
const UPSTREAM = JSON.stringify(RECORDED.answers.success_usdc);
const ADDRESS = "a998c6585100ca4bccbc0e0bcceb9abd66e59666e87bd03b1d83bb9544f7ce2f";

type Got = { status: number; body: string; type: string | undefined };
function call(port: number, path: string, body = ""): Promise<Got> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, method: "POST", path, headers: { "content-type": "application/json" } }, (res) => {
      let b = "";
      res.setEncoding("utf8").on("data", (d) => (b += d)).on("end", () => ok({ status: res.statusCode ?? 0, body: b, type: res.headers["content-type"] }));
    });
    r.on("error", fail).end(body);
  });
}
const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((ok) => setImmediate(ok));
};

/** A helper whose 1Click answers `upstream` (status, body) to every call, with `bind` handed in. */
async function helper(bind: BindSender, upstream: (url: string) => { status: number; body: string } = () => ({ status: 200, body: UPSTREAM })): Promise<{ port: number; close(): Promise<void> }> {
  const fetchFn = async (url: string) => {
    const u = upstream(url);
    return new Response(u.body, { status: u.status, headers: { "content-type": "application/json" } });
  };
  const s: Server = start(COMMIT, 0, createProxy(ENV, { fetch: fetchFn }), undefined, undefined, undefined, undefined, undefined, undefined, bind);
  await new Promise<void>((ok) => s.on("listening", () => ok()));
  return {
    port: (s.address() as AddressInfo).port,
    close: () => new Promise<void>((ok) => (s.closeAllConnections(), s.close(() => ok()))),
  };
}
const sender = (delivered?: (body: string) => void): BindSender => ({
  carry: async () => ({ status: 503, body: { error: { code: "upstream" } } }),
  warm: () => undefined,
  stop: () => undefined,
  ...(delivered ? { delivered } : {}),
});
const STATUS_PATH = `/v1/proxy/oneclick/v0/status?depositAddress=${ADDRESS}`;

test("the device's status answer is byte-equal with the hook on and off, and the hook gets that body once, after it", async (t) => {
  const off = await helper(sender());
  t.after(() => off.close());
  const seen: string[] = [];
  const on = await helper(sender((b) => void seen.push(b)));
  t.after(() => on.close());
  const a = await call(off.port, STATUS_PATH);
  const b = await call(on.port, STATUS_PATH);
  assert.equal(a.status, 200);
  assert.equal(a.body, UPSTREAM, "the proxy passes 1Click's bytes");
  assert.deepEqual(b, a);
  await turns();
  assert.deepEqual(seen, [UPSTREAM]);
});

test("a hook that throws, or never ends, changes no answer; the next call is served as before", async (t) => {
  let calls = 0;
  const throws = await helper(
    sender(() => {
      calls++;
      throw new Error("hook broke");
    }),
  );
  t.after(() => throws.close());
  const hangs = await helper(sender(() => void new Promise(() => undefined)));
  t.after(() => hangs.close());
  for (const h of [throws, hangs, throws]) {
    const r = await call(h.port, STATUS_PATH);
    assert.deepEqual([r.status, r.body], [200, UPSTREAM]);
  }
  await turns();
  assert.equal(calls, 2);
});

test("only a 200 of oneclick /v0/status reaches the hook: a quote, another vendor's status or a refused status does not", async (t) => {
  const seen: string[] = [];
  let status = 200;
  const h = await helper(sender((b) => void seen.push(b)), () => ({ status, body: UPSTREAM }));
  t.after(() => h.close());
  assert.equal((await call(h.port, "/v1/proxy/oneclick/v0/quote", "{}")).status, 200);
  assert.equal((await call(h.port, "/v1/proxy/relay/intents/status/v3?requestId=0x1")).status, 200);
  assert.equal((await call(h.port, "/v1/proxy/oneclick/v0/status/?depositAddress=x")).status, 400, "not the path byte for byte: refused");
  for (const s of [404, 400]) {
    status = s;
    const r = await call(h.port, STATUS_PATH);
    assert.notEqual(r.status, 200, String(s));
  }
  await turns();
  assert.deepEqual(seen, []);
});
