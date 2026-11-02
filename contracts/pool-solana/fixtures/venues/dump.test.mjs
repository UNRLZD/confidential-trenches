// SPDX-License-Identifier: Apache-2.0
// dump.mjs --programs-only against local fake RPCs (no network): it passes when the code hashes as the JSON says, fails
// as a code change (exit 1, the refresh command) when it does not, retries an RPC error or rate limit 3 times, and
// fails as an RPC failure (exit 2, "not a code change") when an RPC fails every try.
//   node --test contracts/pool-solana/fixtures/venues/dump.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ELF = { A: Buffer.from("the code of program A"), B: Buffer.from("the code of program B") };
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** A fake RPC: `answer(n)` for its n-th request (from 1) returns "ok", an HTTP status, "rpc-error" or "wrong-code". */
async function fakeRpc(answer) {
  let n = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      const how = answer(n);
      if (typeof how === "number") return res.writeHead(how).end();
      const { params } = JSON.parse(body);
      const key = params[0];
      res.writeHead(200, { "content-type": "application/json" });
      if (how === "rpc-error") return res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "node is behind" } }));
      let value;
      if (key.startsWith("PD_")) {
        const name = key.slice(3);
        const elf = how === "wrong-code" ? Buffer.from("upgraded code") : ELF[name];
        const header = Buffer.alloc(45);
        header.writeUInt32LE(3, 0);
        value = { executable: false, data: [Buffer.concat([header, elf]).toString("base64"), "base64"] };
      } else {
        value = { executable: true, data: { parsed: { type: "program", info: { programData: `PD_${key}` } } } };
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests: () => n, close: () => server.close() };
}

/** dump.mjs and a two-venue fixture (programs A and B) in a fresh folder, run against `rpcs`. */
function run(rpcs) {
  const dir = mkdtempSync(join(tmpdir(), "venues-"));
  copyFileSync(join(HERE, "dump.mjs"), join(dir, "dump.mjs"));
  writeFileSync(join(dir, "pump.json"), JSON.stringify({ programs: [{ address: "A", sha256: sha(ELF.A), file: "programs/A.so" }] }));
  writeFileSync(join(dir, "pumpswap.json"), JSON.stringify({ programs: [{ address: "B", sha256: sha(ELF.B), file: "programs/B.so" }] }));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(dir, "dump.mjs"), "--programs-only"], {
      env: { ...process.env, VENUE_RPCS: rpcs.join(","), VENUE_RPC_BACKOFF_MS: "1" },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out }));
  });
}

test("the code as dumped passes", async () => {
  const [a, b] = [await fakeRpc(() => "ok"), await fakeRpc(() => "ok")];
  const r = await run([a.url, b.url]);
  a.close(), b.close();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /PASS: every program's sha256 equals the JSON's/);
});

test("changed code fails as a code change and names the refresh command", async () => {
  const [a, b] = [await fakeRpc(() => "wrong-code"), await fakeRpc(() => "wrong-code")];
  const r = await run([a.url, b.url]);
  a.close(), b.close();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL \(code change\): 2 program\(s\) changed on mainnet since the dump/);
  assert.match(r.out, /pnpm install --frozen-lockfile && node contracts\/pool-solana\/fixtures\/venues\/dump\.mjs/);
  assert.doesNotMatch(r.out, /RPC, not a code change/);
});

test("a rate limit, a 5xx and an RPC error are retried, then the run passes", async () => {
  // the first three requests to provider A fail three ways; its 4th, the third retry, answers
  const a = await fakeRpc((n) => [429, 503, "rpc-error"][n - 1] ?? "ok");
  const b = await fakeRpc(() => "ok");
  const r = await run([a.url, b.url]);
  a.close(), b.close();
  assert.equal(r.code, 0, r.out);
  assert.equal(a.requests(), 3 + 4, "3 failed tries, then the 4 reads of two programs");
});

test("an RPC that fails every try fails as an RPC failure, not a code change", async () => {
  const a = await fakeRpc(() => 429);
  const b = await fakeRpc(() => "ok");
  const r = await run([a.url, b.url]);
  a.close(), b.close();
  assert.equal(r.code, 2, r.out);
  assert.equal(a.requests(), 4, "one try and 3 retries");
  assert.match(r.out, /FAIL \(RPC, not a code change\): .* HTTP 429, after 4 tries\. Mainnet's code was not read/);
  assert.doesNotMatch(r.out, /FAIL \(code change\)|Refresh the fixtures/);
});

test("an RPC that does not answer at all fails as an RPC failure", async () => {
  const dead = await fakeRpc(() => "ok");
  const url = dead.url;
  dead.close();
  const b = await fakeRpc(() => "ok");
  const r = await run([url, b.url]);
  b.close();
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /FAIL \(RPC, not a code change\): .*ECONNREFUSED, after 4 tries/);
});
