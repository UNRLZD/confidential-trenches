// node --test contracts/pool-evm/test/fork-rpc.test.mjs: the pools fork's block pins and the recording's upstream cap
// (fork-rpc.mjs). Each case runs fork-rpc.mjs in a child process, since it reads its environment when it loads; nothing
// here reaches a network: the upstream fetch is a stub that counts the calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const MODULE = new URL("./fork-rpc.mjs", import.meta.url).href;
const child = (code, env = {}) => {
  const base = { ...process.env };
  delete base.POOLS_FORK_BLOCK_BASE;
  delete base.POOLS_FORK_BLOCK_ROBINHOOD;
  try {
    return { ok: true, out: execFileSync(process.execPath, ["--input-type=module", "-e", code], { env: { ...base, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  }
};
const pins = (env) => child(`const { POOLS_FORK_BLOCKS } = await import(${JSON.stringify(MODULE)}); console.log(JSON.stringify(POOLS_FORK_BLOCKS));`, env);

test("the fork blocks: the pinned ones by default, the environment's block when it names one (a run recorded at a fresh head)", () => {
  assert.deepEqual(JSON.parse(pins().out), { base: 56_630_000, robinhood: 112_859_537 });
  assert.deepEqual(JSON.parse(pins({ POOLS_FORK_BLOCK_ROBINHOOD: "112939524" }).out), { base: 56_630_000, robinhood: 112_939_524 });
  assert.deepEqual(JSON.parse(pins({ POOLS_FORK_BLOCK_BASE: "56693522" }).out), { base: 56_693_522, robinhood: 112_859_537 });
});

test("planted: a fork block that is no number, not whole, or before the pool's deploy is refused, never a fork at another block", () => {
  for (const [k, v] of [["POOLS_FORK_BLOCK_BASE", "abc"], ["POOLS_FORK_BLOCK_BASE", ""], ["POOLS_FORK_BLOCK_ROBINHOOD", "112939524.5"], ["POOLS_FORK_BLOCK_ROBINHOOD", "0x6b"], ["POOLS_FORK_BLOCK_BASE", "54325670"], ["POOLS_FORK_BLOCK_ROBINHOOD", "-1"]]) {
    const r = pins({ [k]: v });
    assert.equal(r.ok, false, `${k}=${v}: ${r.out}`);
    assert.match(r.out, new RegExp(`fork-rpc: ${k} .* is no block after the pool's deploy`));
  }
});

test("planted: a recording stops at the upstream cap: the request past it is refused (502) and never reaches upstream", () => {
  const port = 41_000 + (process.pid % 2_000);
  const code = `
    const real = globalThis.fetch;
    let upstream = 0;
    globalThis.fetch = (url, init) => url.startsWith("http://127.0.0.1:") ? real(url, init) : (upstream++, Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 })));
    const { serve, UPSTREAM_CAP } = await import(${JSON.stringify(MODULE)});
    const server = await serve({}, true);
    const statuses = [];
    for (let i = 0; i <= UPSTREAM_CAP; i++) {
      const r = await real("http://127.0.0.1:${port}/base", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: i, method: "eth_getBalance", params: ["0x" + i.toString(16).padStart(40, "0"), "0x1"] }) });
      statuses.push(r.status === 200 ? 200 : r.status + " " + (await r.text()));
    }
    server.close();
    console.log(JSON.stringify({ cap: UPSTREAM_CAP, upstream, ok: statuses.filter((s) => s === 200).length, last: statuses.at(-1) }));`;
  const r = child(code, { FORK_RPC_PORT: String(port) });
  assert.ok(r.ok, r.out);
  const got = JSON.parse(r.out.trim().split("\n").at(-1));
  assert.equal(got.cap, 400);
  assert.equal(got.upstream, 400, "upstream asked 400 times, the 401st never");
  assert.equal(got.ok, 400);
  assert.match(got.last, /^502 Error: fork-rpc: 400 upstream requests, stopped \(eth_getBalance/);
});
