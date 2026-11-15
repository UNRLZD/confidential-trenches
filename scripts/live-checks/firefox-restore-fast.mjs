#!/usr/bin/env node
// Card firefox-restore-fast: the restore's walk hashes on BN254's field in WebAssembly (packages/wallet/src/notes/
// field-wasm.ts), so a restore in Firefox draws the balance in seconds and ends inside its bound; on BigInt Firefox's
// walk of four pools took 90 s (merge queue run 43663711503). The walk runs in SIGN_HOST's /walk-worker.js, which
// compiles the module only where its policy lets it ('wasm-unsafe-eval'); without it the walk falls back to BigInt,
// slow and silent. So the check reads what is deployed:
//   - /walk-worker.js's Content-Security-Policy (Pages joins the /* rule's and the file's own with a comma): the file's
//     own policy is exactly "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'", and no policy carries
//     'unsafe-eval';
//   - /walk-worker.js's bytes carry the field module (its builder's own refusal text, which minifying keeps).
// After: sign
//   node scripts/live-checks/firefox-restore-fast.mjs [--answer <file>] [--record <file>]
// PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "firefox-restore-fast";
export const SIGN = "https://confidential.unrealized.trade";
export const WALK_PATH = "/walk-worker.js";
export const WALK_POLICY = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'";
/** The field module's mark in the walk Worker's bytes (field-wasm.ts slot()'s refusal). */
export const FIELD_MARK = "field-wasm: out of slots";

/** What the check keeps of the read: the walk file's status, its CSP header, and whether its bytes carry the field. */
export function facts(status, csp, js) {
  return { status, csp, field: js.includes(FIELD_MARK) };
}

/** The verdict on an answer { status, csp, field }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  if (a?.status !== 200) bad(`${WALK_PATH}: HTTP ${a?.status}`);
  const policies = String(a?.csp ?? "").split(",").map((p) => p.trim().replace(/\s+/g, " ").replace(/;\s*$/, ""));
  if (!policies.includes(WALK_POLICY)) bad(`${WALK_PATH}'s policy is not "${WALK_POLICY}": ${JSON.stringify(a?.csp ?? null)}`);
  if (policies.some((p) => /'unsafe-eval'/.test(p))) bad(`${WALK_PATH}'s policy carries 'unsafe-eval'`);
  if (a?.field !== true) bad(`${WALK_PATH} carries no WebAssembly field: the walk hashes on BigInt`);
  if (lines.length === 0) lines.push(`ok ${WALK_PATH}: its own policy compiles WebAssembly and its bytes carry the field`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

export async function read(fetchFn = fetch) {
  const r = await fetchFn(`${SIGN}${WALK_PATH}`, { redirect: "error" });
  return facts(r.status, r.headers.get("content-security-policy"), r.status === 200 ? await r.text() : "");
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read();
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(v.ok ? `PASS ${KEY}` : `FAIL ${KEY}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
