// No test settles by counting event-loop turns (card settle-checks-wait-for-crypto). The thread pool runs WebCrypto's
// jobs (the wallet store's AES-GCM, digests, key work), and each answer comes back on a later turn that no immediate
// waits for: a loop of N `await new Promise((r) => setImmediate(r))` or N `await Promise.resolve()` is a clock in
// disguise, and a machine whose threads are busy keeps a job past any N. PR 1121 was refused in the merge queue by one
// (run 44907577683: tap-prepare-page.test.ts's 500 turns, past which one note read still ran on a busy runner).
//
// A test waits through its package's test/settle.ts: settle(until) runs turns until `until()` holds or no immediate is
// active and no thread-pool job is in flight; quiet() until the latter. What this refuses, in a unit test file of SCOPE:
// a turn awaited inside a for or while loop's body, where a turn is `new Promise((r) => setImmediate(r))`,
// `Promise.resolve()`, node:timers/promises' `setImmediate()` under any name it is imported as, `scheduler.yield()`, or a
// name the file defines as one (`const turn = () => new Promise((r) => setImmediate(r))`).
// Strings and comments are left out. LISTED counts the loops still in files the busy-crypto sweep passed (every file's
// process with eight key derivations always on the thread pool, 21 Nov): a file may hold no more than its count, and
// a count above what a file holds is only noted. Never a place for a new one.
//   node scripts/ci/turn-settle.mjs    lists each turn loop in the tracked tests, exit 1 on any past LISTED
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { code, refusals, stale } from "./no-wall-clock-asserts.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// the packages whose tests read the wallet store or run WebCrypto, each with its own test/settle.ts
export const SCOPE = ["packages/kit/test/**", "packages/signpage/test/**", "packages/wallet/test/**"];
const UNIT_TEST = /\.test\.[cm]?[jt]sx?$/;

export const LISTED = {
  "packages/kit/test/evm-buy-tap.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/evm-quote-attacks.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/pool-usd.test.ts": { count: 4, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/rpc-signal.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/signpage-client-closed.test.mjs": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/signpage-client-parent-late.test.mjs": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/signpage-client-parent.test.mjs": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/signpage-client.test.mjs": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/solana-pool-buy-read-bound.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/solana-rpc-retry.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/kit/test/solana-send.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/aborted-before-wait.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/cash-buy-waits-for-its-move.test.ts": { count: 4, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/deposit-dry.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/deposit-follow.test.ts": { count: 1, why: "a test here fails with busy crypto threads (21 Nov sweep): still to convert" },
  "packages/signpage/test/deposit-name.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/deposit-pool-coin.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/deposit-wire.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/dry-beside-cash.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/move-sends-or-says-why.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-buy-evm.test.ts": { count: 7, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-buy.test.ts": { count: 3, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-deposit-address.test.ts": { count: 4, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-price.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-restore.test.ts": { count: 2, why: "a test here fails with busy crypto threads (21 Nov sweep): still to convert" },
  "packages/signpage/test/pool-testnet.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-withdraw-evm.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/pool-withdraw.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/positions-requests.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/proof-front.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/quote-early-pools.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/quotes-signed-out.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/reads-take-the-call-signal.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/reference-scan-fault.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/refund-move.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/signpage/test/rules-deposit-quote.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/aborted-before-wait.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/buy-wallets-side-by-side.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/buy-wallets.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/deposit-bind.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/deposit-follow.test.ts": { count: 8, why: "a test here fails with busy crypto threads (21 Nov sweep): still to convert" },
  "packages/wallet/test/deposit-quote.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/keyed-pool-pages.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pace.test.ts": { count: 5, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-evm-mixed-backends.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-evm-narrow-pages.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-evm-narrow-seat-walks.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-evm-wide-capped-pages.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-evm.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-queue-ranked.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-queue.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/pool-solana.test.ts": { count: 7, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/throttle.test.ts": { count: 2, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
  "packages/wallet/test/withdraw-relay.test.ts": { count: 1, why: "passed with eight key derivations always busy on the thread pool (21 Nov sweep)" },
};

const NAME = String.raw`[A-Za-z_$][\w$]*`;
// `new Promise((r) => setImmediate(r))` in its usual spellings: a typed promise, a bare or wrapped parameter, `void`
const IMMEDIATE = String.raw`new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*(${NAME})\s*(?::[^)=]*)?\)?\s*=>\s*(?:void\s+)?setImmediate\s*\(\s*\1\s*\)\s*\)`;
const RESOLVED = String.raw`Promise\.resolve\s*\(\s*\)`;
// node:timers/promises' setImmediate() (its only zero-argument form: the callback one needs its callback), under any
// alias an import or a destructuring gives it, and scheduler.yield()
const PROMISED = String.raw`(?:[\w$]+\.)?(?:setImmediate|scheduler\.yield)\s*\(\s*\)`;

/** The index just past the bracket that closes the one at `open`. */
function closing(src, open) {
  const pair = { "(": ")", "{": "}", "[": "]" };
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c in pair) stack.push(pair[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return src.length;
}

/** Each loop body's span: a for or while header, then its braced block or its one statement. */
function loopBodies(src) {
  const out = [];
  for (const m of src.matchAll(/\b(?:for|while)\s*\(/g)) {
    const head = closing(src, m.index + m[0].length - 1);
    let i = head;
    while (/\s/.test(src[i] ?? "")) i++;
    if (src[i] === "{") out.push([i, closing(src, i)]);
    else {
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        const c = src[j];
        if ("({[".includes(c)) depth++;
        else if (")}]".includes(c)) {
          if (depth === 0) break;
          depth--;
        } else if (c === ";" && depth === 0) break;
      }
      out.push([i, j]);
    }
  }
  return out;
}

/** Every turn a test's text awaits inside a loop's body: [{ line, text }], one per await. */
export function findings(text) {
  const src = code(text);
  // the names the file defines as one turn
  const names = [...src.matchAll(new RegExp(String.raw`(?:const|let|var)\s+(${NAME})\s*(?::[^;]*?)?=\s*(?:async\s*)?\(\s*\)\s*(?::[^=]*)?=>\s*(?:${IMMEDIATE.replace("\\1", "\\2")}|${RESOLVED})`, "g"))].map((m) => m[1]);
  for (const m of src.matchAll(new RegExp(String.raw`\bsetImmediate\s*(?:as|:)\s*(${NAME})`, "g"))) names.push(m[1]);
  const named = names.length > 0 ? `|(?:${names.map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(\\s*\\)` : "";
  const turn = new RegExp(String.raw`\bawait\s+(?:${IMMEDIATE}|${RESOLVED}|${PROMISED}${named})`, "g");
  const bodies = loopBodies(src);
  const lines = text.split("\n");
  const out = [];
  for (const m of src.matchAll(turn)) {
    if (!bodies.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ line, text: lines[line - 1].trim().slice(0, 160) });
  }
  return out;
}

/** Every tracked unit test in SCOPE with the turns it awaits in a loop. */
export function scan(root = ROOT) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCOPE.map((g) => `:(glob)${g}`)], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((f) => UNIT_TEST.test(f));
  const out = {};
  for (const f of files) {
    const found = findings(readFileSync(path.join(root, f), "utf8"));
    if (found.length > 0) out[f] = found;
  }
  return out;
}

export { refusals, stale };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan();
  for (const [f, list] of Object.entries(found)) for (const x of list) console.log(`${f}:${x.line}  ${x.text}`);
  for (const x of stale(found, LISTED)) console.log(`LISTED can be lowered: ${x}`);
  const bad = refusals(found, LISTED, "turn loop");
  if (bad.length > 0) {
    console.error(`\n${bad.join("\n")}\n\nWait through the package's test/settle.ts: settle(until) or quiet(), never a count of turns.`);
    process.exit(1);
  }
}
