#!/usr/bin/env node
// Live check of card signpage-pool-withdraw-form: the pool withdraw of the signing page's testnet flow landed on the
// devnet pool, one transaction a part, through the deployed helper's POST /v1/pool/solana/send, and SIGN_HOST serves
// the build index.html pins. It reads:
//   - SIGN_HOST (https://sign.confidential.unrealized.trade): the served /app.js is the one index.html pins (its sha384);
//   - each part's transaction of the run (scripts/live-checks/signpage-pool-withdraw-form.md), at finalized on both
//     devnet RPCs of two operators, read as base64 and decoded here:
//     - succeeded, the same bytes on both;
//     - two signers: the helper's devnet fee payer (the pin), then W;
//     - after the compute budget, exactly two instructions: a tag 2 release of the pinned program (W its 2nd account,
//       the release's recipient), then one System transfer from W to To;
//     - To's balance up by exactly the part, and W left with nothing.
// The pins, To and the run's parts are written out here, not read from the repo.
//   node scripts/live-checks/signpage-pool-withdraw-form.mjs [--tx <sig>:<part>] [--record <file>] [--answer <file>]
// --tx reads another transaction in the run's place (the recorded bad answer). PASS exit 0, FAIL exit 1, error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RPCS, rpc } from "./pool-sol-deploy.mjs";

const KEY = "signpage-pool-withdraw-form";
export const SIGN = "https://sign.confidential.unrealized.trade";
/** SOL_POOLS.devnet in the testnet build. */
export const PIN = Object.freeze({ program: "5V9iJECfs9q9zZTXvNco7oREqkZFvrtuKqKm74GgJWMZ", feePayer: "9T3RgAVTNgedZhjJyC1UmyisV61pFWoU24LQHnk5W2bb" });
/** The address typed for the run: our devnet wallet. */
export const TO = "3NSPoKXm5PNTLurbAcJiYRB6oEuK4dfrxJy26JvzMqKx";
export const SYSTEM = "11111111111111111111111111111111";
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** The run's parts (signpage-pool-withdraw-form.md): each signature and the lamports it sends To. Empty until the run
 *  lands on the deployed helper: the check fails until then. */
export const RUN = Object.freeze([]);

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b) => {
  let n = BigInt("0x" + (Buffer.from(b).toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
};

/** A wire transaction's message: its signer count, its static keys and each instruction (program, accounts, data). */
export function decode(b) {
  let o = 0;
  const compact = () => {
    let n = 0;
    for (let s = 0; ; s += 7) {
      const x = b[o++];
      n |= (x & 0x7f) << s;
      if (!(x & 0x80)) return n;
    }
  };
  const sigs = compact(); // read before adding: compact() moves o
  o += 64 * sigs;
  const v0 = (b[o] & 0x80) !== 0;
  if (v0) o++;
  const signers = b[o];
  o += 3;
  const keys = Array.from({ length: compact() }, () => b58(b.subarray(o, (o += 32))));
  o += 32;
  const ixs = Array.from({ length: compact() }, () => {
    const program = b[o++];
    const accounts = Array.from(b.subarray(o + 1, o + 1 + b[o])).map(Number);
    o += 1 + accounts.length;
    const n = compact();
    const data = b.subarray(o, (o += n));
    return { program, accounts, data };
  });
  const tables = v0 ? compact() : 0;
  return { sigs, signers, keys, ixs, tables };
}

const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;

/** The verdict on an answer { sign: { index, sha384 }, run: [{ signature, part, reads: [rpc0, rpc1] }] }. */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  const pin = /src="\/app\.js" integrity="([^"]+)"/.exec(a.sign?.index ?? "")?.[1];
  if (!pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (pin !== a.sign?.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  if (!Array.isArray(a.run) || a.run.length === 0) bad("no run of the withdraw recorded");
  for (const p of a.run ?? []) {
    const tag = `${String(p.signature).slice(0, 12)}…`;
    const [x, y] = p.reads ?? [];
    if (!x || !y) {
      bad(`${tag}: not on both RPCs at finalized`);
      continue;
    }
    if (x.transaction?.[0] !== y.transaction?.[0]) bad(`${tag}: the two RPCs give other bytes`);
    for (const t of [x, y]) if (t.meta?.err !== null) bad(`${tag}: did not succeed (${JSON.stringify(t.meta?.err)})`);
    let m;
    try {
      m = decode(Buffer.from(x.transaction[0], "base64"));
    } catch {
      bad(`${tag}: not a transaction`);
      continue;
    }
    if (m.signers !== 2 || m.keys[0] !== PIN.feePayer) bad(`${tag}: not paid by the pinned fee payer with W the second signer`);
    if (m.tables !== 0) bad(`${tag}: loads a lookup table`);
    const rest = m.ixs.filter((ix) => m.keys[ix.program] !== COMPUTE_BUDGET);
    const [rel, send] = rest;
    if (rest.length !== 2 || !rel || !send) {
      bad(`${tag}: not one release and one transfer after the compute budget`);
      continue;
    }
    if (m.keys[rel.program] !== PIN.program || rel.data[0] !== 2) bad(`${tag}: the first is not a tag 2 release of the pinned program`);
    if (m.keys[rel.accounts[1]] !== m.keys[1]) bad(`${tag}: the release's recipient is not W`);
    const v = send.data.length === 12 ? new DataView(send.data.buffer, send.data.byteOffset, 12) : null;
    if (m.keys[send.program] !== SYSTEM || !v || v.getUint32(0, true) !== 2 || send.accounts.length !== 2) bad(`${tag}: the last is not one System transfer`);
    else {
      if (send.accounts[0] !== 1 || m.keys[send.accounts[1]] !== TO) bad(`${tag}: the transfer is not from W to To`);
      if (String(v.getBigUint64(4, true)) !== String(p.part)) bad(`${tag}: the transfer is not the part ${p.part}`);
    }
    const at = m.keys.indexOf(TO);
    for (const t of [x, y]) {
      if (at < 0 || String(BigInt(t.meta.postBalances[at]) - BigInt(t.meta.preBalances[at])) !== String(p.part)) bad(`${tag}: To is not up by exactly the part`);
      if (t.meta.postBalances[1] !== 0) bad(`${tag}: W kept lamports`);
    }
  }
  if (!lines.length) lines.push(`OK SIGN_HOST serves its pinned /app.js; the withdraw's ${a.run.length} part(s) landed on both RPCs, each a tag 2 release to W and one transfer of the part from W to To`);
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

/** Reads SIGN_HOST and the run's transactions on both RPCs. */
export async function read(run = RUN, fetchFn = fetch) {
  const index = await (await fetchFn(`${SIGN}/`)).text();
  const js = await (await fetchFn(`${SIGN}/app.js`)).text();
  const parts = [];
  for (const p of run) {
    const reads = await Promise.all(RPCS.map((u) => rpc(fetchFn, u, "getTransaction", [p.signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }])));
    parts.push({ signature: p.signature, part: String(p.part), reads });
  }
  return { sign: { index, sha384: sha384(js) }, run: parts };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const tx = arg("--tx");
    const run = tx ? [{ signature: tx.split(":")[0], part: tx.split(":")[1] }] : RUN;
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(run);
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
