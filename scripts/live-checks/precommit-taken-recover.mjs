#!/usr/bin/env node
// Live check of card precommit-taken-recover: a deposit whose precommitment a stranger took first is restored as the
// user's note at the value that deposit carried, and the rung lands on the next note. The run is
// precommit-taken-recover.run.json, written by packages/signpage/scripts/pool-deposit-taken-devnet.mjs (the signing
// page's runPoolDeposit, src/pool-deposit.ts, with a seed made in that run): a stranger's key S deposited MIN_DEPOSIT on
// the precommitment of U's pending send, which the pool then refused, and the flow went on.
// On the first two devnet operators that answer (RPCS below, the page's own pair first), at finalized:
//   - S's deposit: no error, signed and paid by S (not U), calling the pinned program;
//   - U's deposit of the ask's rung on the next note: no error, signed and paid by U;
//   - each of the two notes the run stored UNSPENT (the restored one and the next one): its precommitment's mark
//     ["pre", precommitment] is the program's, 17 bytes, tag 1, its value the note's value (the restored note's
//     MIN_DEPOSIT, the value S's deposit carried, never the rung U signed) and its nonce the note's label's; label page
//     entry nonce - 1 is keccak256(scope, nonce) mod p and state page entry at the note's leaf index is
//     Poseidon(value, label, precommitment), worked out here.
// And from the record itself: the answer filled with U's one tx, the restored note the deposit note on the taken
// precommitment, the next one U's second arrival 0 at the rung, with that tx as its send.
//   node scripts/live-checks/precommit-taken-recover.mjs [--precommitment <hex>] [--record <file>]
// --precommitment reads another precommitment in the restored note's place (the recorded bad answer: no such mark).
// PASS exit 0, FAIL exit 1, error exit 2.
// Runs: once, it re-reads one finished devnet run's finalized txs, marks and tree pages, which no host deploy can change; the page code it ran is held by pool-deposit.test.ts and the bundle by signpage-release
import "../net-window.mjs";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARK_TAG, PRE_MARK_LEN, DEVNET_PROVIDERS, account, answerOf, be32, hex, labelOf, onTwoOperators, operatorOf, operatorProblems, pageAddress, poolAddress, preMarkAddress, recorder, rpc, scopeOf } from "./pool-sol-deploy.mjs";
import { PIN } from "./signpage-pool-flow.mjs";
import { vaultCommitment } from "../../packages/kit/src/index.ts";

const KEY = "precommit-taken-recover";
/** The devnet list (pool-sol-deploy.mjs DEVNET_PROVIDERS), whose first two are the page's own testnet pair, which the run read on
 *  (packages/signpage/src/pool-testnet.ts TESTNET_RPCS.solana): the public devnet endpoint and the helper's keyed
 *  /v1/rpc/solana-devnet, another operator's; a provider that is out moves the read to the next (onTwoOperators). */
export const RPCS = DEVNET_PROVIDERS;
export const RUN = new URL("./precommit-taken-recover.run.json", import.meta.url);
/** The pool's smallest deposit, contracts/pool-solana/src/lib.rs:78: what the stranger sent. */
export const MIN_DEPOSIT = 1_000_000n;
/** The ask's rung (SOL_LADDER.min). */
export const RUNG = 10_000_000n;
const PAGE_HEADER = 16;
const PAGE_ENTRY = 72;
const PAGE_ENTRIES = 1024n;
const u64At = (d, o) => Buffer.from(d.subarray(o, o + 8)).readBigUInt64LE();

/** The run's two stored notes: the restored deposit note on the taken precommitment, and U's next note. */
export function notesOf(run) {
  const restored = run.notes.find((n) => n.ref?.kind === "deposit");
  const next = run.notes.find((n) => n.ref?.kind === "second" && n.ref.id?.id === "U" && n.ref.n === 0);
  return { restored, next };
}

/** The verdict for the run `run` (with `precommitment` in the restored note's place when given), read through `fetchFn`. */
export async function check({ run = JSON.parse(readFileSync(RUN, "utf8")), precommitment, fetchFn = fetch, rpcs = RPCS, sleep } = {}) {
  const lines = [];
  const say = (pass, text) => lines.push(`${pass ? "ok  " : "BAD "} ${text}`);
  const { restored, next } = notesOf(run);
  const pre = precommitment ?? restored?.precommitment;
  const tx = run.answer?.txs?.[0]?.hash;
  say(run.cluster === "devnet" && run.program === PIN.program && run.pool === PIN.pool, `the run is on the pinned devnet pool: ${run.cluster}, ${run.program}, ${run.pool}`);
  const problems = operatorProblems(rpcs, "devnet");
  say(problems.length === 0, `two devnet operators or more, in order: ${rpcs.join(", ")}${problems.length ? `: ${problems.join("; ")}` : ""}`);
  say(run.answer?.stage === "filled" && run.answer.txs?.length === 1 && typeof tx === "string", `the run's answer is filled with U's one tx: ${JSON.stringify(run.answer)}`);
  say(!!restored && restored.state === "UNSPENT" && restored.precommitment === run.taken?.precommitment && restored.leaf?.value === String(MIN_DEPOSIT),
    `the restored note is the deposit note on the taken precommitment, UNSPENT at MIN_DEPOSIT ${MIN_DEPOSIT}: ${restored ? `${restored.state} at ${restored.leaf?.value}` : "none"}`);
  say(!!next && next.state === "UNSPENT" && next.leaf?.value === String(RUNG) && next.sends?.includes(tx) && next.precommitment !== restored?.precommitment,
    `the rung landed on U's next note (second arrival 0), UNSPENT at ${RUNG}, on another precommitment, with U's tx as its send: ${next ? `${next.state} at ${next.leaf?.value}` : "none"}`);
  say(pre === restored?.precommitment, `the precommitment read is the restored note's: ${pre}`);
  say(run.S !== run.U, `the stranger S ${run.S} is not U ${run.U}`);
  const prog = run.program;
  const scope = scopeOf(prog, poolAddress(prog).address);
  const walk = await onTwoOperators(rpcs, (u) => operatorOf(u, "devnet"), fetchFn, async (url, say, fetchFn) => {
    const at = `on ${url}`;
    try {
      for (const [name, sig, payer] of [["the stranger's deposit", run.taken?.signature, run.S], ["U's deposit", tx, run.U]]) {
        const t = await rpc(fetchFn, url, "getTransaction", [sig, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], sleep);
        const keys = t?.transaction?.message?.accountKeys ?? [];
        say(!!t && t.meta?.err === null && keys[0] === payer && t.transaction.message.header?.numRequiredSignatures === 1 && keys.includes(prog),
          `${name} ${sig} is finalized with no error, signed and paid by ${payer}, calling ${prog} ${at}: ${t ? `err ${JSON.stringify(t.meta?.err)}, payer ${keys[0]}` : `not found (${answerOf(fetchFn, "getTransaction", sig)})`}`);
      }
      for (const [name, n, p] of [["restored", restored, pre], ["next", next, next?.precommitment]]) {
        if (!n?.leaf || typeof p !== "string") {
          say(false, `${name} note's mark ${at}: no note recorded`);
          continue;
        }
        const value = BigInt(n.leaf.value);
        const mark = preMarkAddress(prog, Buffer.from(p, "hex"));
        const mk = await account(fetchFn, url, mark.address, sleep);
        const mv = mk && mk.data.length === PRE_MARK_LEN ? [u64At(mk.data, 0), u64At(mk.data, 8), mk.data[16]] : null;
        const nonce = mv?.[1] ?? 0n;
        const label = labelOf(scope, nonce);
        say(!!mk && mk.owner === prog && !!mv && mv[0] === value && mv[2] === MARK_TAG && nonce > 0n && hex(label) === n.leaf.label,
          `${name} note's mark ${mark.address} reads value ${mv?.[0] ?? "?"} nonce ${mv?.[1] ?? "?"} tag ${mv?.[2] ?? "?"}: the note's value ${value} and label ${at}${mk ? "" : `: missing (${answerOf(fetchFn, "getAccountInfo", mark.address)})`}`);
        if (!mv) continue;
        const commitment = be32(vaultCommitment(value, BigInt(`0x${hex(label)}`), BigInt(`0x${p}`)));
        say(hex(commitment) === n.leaf.commitment, `${name} note's recorded commitment is Poseidon(value, label, precommitment) ${at}: ${n.leaf.commitment}`);
        for (const [tree, i, want, what] of [[1, nonce - 1n, label, "label"], [0, BigInt(n.leaf.leafIndex), commitment, "state"]]) {
          const pageNo = i / PAGE_ENTRIES;
          const slot = Number(i % PAGE_ENTRIES);
          const page = pageAddress(prog, tree, pageNo).address;
          const a = await account(fetchFn, url, page, sleep);
          const hdr = !!a && a.owner === prog && Buffer.from(a.data.subarray(0, 8)).toString() === "bfpage01" && a.data[8] === tree && (a.data.length - PAGE_HEADER) % PAGE_ENTRY === 0;
          const o = PAGE_HEADER + slot * PAGE_ENTRY;
          const leaf = hdr && a.data.length >= o + PAGE_ENTRY ? a.data.subarray(o, o + 32) : null;
          say(!!leaf && Buffer.from(leaf).equals(Buffer.from(want)),
            `${name} note's ${what} page ${pageNo} entry ${slot} holds ${what === "label" ? "keccak256(scope, nonce) mod p" : "the note's commitment"} ${hex(want)} ${at}: ${leaf ? hex(leaf) : a ? "no such entry" : `missing (${answerOf(fetchFn, "getAccountInfo", page)})`}`);
        }
      }
    } catch (e) {
      if (e?.transient) throw e;
      say(false, `read ${at}: ${String(e.message).split("\n")[0]}`);
    }
  });
  for (const [pass, text] of walk.lines) pass === null ? lines.push(`info ${text}`) : say(pass, text);
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
    const precommitment = opt("--precommitment") ?? notesOf(run).restored?.precommitment;
    const r = await check({ run, precommitment, fetchFn: opt("--record") ? rec.fetchFn : fetch });
    if (opt("--record")) writeFileSync(opt("--record"), `${JSON.stringify({ precommitment, rpcs: RPCS, at: new Date().toISOString(), answers: rec.answers })}\n`);
    for (const l of r.lines) console.log(l);
    console.log(`${r.ok ? "PASS" : "FAIL"} ${KEY}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
