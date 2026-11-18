#!/usr/bin/env node
// Live check of card helper-scrubber-takes-the-kits-rule: the helper's error answer for a provider read the keyed Base and
// Robinhood providers refuse holds no key-shaped run. After a helper deploy it asks, as the signing page does (Origin
// SIGN_HOST), each chain's ?keyed=only RPC route (the chain's keyed URLs alone) for one eth_call whose data is odd-length
// hex, which every provider refuses as bad params; the helper answers with the provider's refusal, or its own words.
// A key-shaped run is 16 or more characters of a key's alphabet (letters, digits, - _ + / = %) holding a letter and a
// digit that is not 0x-hex: a provider key (dRPC's, QuickNode's 40-hex path, Alchemy's), whole or cut, as written or
// percent-encoded, with or without its URL path before it.
// PASS when each chain answers a JSON-RPC error with none. FAIL when any answer's words (its error, or a no-answer's
// quoted body) hold one. INCONCLUSIVE when a chain answers nothing usable (provider-answer.mjs's no-answer: a timeout,
// a 429, a passing fault) or a result (no refused read reached). The keys exist only on the helper box: this check reads
// the helper alone, never a provider, one read a chain.
// After: helper
// Serial: evm-keyed 215 (its reads draw the keyed Base and Robinhood providers)
//   node scripts/live-checks/helper-scrubber-takes-the-kits-rule.mjs [--base <url>] [--record <file>]
//   PASS exit 0, FAIL exit 1, error exit 2, INCONCLUSIVE exit 3.
import "../net-window.mjs";
import { writeFileSync } from "node:fs";
import { EXIT, rpcAnswer, verdictOf } from "./provider-answer.mjs";

const KEY = "helper-scrubber-takes-the-kits-rule";
export const BASE = "https://ct-api.unrealized.trade";
export const SIGN = "https://confidential.unrealized.trade";
export const CHAINS = ["base", "robinhood"];
/** The refused read: an eth_call to the identity precompile whose data is odd-length hex. */
export const READ = ["eth_call", [{ to: "0x0000000000000000000000000000000000000004", data: "0x0" }, "latest"]];
export const TIMEOUT_MS = 15_000;
const KEY_CHARS = "A-Za-z0-9_\\-+/=%";
const RUN = new RegExp(`(?<![${KEY_CHARS}])[${KEY_CHARS}]{16,}(?![${KEY_CHARS}])`, "g");

/** The key-shaped runs in `text`: each a run of RUN holding a letter and a digit, 0x-hex left out. */
export function keyRuns(text) {
  return [...String(text).matchAll(RUN)].map((m) => m[0]).filter((r) => /[A-Za-z]/.test(r) && /[0-9]/.test(r) && !/^0x[0-9a-f]+$/i.test(r));
}

/** The verdict on a record: `{ reads: [{ chain, status, error | result | noAnswer }] }`. */
export function judge(rec) {
  const lines = [];
  let bad = false;
  let quiet = false;
  const reads = Array.isArray(rec?.reads) ? rec.reads : [];
  for (const c of CHAINS) {
    const r = reads.find((x) => x?.chain === c);
    if (r === undefined) {
      lines.push(`--  [${c}] no read recorded`);
      quiet = true;
      continue;
    }
    const words = r.error !== undefined ? JSON.stringify(r.error) : r.noAnswer !== undefined ? String(r.noAnswer) : "";
    const runs = keyRuns(words);
    if (runs.length > 0) {
      bad = true;
      // the run itself is never printed: its length and first 4 characters name it
      lines.push(`BAD [${c}] the answer holds ${runs.length} key-shaped run(s): ${runs.map((x) => `${x.slice(0, 4)}… (${x.length} characters)`).join(", ")}`);
    } else if (r.error !== undefined) lines.push(`ok  [${c}] HTTP ${r.status}: a refusal with no key-shaped run (${words.slice(0, 120)})`);
    else if (r.noAnswer !== undefined) (quiet = true), lines.push(`--  [${c}] no answer: ${String(r.noAnswer).slice(0, 120)}`);
    else (quiet = true), lines.push(`--  [${c}] HTTP ${r.status}: a result, so no refused read was reached`);
  }
  const verdict = verdictOf(bad, quiet);
  return { verdict, ok: verdict === "PASS", lines };
}

export async function readAll(base = BASE, fetchFn = fetch) {
  const reads = [];
  for (const chain of CHAINS) {
    const a = await rpcAnswer(`${base.replace(/\/$/, "")}/v1/rpc/${chain}?keyed=only`, READ[0], READ[1], { fetchFn, timeoutMs: TIMEOUT_MS, headers: { origin: SIGN }, redirect: "error" });
    const { acao: _acao, ...kept } = a;
    reads.push({ chain, ...kept });
  }
  return { at: new Date().toISOString(), base, reads };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const rec = await readAll(arg("--base") ?? BASE);
    const file = arg("--record");
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    const r = judge(rec);
    for (const l of r.lines) console.log(l);
    console.log(`${KEY}: ${r.verdict}`);
    process.exit(EXIT[r.verdict]);
  } catch (e) {
    console.error(`${KEY}: ERROR ${e?.message ?? e}`);
    process.exit(EXIT.ERROR);
  }
}
