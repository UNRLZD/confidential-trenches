// no-network.mjs: the preload lets this machine's sockets through and refuses every other host, in fetch, http and net.
//   node --test scripts/ci/no-network.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isLocal } from "./no-network.mjs";

const PRELOAD = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "no-network.mjs")).href;

test("loopback names and addresses are local, every other host is not", () => {
  for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", undefined]) assert.ok(isLocal(h), String(h));
  for (const h of ["api.jup.ag", "192.0.2.1", "10.0.0.1", "localhost.evil.example", "127.0.0.1.evil.example", "0.0.0.0", "::"]) assert.ok(!isLocal(h), h);
});

const script = (body) => spawnSync("node", ["--import", PRELOAD, "--input-type=module", "-e", body], { encoding: "utf8" });

test("a request to this machine works over fetch, http and a raw socket", () => {
  const r = script(`
    import http from "node:http"; import net from "node:net";
    const srv = http.createServer((q, s) => s.end("ok")).listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      const a = await (await fetch("http://127.0.0.1:" + port + "/")).text();
      const b = await (await fetch("http://localhost:" + port + "/")).text();
      const c = await new Promise((res) => http.get({ host: "localhost", port }, (m) => { m.resume(); res(m.statusCode); }));
      const d = await new Promise((res, rej) => net.connect(port, "127.0.0.1").on("connect", function () { this.destroy(); res("raw"); }).on("error", rej));
      console.log([a, b, c, d].join(","));
      srv.close();
    });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "ok,ok,200,raw");
});

test("a request to any other host is refused before it leaves, over fetch, http, https and a raw socket", () => {
  const r = script(`
    import http from "node:http"; import https from "node:https"; import net from "node:net";
    const out = [];
    const attempt = async (name, f) => { try { await f(); out.push(name + ":REACHED"); } catch (e) { out.push(name + ":" + String(e.cause?.message ?? e.message)); } };
    await attempt("fetch", () => fetch("https://api.jup.ag/"));
    await attempt("http", () => new Promise((res, rej) => http.get("http://192.0.2.1/", res).on("error", rej)));
    await attempt("https", () => new Promise((res, rej) => https.get("https://example.com/", res).on("error", rej)));
    await attempt("net", () => new Promise((res, rej) => { net.connect(443, "api.relay.link").on("error", rej).on("connect", res); }));
    console.log(out.join("\\n"));`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 4);
  assert.doesNotMatch(r.stdout, /REACHED/);
  assert.equal(r.stdout.match(/no-network: a connection to/g).length, 4);
});

// A request may pin its own lookup (the helper's logo fetch does: logo.ts httpsGet); the address that lookup answers is
// where the socket goes, so that address is what the guard checks, in both of net's lookup forms (one address, or all).
test("a name with its own lookup pinned to this machine connects, in both lookup forms and over https", () => {
  const r = script(`
    import net from "node:net"; import https from "node:https";
    const pin = (address, family) => (_h, o, cb) => o.all ? cb(null, [{ address, family }]) : cb(null, address, family);
    const hellos = [];
    const srv = net.createServer((c) => c.once("data", (d) => { hellos.push(d.includes("pinned.invalid") ? "sni" : "raw"); c.destroy(); })).listen(0, "127.0.0.1", async () => {
      const port = srv.address().port;
      const raw = (o) => new Promise((res, rej) => { const s = net.connect({ host: "pinned.invalid", port, ...o }).on("error", rej).on("connect", () => { s.end("x"); res(); }); });
      await raw({ lookup: pin("127.0.0.1", 4) });
      await raw({ lookup: pin("127.0.0.1", 4), autoSelectFamily: false });
      await new Promise((res) => https.get({ host: "pinned.invalid", port, lookup: pin("127.0.0.1", 4), agent: new https.Agent() }).on("error", res));
      setTimeout(() => { console.log(hellos.sort().join(",")); srv.close(); }, 100);
    });`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "raw,raw,sni");
});

test("a name with its own lookup that answers another machine is refused before it connects, in both lookup forms", () => {
  const r = script(`
    import net from "node:net";
    const pin = (address, family) => (_h, o, cb) => o.all ? cb(null, [{ address: "127.0.0.1", family: 4 }, { address, family }]) : cb(null, address, family);
    const out = [];
    for (const o of [{ lookup: pin("192.0.2.1", 4) }, { lookup: pin("192.0.2.1", 4), autoSelectFamily: false }, { lookup: pin("2001:db8::1", 6) }]) {
      const r = await new Promise((res) => net.connect({ host: "pinned.invalid", port: 443, ...o }).on("connect", function () { this.destroy(); res("REACHED"); }).on("error", (e) => res(e.message)));
      out.push(r);
    }
    console.log(out.join("\\n"));`);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 3, r.stdout);
  for (const l of lines) assert.match(l, /^no-network: a connection to pinned\.invalid \((192\.0\.2\.1|2001:db8::1)\) was refused/);
});

test("a unix socket path is left alone", () => {
  const r = script(`import net from "node:net"; net.connect("/nonexistent/x.sock").on("error", (e) => console.log(e.code));`);
  assert.equal(r.stdout.trim(), "ENOENT");
});
