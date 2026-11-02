#!/usr/bin/env node
// Live check of card helper-host-health: HELPER_HOST answers GET /v1/health (markets paper H7 and 7.1). It reads the
// path three times, with Origin APP_HOST, SIGN_HOST and https://example.com, and passes only when:
//   - each answer is 200 with JSON {ok: true, commit, parts} whose parts are exactly proxy, relay, intents, delegate,
//     orders and log, each "up" or "down";
//   - X-Helper-Commit, and the body's commit, equal the expected commit: main's newest first-parent commit that
//     changed one of the image's inputs (IMAGE_INPUTS, apps/helper/deploy/image-inputs.mjs: the helper, the kit, the
//     root manifests, the lockfile and .dockerignore), or --commit;
//   - APP_HOST and SIGN_HOST are each echoed exactly in Access-Control-Allow-Origin; example.com gets none; no answer
//     carries `*` or Access-Control-Allow-Credentials; every answer has Vary: Origin;
//   - deposits are carried (card helper-testnet-carry): every answer lists the delegate part (POST /v1/bind) "up",
//     and POST /v1/bind with a body that is no SignedDelegateAction answers the route's own 400 bad_shape, not 404.
//     That read sends nothing anywhere: check 1 refuses the body before any chain read.
//   node scripts/live-checks/helper-host-health.mjs [--base <url>] [--commit <sha>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2. --record writes what the run read, so the check's test can replay it.
import "../net-window.mjs";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { IMAGE_INPUTS } from "../../apps/helper/deploy/image-inputs.mjs";

const KEY = "helper-host-health";
export const BASE = "https://api.confidential.unrealized.trade";
export const APP = "https://confidential.unrealized.trade";
export const SIGN = "https://sign.confidential.unrealized.trade";
export const OTHER = "https://example.com";
export const PARTS = ["proxy", "relay", "intents", "delegate", "orders", "log"];
/** POST /v1/bind's probe: not one SignedDelegateAction, so the route answers check 1's bad_shape and reads nothing. */
export const BIND_PROBE = JSON.stringify({ signed_delegate: "AAAA" });
const SHA = /^[0-9a-f]{40}$/;

const show = (v) => (v === undefined ? "none" : JSON.stringify(v));

/** The check on one recorded run: { reads: [{ origin, status, headers, body }], bind }, against the expected commit. */
export function judge({ reads, bind }, commit) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  say(SHA.test(commit ?? ""), `expected commit ${show(commit)} is a full sha`);
  for (const want of [APP, SIGN, OTHER]) {
    const r = reads.find((x) => x.origin === want);
    if (!r) {
      say(false, `[${want}] no read`);
      continue;
    }
    const h = r.headers;
    const tag = `[${want}]`;
    say(r.status === 200, `${tag} GET /v1/health answers ${r.status}`);
    let b;
    try {
      b = JSON.parse(r.body);
    } catch {
      b = undefined;
    }
    say(b?.ok === true, `${tag} ok: ${show(b?.ok)}`);
    const keys = b?.parts && typeof b.parts === "object" ? Object.keys(b.parts) : [];
    const sameParts = keys.length === PARTS.length && PARTS.every((p) => keys.includes(p));
    say(sameParts, `${tag} parts are exactly ${PARTS.join(", ")}: ${keys.join(", ") || "none"}`);
    const states = keys.every((k) => b.parts[k] === "up" || b.parts[k] === "down");
    say(sameParts && states, `${tag} each part is "up" or "down"`);
    say(b?.parts?.delegate === "up", `${tag} delegate (POST /v1/bind) is ${show(b?.parts?.delegate)}, want "up"`);
    say(h["x-helper-commit"] === commit, `${tag} X-Helper-Commit: ${show(h["x-helper-commit"])}${h["x-helper-commit"] === commit ? "" : `, want ${show(commit)}`}`);
    say(b?.commit === commit, `${tag} body commit equals it`);
    const acao = h["access-control-allow-origin"];
    const wantAcao = want === OTHER ? undefined : want;
    say(acao === wantAcao, `${tag} Access-Control-Allow-Origin: ${show(acao)}${acao === wantAcao ? "" : `, want ${show(wantAcao)}`}`);
    say(!String(acao ?? "").includes("*"), `${tag} no * in Access-Control-Allow-Origin`);
    say(h["access-control-allow-credentials"] === undefined, `${tag} no Access-Control-Allow-Credentials`);
    const vary = (h["vary"] ?? "").split(",").map((s) => s.trim().toLowerCase());
    say(vary.includes("origin"), `${tag} Vary: ${show(h["vary"])} names Origin`);
  }
  let code;
  try {
    code = JSON.parse(bind?.body ?? "").error?.code;
  } catch {
    code = undefined;
  }
  say(bind?.status === 400 && code === "bad_shape", `POST /v1/bind with no SignedDelegateAction answers ${show(bind?.status)} ${show(code)}, want 400 "bad_shape"`);
  say(bind !== undefined && bind.headers["x-helper-commit"] === commit, `POST /v1/bind's X-Helper-Commit: ${show(bind?.headers["x-helper-commit"])}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

export async function read(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const origin of [APP, SIGN, OTHER]) {
    const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/health`, { redirect: "manual", headers: { origin, "cache-control": "no-cache" } });
    const headers = {};
    for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
    reads.push({ origin, status: r.status, headers, body: await r.text() });
  }
  const r = await fetchFn(`${base.replace(/\/$/, "")}/v1/bind`, { method: "POST", redirect: "manual", headers: { origin: APP, "content-type": "application/json" }, body: BIND_PROBE });
  const headers = {};
  for (const [k, v] of r.headers) headers[k.toLowerCase()] = v;
  const bind = { status: r.status, headers, body: await r.text() };
  return { base, reads, bind };
}

export function mainCommit() {
  const out = execFileSync("git", ["rev-list", "-1", "--first-parent", "main", "--", ...IMAGE_INPUTS], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (!SHA.test(out)) throw new Error("main has no commit that changed the helper image's inputs; pass --commit");
  return out;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  try {
    const commit = opt("--commit") ?? mainCommit();
    const answer = await read(opt("--base", BASE));
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ commit, ...answer }, null, 1)}\n`);
    const { ok, lines } = judge(answer, commit);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${ok ? "PASS" : "FAIL"} (${answer.base}, commit ${commit})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
