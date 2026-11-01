// node --test scripts/live-checks/near-rpc-operators.test.mjs: the live check replays a recorded run
// (near-rpc-operators.answers.json: every `status` answer of every host in the operator map, 3 rounds, 2026-11-01
// 08:45Z; near.org's testnet archive answered 429 with a Retry-After of minutes each round). The good answer replays it:
// PASS. The bad answers are made from it: dRPC answering with one of FastNEAR's node keys, a host answering the other
// network, and dRPC's testnet host never answering; each FAILs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check } from "./near-rpc-operators.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { answers: ANSWERS } = JSON.parse(readFileSync(path.join(HERE, "near-rpc-operators.answers.json"), "utf8"));
const sleep = async () => {};

// each host's answers in the recorded order, changed by `patch(answer)`; a request the run never made is an error
function replay(answers, patch = () => {}) {
  const queues = new Map();
  for (const a of answers) queues.set(a.url, [...(queues.get(a.url) ?? []), a]);
  return async (url) => {
    const q = queues.get(url);
    if (!q?.length) throw new Error(`no recorded answer on ${url}`);
    const a = structuredClone(q.shift());
    patch(a);
    return { ok: a.status === 200, status: a.status, headers: new Headers(a.retryAfter ? { "retry-after": a.retryAfter } : {}), json: async () => a.json };
  };
}
const FASTNEAR_KEY = ANSWERS.find((a) => a.url === "https://archival-rpc.mainnet.fastnear.com" && a.status === 200).json.result.node_public_key;

test("the recording holds every map host's status answers, 3 rounds", () => {
  const urls = new Set(ANSWERS.map((a) => a.url));
  assert.equal(urls.size, 12);
  for (const u of urls) assert.equal(ANSWERS.filter((a) => a.url === u).length, 3, u);
});

test("recorded good answer: every host on its network, FastNEAR's and dRPC's node keys apart: PASS", async () => {
  const r = await check({ fetchFn: replay(ANSWERS), sleep });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  fastnear and drpc share no node key"), r.lines.join("\n"));
  assert.ok(r.lines.some((l) => /^-- {2}not read: archival-rpc\.testnet\.near\.org \(fastnear\): rate limited/.test(l)));
});

test("bad answer made from the good one: dRPC mainnet answers with a FastNEAR node key: FAIL", async () => {
  const r = await check({ fetchFn: replay(ANSWERS, (a) => a.url === "https://near.drpc.org" && (a.json.result.node_public_key = FASTNEAR_KEY)), sleep });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith(`BAD fastnear and drpc share ${FASTNEAR_KEY.slice(8, 16)}…`)), r.lines.join("\n"));
});

test("bad answer made from the good one: a mainnet host answers as testnet: FAIL", async () => {
  const r = await check({ fetchFn: replay(ANSWERS, (a) => a.url === "https://rpc.mainnet.near.org" && a.json && (a.json.result.chain_id = "testnet")), sleep });
  assert.equal(r.ok, false);
  assert.ok(r.lines.some((l) => l.startsWith("BAD rpc.mainnet.near.org (fastnear) round 1: chain testnet")), r.lines.join("\n"));
});

test("bad answer made from the good one: dRPC's testnet host rate-limited every round: FAIL, no operator count on a missing network", async () => {
  const limited = (a) => {
    if (a.url !== "https://near-testnet.drpc.org") return;
    Object.assign(a, { status: 429, retryAfter: "600", json: null });
  };
  const r = await check({ fetchFn: replay(ANSWERS, limited), sleep });
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes("BAD drpc answered on no testnet host"), r.lines.join("\n"));
});
