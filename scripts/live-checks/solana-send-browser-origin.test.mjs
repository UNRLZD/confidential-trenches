// node --test scripts/live-checks/solana-send-browser-origin.test.mjs: the live check replays recorded answers
// (solana-send-browser-origin.answers.json), read 2026-11-18 12:10Z with SIGN_HOST's Origin:
//   - recorded: the deployed SIGN_HOST and the send paths; the served connect-src still names api.mainnet-beta: FAIL on
//     that line alone;
//   - good: recorded with its connect-src the committed _headers' (the policy this card deploys), until the first sign
//     deploy of it is recorded: PASS;
//   - bad: read with --rpc https://api.mainnet-beta.solana.com, the kit's public send path before this card: its POST
//     403 "Access forbidden" and the CSP: FAIL.
// Planted on good: a send path's preflight or answer unreadable by the page, a 429 (INCONCLUSIVE, never PASS).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { JITO, judge, REFUSED, RPC, SENDER } from "./solana-send-browser-origin.mjs";
import { SOLANA_JITO_TRANSACTIONS_URL, SOLANA_PUBLIC_RPC_URL, SOLANA_SENDER_FAST_URL } from "../../packages/kit/src/index.ts";

const ANSWERS = JSON.parse(readFileSync(new URL("./solana-send-browser-origin.answers.json", import.meta.url), "utf8"));
const { good: GOOD, recorded: RECORDED, bad: BAD } = ANSWERS;
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD"));
const connectOf = (csp) => csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));

test("the check's send paths are the kit's, and its public path the kit's default", () => {
  assert.deepEqual([SENDER, JITO, RPC], [SOLANA_SENDER_FAST_URL, SOLANA_JITO_TRANSACTIONS_URL, SOLANA_PUBLIC_RPC_URL]);
});

test("good is recorded with the committed _headers' connect-src, and nothing else changed", () => {
  const committed = connectOf(/^\/\*\n(?: {2}[^\n]*\n)*? {2}Content-Security-Policy: ([^\n]*)/m.exec(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage/public/_headers"), "utf8"))[1]);
  assert.deepEqual(GOOD, { ...RECORDED, csp: RECORDED.csp.replace(connectOf(RECORDED.csp), committed) });
});

test("recorded good answer: every send path answers the page's Origin, connect-src names them and no refusing host: PASS", () => {
  const v = judge(GOOD);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(bads(v).length, 0);
});

test("recorded answer of the deployed page before this card: FAIL on connect-src naming api.mainnet-beta alone", () => {
  const v = judge(RECORDED);
  assert.equal(v.verdict, "FAIL");
  assert.deepEqual(bads(v), ["BAD connect-src names no host that refuses the page's Origin (https://api.mainnet-beta.solana.com)"]);
});

test("recorded bad answer: the public send path api.mainnet-beta, 403 to the page's Origin: FAIL", () => {
  const v = judge(BAD);
  assert.equal(v.verdict, "FAIL");
  assert.equal(BAD.rpc.post.status, 403);
  assert.deepEqual(bads(v), [
    "BAD connect-src names no host that refuses the page's Origin (https://api.mainnet-beta.solana.com)",
    "BAD rpc api.mainnet-beta.solana.com HTTP 403: refuses https://confidential.unrealized.trade",
  ]);
});

test("planted: a send path the page may not read, one missing from connect-src, a refused host listed: FAIL", () => {
  const fails = (a, re) => {
    const v = judge(a);
    assert.equal(v.verdict, "FAIL", v.lines.join("\n"));
    assert.ok(bads(v).some((l) => re.test(l)), bads(v).join("\n"));
  };
  fails({ ...GOOD, jito: { ...GOOD.jito, post: { ...GOOD.jito.post, acao: "https://other.example" } } }, /may not read its answer/);
  fails({ ...GOOD, jito: { ...GOOD.jito, preflight: { ...GOOD.jito.preflight, acao: null } } }, /^BAD jito: its CORS preflight/);
  fails({ ...GOOD, sender: { ...GOOD.sender, ping: { status: 200, acao: null } } }, /^BAD sender:/);
  fails({ ...GOOD, rpc: { ...GOOD.rpc, post: { ...GOOD.rpc.post, status: 401 } } }, /HTTP 401: refuses/);
  fails({ ...GOOD, rpc: { ...GOOD.rpc, post: { error: { code: -32601, message: "Method not found" }, status: 200, acao: "*" } } }, /answers a blockhash/);
  fails({ ...GOOD, csp: GOOD.csp.replace(" https://sender.helius-rpc.com", "") }, /send path https:\/\/sender\.helius-rpc\.com$/);
  for (const h of REFUSED) fails({ ...GOOD, csp: GOOD.csp.replace("connect-src 'self'", `connect-src 'self' ${h}`) }, new RegExp(`refuses the page's Origin \\(${h.replace(/\./g, "\\.")}\\)`));
});

test("planted: a send host that gives no answer (a 429, a 5xx, no fetch) is INCONCLUSIVE, never PASS", () => {
  for (const a of [
    { ...GOOD, sender: { ...GOOD.sender, ping: { status: 429, acao: "*" } } },
    { ...GOOD, rpc: { ...GOOD.rpc, post: { noAnswer: "solana-rpc.publicnode.com HTTP 503: a passing fault", status: 503, acao: null } } },
    { ...GOOD, jito: { ...GOOD.jito, preflight: { noAnswer: "mainnet.block-engine.jito.wtf: no answer (ECONNRESET)" } } },
  ]) assert.equal(judge(a).verdict, "INCONCLUSIVE");
});
