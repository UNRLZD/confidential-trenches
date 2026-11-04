#!/usr/bin/env node
// Live check of card near-rpc-operators: the NEAR RPC operator map (scripts/ci/near-rpc-operators.mjs) still matches
// the hosts. Every host in the map answers `status` for its own network, `rounds` times; no node key is seen on two
// operators' hosts (dRPC serving FastNEAR's nodes would make a FastNEAR read plus a dRPC read one read). PASS: every
// answer is its host's network, every operator answered on each network, and the operators' node keys are apart. A host
// rate-limited past RATE_CAP_S (near.org's testnet archive asks for minutes) is named as not read; it fails the check
// only when its operator has no other host read on that network.
//   node scripts/live-checks/near-rpc-operators.mjs [--rounds <n>] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2
// --record writes every answer the run read to <file>, so the check's test can replay it.
// Runs: once, the money gate's NEAR RPC operator map (scripts/ci) against the RPC hosts; no host serves it, run when the map changes
import "../net-window.mjs";
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NEAR_RPC_OPERATORS } from "../ci/near-rpc-operators.mjs";

const KEY = "near-rpc-operators";
const RATE_CAP_S = 120; // a 429 is waited out up to this Retry-After, 3 times; past it the host has no answer
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function status(fetchFn, url, sleep) {
  for (let i = 0; ; i++) {
    const r = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 && i < 3) {
      const after = Number(r.headers?.get?.("retry-after") ?? 5);
      if (!(after <= RATE_CAP_S)) throw Object.assign(new Error(`rate limited, Retry-After ${after} s`), { rate: true });
      await sleep(Math.max(after, 1) * 1000);
      continue;
    }
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return (await r.json())?.result;
  }
}

export async function check({ fetchFn = fetch, rounds = 3, gapMs = 5000, sleep = wait } = {}) {
  const lines = [];
  let ok = true;
  const say = (good, line) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${line}`);
  };
  const keysOf = new Map(); // operator -> Map(key -> hosts)
  const answered = new Set(); // "operator network" with at least one answer
  const limited = new Set(); // hosts rate-limited past the cap
  for (let round = 0; round < rounds; round++) {
    if (round) await sleep(gapMs);
    for (const [host, { operator, network }] of Object.entries(NEAR_RPC_OPERATORS)) {
      let s;
      try {
        s = await status(fetchFn, `https://${host}`, sleep);
      } catch (e) {
        if (e?.rate) limited.add(`${host} (${operator}): ${e.message}`);
        else say(false, `${host} (${operator}) round ${round + 1}: no answer (${String(e?.message ?? e).slice(0, 80)})`);
        continue;
      }
      const key = typeof s?.node_public_key === "string" && /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.node_public_key) ? s.node_public_key : null;
      if (s?.chain_id !== network || !key) {
        say(false, `${host} (${operator}) round ${round + 1}: chain ${String(s?.chain_id).slice(0, 20)}, node key ${String(s?.node_public_key).slice(0, 60)}; the map says ${network}`);
        continue;
      }
      answered.add(`${operator} ${network}`);
      const m = keysOf.get(operator) ?? new Map();
      m.set(key, new Set([...(m.get(key) ?? []), host]));
      keysOf.set(operator, m);
    }
  }
  for (const [operator, keys] of keysOf)
    say(true, `${operator}: ${[...keys].map(([k, hosts]) => `${k.slice(8, 16)}… on ${[...hosts].sort().join(", ")}`).join("; ")}`);
  const ops = [...keysOf.keys()];
  for (let i = 0; i < ops.length; i++)
    for (let j = i + 1; j < ops.length; j++) {
      const shared = [...keysOf.get(ops[i]).keys()].filter((k) => keysOf.get(ops[j]).has(k));
      say(shared.length === 0, `${ops[i]} and ${ops[j]} share ${shared.length ? shared.map((k) => `${k.slice(8, 16)}…`).join(", ") : "no node key"}`);
    }
  for (const l of limited) lines.push(`--  not read: ${l}`);
  for (const { operator, network } of Object.values(NEAR_RPC_OPERATORS))
    if (!answered.has(`${operator} ${network}`)) {
      answered.add(`${operator} ${network}`);
      say(false, `${operator} answered on no ${network} host`);
    }
  say(ops.length >= 2, `${ops.length} operator(s) answered`);
  return { ok, lines };
}

// a fetch that keeps every answer it reads: { url, method, status, retryAfter, json }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init) => {
    const { method } = JSON.parse(init.body);
    const r = await fetchFn(url, init);
    const json = r.status === 200 ? await r.json() : null;
    answers.push({ url, method, status: r.status, retryAfter: r.headers.get("retry-after"), json });
    return { ok: r.ok, status: r.status, headers: r.headers, json: async () => json };
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const rounds = Number(opt("--rounds", "3"));
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("usage: near-rpc-operators.mjs [--rounds <1-10>] [--record <file>]");
    const rec = recorder();
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch, rounds });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify({ read: new Date().toISOString(), answers: rec.answers }, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
