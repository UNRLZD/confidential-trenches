#!/usr/bin/env node
// Live check of card relayer-withdraw-send: HELPER_HOST serves POST /v1/withdraw (markets paper H3.4, M:1363-1392; the
// route row, M:3366) and refuses what it must, sending nothing. It never sends a request that could pass: every body
// below is refused before any chain read or by check 2 (a real proof made for another vault, so its context is not
// this vault's), so no run of this check spends gas or moves money. It reads, with Origin APP_HOST:
//   - GET /v1/withdraw: 405 with Allow "POST, OPTIONS";
//   - a body that is not JSON: 400 bad_shape;
//   - a body over the kit's 8 KB: 413 too_large;
//   - a body with a field the vault does not take: 400 bad_shape;
//   - the recorded real proof (apps/helper/src/withdraw/fixtures/withdraw-request.json) on mainnet USDC and on the
//     testnet token: 400 with bad_proof (the network is carried: check 2) or bad_shape (it is not: check 1, not the
//     vault's token). The proof was made for the name mainnet's v1 vault has, so on mainnet USDC its context is
//     recomputed for another vault (helper-mainnet-vault-env.mjs decoyFor and probe), and a helper carrying mainnet
//     refuses it at check 2 as well;
// and every answer carries a full-sha X-Helper-Commit, APP_HOST echoed, a JSON body under 1 KB, and no tx_hash.
// After: helper
//   node scripts/live-checks/relayer-withdraw-send.mjs [--base <url>] [--record <file>]   PASS exit 0, FAIL exit 1, error exit 2
import "../net-window.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vaultScopeOf } from "../../packages/kit/src/index.ts";
import { decoyFor, loadRecord, probe } from "./helper-mainnet-vault-env.mjs";
import { createRequire } from "node:module";
// @noble/hashes from the helper's own dependencies (apps/ is outside Blindfill), as helper-mainnet-vault-env.mjs loads it
const { keccak_256 } = createRequire(new URL("../../apps/helper/package.json", import.meta.url))("@noble/hashes/sha3.js");

export const BASE = "https://ct-api.unrealized.trade";
export const APP = "https://ct-app.unrealized.trade";
export const TOKENS = { mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", testnet: "bf-usdc-20261101t022248.testnet" }; // gitleaks:allow (public account ids)
const SHA = /^[0-9a-f]{40}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../apps/helper/src/withdraw/fixtures/withdraw-request.json");
export const MAINNET = "a real proof for another vault, mainnet USDC";

/** The crafted asks: each one's method, body and the answers that pass. */
export function asks(fixture = JSON.parse(readFileSync(FIXTURE, "utf8")).request) {
  const real = (token) => JSON.stringify({ ...fixture, token });
  // mainnet: the proof's context for another vault than the v1 record's, its fee recipient the record's vault (review
  // L1: one no helper carries, check 8, as helper-mainnet-vault-env.mjs asks; the fixture's own could one day be the
  // host's WITHDRAW_FEE_RECIPIENT_MAINNET, and a helper taking any vault would then reach check 4's bad_proof and pass)
  const record = loadRecord();
  const decoy = decoyFor(record);
  const elsewhere = () => JSON.stringify({ ...probe(decoy, vaultScopeOf(keccak_256, decoy, TOKENS.mainnet).toString(), fixture, record.account_id), token: TOKENS.mainnet });
  return [
    { name: "GET", method: "GET", body: undefined, want: [[405, "method_not_allowed"]] },
    { name: "not JSON", method: "POST", body: "{not json", want: [[400, "bad_shape"]] },
    { name: "over 8 KB", method: "POST", body: JSON.stringify({ pad: "x".repeat(8_200) }), want: [[413, "too_large"]] },
    { name: "a field the vault does not take", method: "POST", body: JSON.stringify({ ...fixture, token: TOKENS.mainnet, processooor: "x.near" }), want: [[400, "bad_shape"]] },
    { name: MAINNET, method: "POST", body: elsewhere(), want: [[400, "bad_proof"], [400, "bad_shape"]] },
    { name: "a real proof for another vault, the testnet token", method: "POST", body: real(TOKENS.testnet), want: [[400, "bad_proof"], [400, "bad_shape"]] },
  ];
}

/** One run: every ask sent, its status, headers and body kept. */
export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const a of asks()) {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/withdraw`, {
      method: a.method,
      redirect: "manual",
      headers: { origin: APP, ...(a.body !== undefined && { "content-type": "application/json" }) },
      ...(a.body !== undefined && { body: a.body }),
    });
    const headers = Object.fromEntries(["x-helper-commit", "access-control-allow-origin", "allow", "content-type"].map((h) => [h, r.headers.get(h)]));
    reads.push({ asked: a.name, readAt: new Date().toISOString(), status: r.status, headers, body: (await r.text()).slice(0, 4096) });
  }
  return { base, reads };
}

/** The check on one recorded run. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  for (const a of asks()) {
    const r = run.reads.find((x) => x.asked === a.name);
    if (!r) {
      say(false, `${a.name}: not read`);
      continue;
    }
    let body;
    try {
      body = JSON.parse(r.body);
    } catch {
      body = undefined;
    }
    const code = body?.error?.code;
    const passed = a.want.some(([s, c]) => r.status === s && code === c);
    say(passed, `${a.name}: ${r.status} ${code ?? r.body.slice(0, 80)} (want ${a.want.map(([s, c]) => `${s} ${c}`).join(" or ")})`);
    say(typeof r.headers["x-helper-commit"] === "string" && SHA.test(r.headers["x-helper-commit"]), `${a.name}: X-Helper-Commit ${r.headers["x-helper-commit"]}`);
    say(r.headers["access-control-allow-origin"] === APP, `${a.name}: APP_HOST echoed (${r.headers["access-control-allow-origin"]})`);
    say(Buffer.byteLength(r.body) <= 1024 && !/tx_hash/.test(r.body), `${a.name}: a body under 1 KB with no tx_hash`);
    if (a.method === "GET") say(r.headers.allow === "POST, OPTIONS", `GET: Allow ${r.headers.allow}`);
  }
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (k) => {
    const i = args.indexOf(k);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const run = await read(opt("--base") ?? BASE);
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify(run, null, 1)}\n`);
    const r = judge(run);
    for (const l of r.lines) console.log(l);
    console.log(r.ok ? "PASS" : "FAIL");
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
