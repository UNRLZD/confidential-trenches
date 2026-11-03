// node packages/wallet/scripts/pool-solana-review-mutants.mjs (card notes-per-pool-sol): the Opus review's 40 mutants of
// bd8dea0, find strings mapped to fold 3's code; each runs the whole pool-solana.test.ts (any failing test kills it).
import { readFileSync, writeFileSync } from "node:fs";
import { runMutant } from "./mutant-run.mjs";
import { fileURLToPath } from "node:url";
const W = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""); // packages/wallet
const S = `${W}/src/pool/solana.ts`, R = `${W}/src/pool/solana-restore.ts`, K = `${W}/../kit/src/trade/solana/pool-buy.ts`;
const M = [
  // decodePage shape refusals (the named gaps)
  ["D1", S, `if (!Array.isArray(a.data) || a.data[1] !== "base64" || typeof a.data[0] !== "string")`, `if (!Array.isArray(a.data) || typeof a.data[0] !== "string")`],
  ["D2", S, `if (d.length < PAGE_HEADER || (d.length - PAGE_HEADER) % PAGE_ENTRY !== 0)`, `if (d.length < PAGE_HEADER)`],
  ["D3", S, `if (d.length < PAGE_HEADER || (d.length - PAGE_HEADER) % PAGE_ENTRY !== 0)`, `if (false)`],
  ["D4", S, `if (n === 0 || n > SOL_PAGE_ENTRIES)`, `if (false)`],
  ["D5", S, `!same(d.subarray(0, 8), PAGE_DISC) || d[8] !== tree ||`, `!same(d.subarray(0, 8), PAGE_DISC) ||`],
  ["D6", S, `if (!same(d.subarray(0, 8), PAGE_DISC) || d[8]`, `if (d[8]`],
  // sync
  ["S1", S, ` || (y.length > n && y[n]!.t < beforeMs)) throw`, `) throw`],
  ["S2", S, `if ((x.length > n && x[n]!.t < beforeMs) || `, `if (`],
  ["S3", S, `const { ms } = await blockTime(rpc, r.slot);`, `const { ms } = await finalTime(rpc);`],
  ["S4", S, `slot = Math.min(slot, at);`, `slot = Math.max(slot === Number.MAX_SAFE_INTEGER ? 0 : slot, at);`],
  ["S5", S, `for (let i = Math.max(1, start); i < l.length; i++)`, `for (let i = start + 1; i < l.length; i++)`],
  ["S6", S, `if (next[tree]!.length > held[tree]!.length) held[tree] = next[tree]!;`, `held[tree] = next[tree]!;`],
  ["S7", S, `if (t.root !== cut[cut.length - 1]!.root)`, `if (tree === 0 && t.root !== cut[cut.length - 1]!.root)`],
  ["S8", S, `while (n < agreed.length && agreed[n]!.t < beforeMs) n++;`, `while (n < agreed.length && agreed[n]!.t <= beforeMs) n++;`],
  ["S9", S, `if (ms < beforeMs) throw`, `if (ms + 1000n < beforeMs) throw`],
  ["S10", S, `out.push({ leaf: beInt(e.subarray(0, 32)), root: beInt(e.subarray(32, 64)), t: t * 1000n, bytes: e.slice() });`, `out.push({ leaf: beInt(e.subarray(0, 32)), root: beInt(e.subarray(32, 64)), t: t * 1000n + 999n, bytes: e.slice() });`],
  // bind: the helper's answer
  ["B1", S, `if (f?.chain !== "solana" || f.program !== program ||`, `if (`],
  ["B2", S, `|| f.program !== program ||`, `||`],
  ["B3", S, `|| f.step !== SOL_FEE_STEP.toString())`, `)`],
  ["B4", S, `if (f.epoch_ms !== Number(SOL_EPOCH_MS) || `, `if (`],
  ["B5", S, `if (typeof f.fee !== "string" || f.fee !== fee.toString()) throw`, `if (false) throw`],
  ["B6", S, `if (wallet.address === pool || wallet.address === feePayer) throw`, `if (false) throw`],
  ["B7", S, `|| deadlineMs <= nowMs + SOL_SEND_MARGIN_MS)`, `)`],
  ["B8", S, `if (typeof epochStartMs !== "bigint" || epochStartMs % SOL_EPOCH_MS !== 0n) throw`, `if (false) throw`],
  ["B9", K, `if (rents[0]!.lamportsPerByte !== rents[1]!.lamportsPerByte || rents[0]!.factor !== rents[1]!.factor) throw`, `if (false) throw`],
  ["B10", S, `if (feePayer === pool) throw`, `if (false) throw`],
  ["B11", S, `if (solanaSameProvider(rpcs[0], rpcs[1])) throw`, `if (false) throw`],
  ["B12", S, `return { context: solanaContextOf(request, scope), feeCap: fee, request };`, `return { context: solanaContextOf({ ...request, feePayer: f.fee_payer }, scope), feeCap: fee, request };`, "equivalent: bind refuses an answer whose fee_payer is not feePayer (src/pool/solana.ts:483) before it builds the request, so both contexts are one"],
  // restore
  ["R1", R, `if (have !== undefined && have !== d) throw`, `if (false) throw`],
  ["R2", R, `if (keys.has(x.pubkey)) throw`, `if (false) throw`],
  ["R3", R, `x.account?.owner !== program || `, ``],
  ["R4", R, `a.stateLeaves.forEach((c, k) => {\n    if (leafAt.has(c)) throw`, `a.stateLeaves.forEach((c, k) => {\n    if (false) throw`],
  ["R5", R, `const j = ref.kind === "change" ? ref.j + 1 : 0;`, `const j = ref.kind === "change" ? ref.j : 0;`],
  ["R6", R, `    asDeposit({ kind: "move", l, j });\n`, ``],
  ["R7", R, `    seconds({ id: "V", l, j });\n    seconds({ id: "A", l, j });\n`, ``],
  ["R8", R, `      seconds({ id: "R", c, l, j });\n`, ``],
  ["R9", R, `if (bytes.length !== size) throw`, `if (false) throw`],
  ["R10", R, `getBigUint64(at, true)`, `getBigUint64(at, false)`],
  ["R11", R, `if (m.value === 0n || m.nonce === 0n || `, `if (`],
  ["R12", R, `if (withdrawn === 0n || withdrawn > leaf.value) throw`, `if (false) throw`],
];
let killed = 0;
const run = M.filter((m) => m[4] === undefined);
for (const [id, f, find, repl, equivalent] of M) {
  if (equivalent !== undefined) { console.log(`${id} EQUIVALENT: ${equivalent.replace(/^equivalent: /, "")}`); continue; }
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`${id} NOT ONCE: ${find.slice(0, 80)}`); continue; }
  writeFileSync(f, src.replace(find, repl));
  const r = runMutant(["test/pool-solana.test.ts"], { cwd: W, timeoutMs: 180_000 });
  writeFileSync(f, src);
  const names = [...r.stdout.matchAll(/^✖ (.+?) \(/gm)].map((m) => m[1].slice(0, 50));
  // HUNG: the whole file runs, so which test hangs is unknown; CANCELLED: only tests stopped at their own timeout, on two
  // runs: neither is counted as killed
  const k = r.verdict === "killed";
  if (k) killed++;
  console.log(`${id} ${r.verdict.toUpperCase()} fail=${r.fail} cancelled=${r.cancelled} runs=${r.runs} ${k ? names.join(" | ") : ""}`);
}
console.log(`${killed}/${run.length} killed (${M.length - run.length} equivalent)`);
if (killed !== run.length) process.exitCode = 1;
