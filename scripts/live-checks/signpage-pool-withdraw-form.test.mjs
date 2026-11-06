// node --test scripts/live-checks/signpage-pool-withdraw-form.test.mjs: the live check replays recorded answers
// (signpage-pool-withdraw-form.answers.json). bad: a real devnet pool buy read in the withdraw's place: FAIL, a table
// and no transfer named. none: no run recorded yet: FAIL. Planted on the bad one's SIGN_HOST read: a served /app.js
// that is not the pinned one: FAIL. good: the devnet withdraw run as recorded (signpage-pool-withdraw-form.md): PASS.
// A synthesized good part (the release alone to W, then W's own transfer of the part to To, W at 0) must PASS and
// each way a part can go wrong, planted on it, must FAIL (review #232b LOW 6).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPUTE_BUDGET, judge, PIN, SYSTEM, TO } from "./signpage-pool-withdraw-form.mjs";

const ANSWERS = JSON.parse(readFileSync(new URL("./signpage-pool-withdraw-form.answers.json", import.meta.url), "utf8"));

test("recorded good answer: the devnet withdraw run, its part's release then W's transfer to To, W at 0: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.equal(ANSWERS.good.run.length, 1);
  assert.equal(ANSWERS.good.run[0].part, "2177099");
});

test("recorded bad answer: a devnet pool buy in the withdraw's place: FAIL, its table and its instructions named", () => {
  const v = judge(ANSWERS.bad);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => l.endsWith("loads a lookup table")), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.endsWith("not a tag 2 release of the pinned program")), v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.endsWith("(onward): not on both RPCs at finalized")), v.lines.join("\n"));
  assert.ok(!v.lines.some((l) => l.includes("SIGN_HOST")), "SIGN_HOST serves its pinned /app.js");
});

test("recorded answer with no run: FAIL until the withdraw lands", () => {
  assert.deepEqual(judge(ANSWERS.none).lines, ["BAD no run of the withdraw recorded"]);
});

test("planted: SIGN_HOST serving another /app.js, or no pin at all: FAIL", () => {
  const b = ANSWERS.bad;
  assert.ok(judge({ ...b, sign: { ...b.sign, sha384: "sha384-other" } }).lines.includes("BAD SIGN_HOST's served /app.js is not the one index.html pins"));
  assert.ok(judge({ ...b, sign: { ...b.sign, index: "<html></html>" } }).lines.includes("BAD SIGN_HOST's index.html pins no /app.js"));
});

// ---- synthesized parts: legacy wire transactions built here, keys in the order given (signers first)
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const unb58 = (s) => {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--, n >>= 8n) out[i] = Number(n & 255n);
  return out;
};
const W = "8ZaB3F8sWMGBzrmnHdKCC4VjbtJv4h9JAZqPWbQxjK1p";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const BH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const PART = 5_000_000n;
const wire = (signers, ixs) => {
  const keys = [...signers];
  for (const ix of ixs) for (const k of [...ix.accounts, ix.program]) if (!keys.includes(k)) keys.push(k);
  const bytes = [signers.length, ...new Array(64 * signers.length).fill(0), signers.length, 0, 0, keys.length, ...keys.flatMap((k) => [...unb58(k)]), ...unb58(BH), ixs.length];
  for (const ix of ixs) bytes.push(keys.indexOf(ix.program), ix.accounts.length, ...ix.accounts.map((k) => keys.indexOf(k)), ix.data.length, ...ix.data);
  return Buffer.from(bytes).toString("base64");
};
const u64 = (v) => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 255n));
const transfer = (from, to, v) => ({ program: SYSTEM, accounts: [from, to], data: [2, 0, 0, 0, ...u64(v)] });
const release = { program: PIN.program, accounts: [OTHER, W, PIN.feePayer], data: [2, 0, 0] };
const cu = { program: COMPUTE_BUDGET, accounts: [], data: [2, 0, 0x1a, 6, 0] };
const read = (b64, pre, post) => ({ transaction: [b64, "base64"], meta: { err: null, preBalances: pre, postBalances: post } });
const both = (r) => [r, structuredClone(r)];
const relPart = { signature: "R".repeat(88), reads: both(read(wire([PIN.feePayer, W], [cu, release]), [], [])) };
const onPart = (b64, pre = [5_005_000, 0, 1], post = [0, 5_000_000, 1]) => ({ signature: "O".repeat(88), reads: both(read(b64, pre, post)) });
const GOOD = { sign: ANSWERS.bad.sign, run: [{ part: String(PART), release: relPart, onward: onPart(wire([W], [transfer(W, TO, PART)])) }] };
const failsWith = (a, end) => {
  const v = judge(a);
  assert.equal(v.ok, false, v.lines.join("\n"));
  assert.ok(v.lines.some((l) => l.startsWith("BAD") && l.endsWith(end)), v.lines.join("\n"));
};

test("synthesized good part: the release alone to W, W's own transfer of the part to To, W at 0: PASS", () => {
  const v = judge(GOOD);
  assert.equal(v.ok, true, v.lines.join("\n"));
});

test("planted on the good part, each way a withdraw part goes wrong: FAIL, named", () => {
  const p = GOOD.run[0];
  // no onward send
  failsWith({ ...GOOD, run: [{ ...p, onward: { signature: "", reads: [null, null] } }] }, "(onward): not on both RPCs at finalized");
  // one transaction: the release with W's transfer after it, read as both
  const one = { signature: "C".repeat(88), reads: both(read(wire([PIN.feePayer, W], [cu, release, transfer(W, TO, PART)]), [1, 5_005_000, 1, 0, 1, 0, 1], [1, 0, 1, 0, 1, 5_000_000, 1])) };
  failsWith({ ...GOOD, run: [{ ...p, release: one, onward: one }] }, "(release): not the release alone after the compute budget");
  // W not at 0
  failsWith({ ...GOOD, run: [{ ...p, onward: onPart(wire([W], [transfer(W, TO, PART)]), [5_010_000, 0, 1], [5_000, 5_000_000, 1]) }] }, "(onward): W kept lamports");
  // To not the one typed
  failsWith({ ...GOOD, run: [{ ...p, onward: onPart(wire([W], [transfer(W, OTHER, PART)])) }] }, "(onward): the transfer is not from W to To");
  // the onward from another wallet than the release's W
  failsWith({ ...GOOD, run: [{ ...p, onward: onPart(wire([OTHER], [transfer(OTHER, TO, PART)])) }] }, "(onward): not W's own send, W its one signer and fee payer");
});

// card live-check-devnet-pair: read() on the devnet list, the second provider answering 503 (OnFinality on GitHub's
// runners, sign live run 42201131294): the transactions are read on the next operator, the helper's route: PASS; with
// no other operator answering, fewer than two reads: FAIL.
test("card live-check-devnet-pair: the second provider answering 503 moves read() to the next operator: PASS; one operator answering: FAIL", async () => {
  const { createHash } = await import("node:crypto");
  const { read } = await import("./signpage-pool-withdraw-form.mjs");
  const g = ANSWERS.good;
  const js = "app";
  const index = `<script src="/app.js" integrity="sha384-${createHash("sha384").update(js).digest("base64")}"></script>`;
  const txs = new Map(g.run.flatMap((p) => [p.release, p.onward]).map((t) => [t.signature, t.reads[0]]));
  const [solana, second, helper] = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public", "https://ct-api.unrealized.trade/v1/rpc/solana-devnet"];
  const fetchFn = async (url, init) => {
    if (url.startsWith("https://sign.")) return { text: async () => (url.endsWith("/app.js") ? js : index) };
    if (url === second) return { ok: false, status: 503, json: async () => null };
    const { id, params } = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id, result: txs.get(params[0]) ?? null }) };
  };
  const run = g.run.map((p) => ({ part: p.part, release: p.release.signature, onward: p.onward.signature }));
  const a = await read(run, fetchFn, [solana, second, helper], async () => {});
  assert.deepEqual(a.run[0].release.on, [solana, helper]);
  const v = judge(a);
  assert.equal(v.ok, true, v.lines.join("\n"));
  const one = judge(await read(run, fetchFn, [solana, second], async () => {}));
  assert.equal(one.ok, false);
  assert.ok(one.lines.some((l) => l.endsWith("(release): not on both RPCs at finalized")), one.lines.join("\n"));
});
