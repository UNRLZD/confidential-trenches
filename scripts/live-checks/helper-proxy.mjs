#!/usr/bin/env node
// Live check of card helper-proxy: the device reaches a keyed vendor through HELPER_HOST and never sees a key
// (markets paper H2.1, H7 row POST /v1/proxy/{vendor}/{path}, M4.1 "an upstream key never in a response"). It calls
// one proxied path, POST /v1/proxy/oneclick/v0/tokens (1Click's token list, read with the partner JWT when the host
// holds one), with Origin APP_HOST, and passes only when:
//   - the answer is 200, JSON, a non-empty array of token rows, each with a string assetId, blockchain and symbol, an
//     integer decimals from 0 to 255 and a finite price;
//   - X-Helper-Source is "oneclick", X-Fetched-At is an ISO time within 10 minutes of the read, X-Helper-Commit is a
//     full sha, Access-Control-Allow-Origin echoes APP_HOST and Access-Control-Allow-Credentials is absent;
//   - no vendor key the host holds appears in any header or in the body, as set, in base64, base64url or URL-encoded.
// The keys to look for are read into this process only: from the macOS Keychain (ct-jupiter, ct-relay, ct-lifi,
// ct-1click), or with --keys-env from this process's JUPITER_API_KEY, RELAY_API_KEY, LIFI_API_KEY and ONECLICK_JWT
// (the local proof's planted keys). With no key to look for, the check is an error, never a pass.
//   node scripts/live-checks/helper-proxy.mjs [--base <url>] [--keys-env] [--record <file> --planted]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read; it writes the keys only with --planted
//   (keys made for a local proof, never a real one), so the check's test can replay it.
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const KEY = "helper-proxy";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const PATH = "/v1/proxy/oneclick/v0/tokens";
const ENV_KEYS = ["JUPITER_API_KEY", "RELAY_API_KEY", "LIFI_API_KEY", "ONECLICK_JWT"];
const KEYCHAIN = ["ct-jupiter", "ct-relay", "ct-lifi", "ct-1click"];
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** Every form a key could leave in. */
export function forms(key) {
  const b = Buffer.from(key, "utf8");
  return [...new Set([key, b.toString("base64").replace(/=+$/, ""), b.toString("base64url"), encodeURIComponent(key)])];
}

/** The check on one recorded read { status, headers, body, readAt }, against the keys the host holds. */
export function judge(r, keys) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(keys.length > 0, `${keys.length} vendor key(s) to look for`);
  say(r.status === 200, `POST ${PATH} answers ${r.status}`);
  const h = r.headers;
  say(/^application\/json/i.test(h["content-type"] ?? ""), `Content-Type: ${show(h["content-type"])}`);
  let b;
  try {
    b = JSON.parse(r.body);
  } catch {
    b = undefined;
  }
  const rows = Array.isArray(b) ? b : [];
  say(rows.length > 0, `body is a non-empty array of token rows: ${Array.isArray(b) ? rows.length : "not an array"}`);
  const badRow = rows.findIndex(
    (t) =>
      !t ||
      typeof t !== "object" ||
      typeof t.assetId !== "string" ||
      typeof t.blockchain !== "string" ||
      typeof t.symbol !== "string" ||
      !Number.isInteger(t.decimals) ||
      t.decimals < 0 ||
      t.decimals > 255 ||
      typeof t.price !== "number" ||
      !Number.isFinite(t.price),
  );
  say(rows.length > 0 && badRow === -1, `every row has assetId, blockchain, symbol, decimals and price${badRow === -1 ? "" : `: row ${badRow} is ${show(rows[badRow])?.slice(0, 200)}`}`);
  say(h["x-helper-source"] === "oneclick", `X-Helper-Source: ${show(h["x-helper-source"])}`);
  const at = Date.parse(h["x-fetched-at"] ?? "");
  const fresh = ISO.test(h["x-fetched-at"] ?? "") && Math.abs(Date.parse(r.readAt) - at) <= 600_000;
  say(fresh, `X-Fetched-At: ${show(h["x-fetched-at"])}, within 10 min of the read at ${r.readAt}`);
  say(SHA.test(h["x-helper-commit"] ?? ""), `X-Helper-Commit: ${show(h["x-helper-commit"])}`);
  say(h["access-control-allow-origin"] === APP, `Access-Control-Allow-Origin: ${show(h["access-control-allow-origin"])}`);
  say(h["access-control-allow-credentials"] === undefined, "no Access-Control-Allow-Credentials");
  keys.forEach((k, i) => {
    const where = [];
    for (const f of forms(k)) {
      for (const [name, value] of Object.entries(h)) if (String(value).includes(f) || name.includes(f.toLowerCase())) where.push(`header ${name}`);
      if (r.body.includes(f)) where.push("body");
    }
    say(where.length === 0, `key ${i + 1} (${k.length} chars) appears nowhere${where.length ? `: found in ${[...new Set(where)].join(", ")}` : ""}`);
  });
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const readAt = new Date().toISOString();
  const r = await fetchFn(`${base.replace(/\/$/, "")}${PATH}`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: APP, "content-type": "application/json", "cache-control": "no-cache" },
  });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  return { base, readAt, status: r.status, headers, body: await r.text() };
}

export function keychainKeys() {
  const keys = [];
  for (const s of KEYCHAIN) {
    try {
      const v = execFileSync("security", ["find-generic-password", "-s", s, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (v) keys.push(v);
    } catch {
      // not in the Keychain: that vendor's key is not looked for
    }
  }
  return keys;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const keys = a.includes("--keys-env") ? ENV_KEYS.map((n) => process.env[n]).filter(Boolean) : keychainKeys();
    if (keys.length === 0) throw new Error("no vendor key to look for (Keychain ct-jupiter, ct-relay, ct-lifi, ct-1click, or --keys-env)");
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) {
      const rec = { ...answer, keys: a.includes("--planted") ? keys : `${keys.length} real key(s), not recorded` };
      writeFileSync(opt("--record"), `${JSON.stringify(rec, null, 1)}\n`);
    }
    const { ok, lines } = judge(answer, keys);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
