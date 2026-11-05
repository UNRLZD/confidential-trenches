#!/usr/bin/env node
// Live check of card signpage-pool-notes: the signing page's pool.deposit landed a note on the devnet pool its testnet
// build pins, and SIGN_HOST (https://sign.confidential.unrealized.trade) still serves the mainnet build, which carries no
// testnet pin. Since card signpage-pool-mainnet that build carries the same deposit flow (it runs on the page's own
// network, and refuses every pool kind while mainnet pins no pool: signpage-pool-mainnet's check), so the flow's
// presence is recorded here and no longer judged. The run is signpage-pool-notes.run.json, written by
// packages/signpage/scripts/pool-deposit-devnet.mjs (runPoolDeposit, src/pool-deposit.ts, with a seed made in that run).
// On each of two devnet RPCs of two operators, at finalized:
//   - the run's deposit tx: no error, signed and paid by the run's one-time wallet U, calling the pinned program;
//   - the precommitment's mark ["pre", precommitment]: the program's, 17 bytes, the run's value and nonce, tag 1;
//   - label page entry nonce-1: keccak256(scope, nonce) mod p, worked out here;
//   - state page entry at the run's leaf index: the note's commitment, worked out here from the run's value, the label
//     and the precommitment (the kit's vaultCommitment), with a nonzero root; the run's recorded commitment must be it;
//   - U holds 0 lamports: the deposit spent all of it, rung and costs.
//   node scripts/live-checks/signpage-pool-notes.mjs [--precommitment <hex>] [--record <file>]
// --precommitment reads another precommitment in the run's place (the recorded bad answer). PASS exit 0, FAIL exit 1,
// error exit 2.
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RPCS, MARK_TAG, PRE_MARK_LEN, account, be32, hex, labelOf, pageAddress, poolAddress, preMarkAddress, recorder, rpc, scopeOf } from "./pool-sol-deploy.mjs";
import { PIN, SIGN, TESTNET_ONLY } from "./signpage-pool-flow.mjs";
import { vaultCommitment } from "../../packages/kit/src/index.ts";

const KEY = "signpage-pool-notes";
export const RUN = new URL("./signpage-pool-notes.run.json", import.meta.url);
/** What only the testnet build's deposit flow carries (src/pool-deposit.ts POOL_DEPOSIT_LOCK). */
export const DEPOSIT_FLOW = "ct-pool/deposit";
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024n;
const u64At = (d, o) => Buffer.from(d.subarray(o, o + 8)).readBigUInt64LE();

/** SIGN_HOST's /app.js: its status, which of signpage-pool-flow's TESTNET_ONLY it carries, and whether it carries the deposit flow. */
export async function readSignFlow(fetchFn = fetch) {
  const r = await fetchFn(`${SIGN}/app.js`);
  const text = await r.text();
  return { status: r.status, bytes: text.length, found: TESTNET_ONLY.filter((s) => text.includes(s)), flow: text.includes(DEPOSIT_FLOW) };
}

/** The verdict for the run `run` (with `precommitment` in its place when given), read through `fetchFn`, and SIGN_HOST's read `sign`. */
export async function check({ run = JSON.parse(readFileSync(RUN, "utf8")), precommitment = run.precommitment, fetchFn = fetch, rpcs = RPCS, sleep, sign } = {}) {
  const lines = [];
  const say = (pass, text) => lines.push(`${pass ? "ok  " : "BAD "} ${text}`);
  say(sign?.status === 200 && sign.bytes > 0 && Array.isArray(sign.found) && sign.found.length === 0,
    `SIGN_HOST's /app.js is the mainnet build, with no testnet pin or provider: ${sign ? `${sign.status}, ${sign.bytes} chars, carries [${sign.found.join(", ")}], deposit flow ${sign.flow}` : "not read"}`);
  say(run.cluster === "devnet" && run.program === PIN.program && run.pool === PIN.pool, `the run is on the pinned devnet pool: ${run.cluster}, ${run.program}, ${run.pool}`);
  say(precommitment === run.precommitment, `the precommitment read is the run's: ${precommitment}`);
  say(new Set(rpcs.slice(0, 2).map((u) => new URL(u).hostname)).size === 2, `two RPCs: ${rpcs.slice(0, 2).join(", ")}`);
  const prog = run.program;
  const scope = scopeOf(prog, poolAddress(prog).address);
  const value = BigInt(run.value);
  const nonce = BigInt(run.nonce);
  const leafIndex = BigInt(run.leafIndex);
  const label = labelOf(scope, nonce);
  const commitment = be32(vaultCommitment(value, BigInt(`0x${hex(label)}`), BigInt(`0x${precommitment}`)));
  say(hex(commitment) === run.commitment, `the run's recorded commitment is Poseidon(value, label, precommitment): ${run.commitment}`);
  const mark = preMarkAddress(prog, Buffer.from(precommitment, "hex"));
  for (const url of rpcs.slice(0, 2)) {
    const at = `on ${url}`;
    try {
      const tx = await rpc(fetchFn, url, "getTransaction", [run.signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], sleep);
      const keys = tx?.transaction?.message?.accountKeys ?? [];
      say(!!tx && tx.meta?.err === null && keys[0] === run.U && tx.transaction.message.header?.numRequiredSignatures === 1 && keys.includes(prog),
        `deposit ${run.signature} is finalized with no error, signed and paid by U ${run.U}, calling ${prog} ${at}: ${tx ? `err ${JSON.stringify(tx.meta?.err)}, payer ${keys[0]}` : "not found"}`);
      const mk = await account(fetchFn, url, mark.address, sleep);
      const mv = mk && mk.data.length === PRE_MARK_LEN ? [u64At(mk.data, 0), u64At(mk.data, 8), mk.data[16]] : null;
      say(!!mk && mk.owner === prog && !!mv && mv[0] === value && mv[1] === nonce && mv[2] === MARK_TAG,
        `mark ${mark.address} reads value ${mv?.[0] ?? "?"} nonce ${mv?.[1] ?? "?"} tag ${mv?.[2] ?? "?"}, the run's ${value} and ${nonce}, tag ${MARK_TAG} ${at}${mk ? "" : ": missing"}`);
      for (const [tree, i, want, name] of [[1, nonce - 1n, label, "label"], [0, leafIndex, commitment, "state"]]) {
        const pageNo = i / PAGE_ENTRIES;
        const slot = Number(i % PAGE_ENTRIES);
        const a = await account(fetchFn, url, pageAddress(prog, tree, pageNo).address, sleep);
        const hdr = !!a && a.owner === prog && Buffer.from(a.data.subarray(0, 8)).toString() === "bfpage01" && a.data[8] === tree && (a.data.length - PAGE_HEADER) % PAGE_ENTRY === 0;
        const o = PAGE_HEADER + slot * PAGE_ENTRY;
        const leaf = hdr && a.data.length >= o + PAGE_ENTRY ? a.data.subarray(o, o + 32) : null;
        say(!!leaf && Buffer.from(leaf).equals(Buffer.from(want)) && a.data.subarray(o + 32, o + 64).some((b) => b !== 0),
          `${name} page ${pageNo} entry ${slot} holds ${name === "label" ? "keccak256(scope, nonce) mod p" : "the note's commitment"} ${hex(want)} ${at}: ${leaf ? hex(leaf) : a ? "no such entry" : "missing"}`);
      }
      const b = (await rpc(fetchFn, url, "getBalance", [run.U, { commitment: "finalized" }], sleep))?.value;
      say(b === 0, `U ${run.U} holds 0 lamports ${at}: ${b}`);
    } catch (e) {
      say(false, `read ${at}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return { ok: !lines.some((l) => l.startsWith("BAD")), lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const run = JSON.parse(readFileSync(RUN, "utf8"));
    const rec = recorder();
    const sign = await readSignFlow();
    const precommitment = opt("--precommitment") ?? run.precommitment;
    const r = await check({ run, precommitment, fetchFn: opt("--record") ? rec.fetchFn : fetch, sign });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ precommitment, rpcs: RPCS, at: new Date().toISOString(), sign, answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
