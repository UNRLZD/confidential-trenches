// node packages/wallet/scripts/pool-evm-restore-mutants.mjs (card notes-restore-evm): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const S = `${W}/src/pool/evm.ts`, R = `${W}/src/pool/evm-restore.ts`;
const T = "test/pool-evm-restore.test.ts", TE = "test/pool-evm.test.ts";
// [file, find, replace, test file, test name pattern]
const M = [
  // the restore's checks on the pool's events
  [R, "if (leaves.has(e.state)) throw", "if (false) throw", T, "evmRestore refuses"],
  [R, "if (byPre.has(e.precommitment!)) throw", "if (false) throw", T, "evmRestore refuses"],
  [R, "if (byNull.has(e.nullifier!)) throw", "if (false) throw", T, "evmRestore refuses"],
  [R, "if (e.label !== vaultLabelOf(keccak_256, scope, d.nonce)) throw", "if (false) throw", T, "evmRestore refuses"],
  [R, "if (e.value === 0n || noteCommitment(e.value, e.label, P) !== e.state) throw", "if (false) throw", T, "a correct pool cannot make is refused"],
  [R, "if (BigInt(at) <= note.leaf.leafIndex) throw", "if (false) throw", T, "evmRestore refuses"],
  [R, "if (e.value === 0n || e.value > note.leaf.value) throw", "if (false) throw", T, "a correct pool cannot make is refused"],
  // a release paid elsewhere (F2): never a refusal, listed, a foreign address never a W, the change kept only when it is ours
  [R, "    const ours = e.recipient === w.address.toLowerCase();\n", "    const ours = e.recipient === w.address.toLowerCase();\n    if (!ours) throw new Error(\"paid elsewhere\");\n", T, "released elsewhere"],
  [R, "    const changeOurs = cCommitment === e.state;\n", "    const changeOurs = cCommitment === e.state;\n    if (!changeOurs) throw new Error(\"not our change\");\n", T, "released elsewhere"],
  [R, "    if (!ours || !changeOurs) elsewhere.push(", "    if (false) elsewhere.push(", T, "released elsewhere"],
  [R, "    if (ours) spends.push(", "    if (true) spends.push(", T, "released elsewhere"],
  [R, "    if (changeOurs) put(cref,", "    if (true) put(cref,", T, "released elsewhere"],
  [R, "    w.secretKey.fill(0);\n", "", "test/pool-zeroing.test.ts", "evmRestore zeroes"],
  // the walk and the follow
  [R, "(P) => byPre.has(P)", "() => false", T, "restore of a seeded chain"],
  [R, "const j = jOf(ref);", "const j = 0;", T, "restore of a seeded chain"],
  [R, "const cValue = note.leaf.value - e.value;", "const cValue = 0n;", T, "restore of a seeded chain"],
  [R, "    if (ref.kind === \"deposit\") seconds({ id: \"U\", s: ref.s, i: ref.i });\n", "", T, "restore of a seeded chain"],
  [R, "    asDeposit({ kind: \"move\", l, j });\n", "", T, "restore of a seeded chain"],
  [R, "    seconds({ id: \"V\", l, j });\n", "", T, "restore of a seeded chain"],
  [R, "    seconds({ id: \"A\", l, j });\n", "", T, "restore of a seeded chain"],
  [R, "      asDeposit({ kind: \"return\", c, l, j });\n", "", T, "restore of a seeded chain"],
  [R, "      seconds({ id: \"R\", c, l, j });\n", "", T, "restore of a seeded chain"],
  // W's tokens, the order, the lag
  [R, "wallets[k]!.tokens = s.token === null || tokens.includes(s.token) ? tokens : [...tokens, s.token].sort();", "wallets[k]!.tokens = tokens;", T, "outside any list"],
  [R, "    [order[i], order[x]] = [order[x]!, order[i]!];\n", "", T, "no read names a note"],
  // one lag budget (F6), the head within an epoch (F3), each W on its own (F4), the Transfer pair checked (F5, F7)
  [R, "sync.events(a.signal, true)", "sync.events(a.signal)", T, "a lagging pool RPC"],
  [S, "return serial(() => (once === true ? one() : evmRetryLag(one, sleep, signal)));", "return serial(() => evmRetryLag(one, sleep, signal));", T, "a lagging pool RPC"],
  [R, "if (r.anchor.timestamp * 1000n + EVM_EPOCH_MS < high) throw", "if (false) throw", T, "more than an epoch"],
  [R, "if (r.anchor.timestamp * 1000n + EVM_EPOCH_MS < high) throw", "if (r.anchor.timestamp * 1000n + 3n * EVM_EPOCH_MS < high) throw", T, "more than an epoch"],
  [R, "    } catch (e) {\n      a.signal?.throwIfAborted();\n      await poolHolds();\n      wallets[k]!.error", "    } catch (e) {\n      throw e;\n      wallets[k]!.error", T, "spam"],
  [R, "      await evmRetryLag(reads.holds, sleep, a.signal);", "      if (false) await evmRetryLag(reads.holds, sleep, a.signal);", T, "another chain, or one that never holds"],
  // only the pool pair refuses (N1); a provider's words cut to their code (N2)
  [R, "      a.signal?.throwIfAborted();\n      await poolHolds();\n      pairError = `${reads.name}: ${cutError(e)}`;", "      throw e;", T, "another chain, or one that never holds"],
  [R, "    if (pairError !== null) {\n      wallets[k]!.error = pairError;\n      continue;\n    }\n", "", T, "another chain, or one that never holds"],
  [R, "  if (code !== undefined) return `rpc error ${code}`;\n", "", T, "cut to their code"],
  // none of a provider's text the kit's client composes, and a reorg under the restore is the pool pair's lag (fold 4)
  [R, "  if (http !== undefined) return `http ${http}`;\n", "", T, "K6 an HTTP status"],
  [R, "e instanceof SyntaxError || /RPC error|answer id/.test(m)", "/RPC error|answer id/.test(m)", T, "K4 a 200 body"],
  [R, "e instanceof SyntaxError || /RPC error|answer id/.test(m)", "e instanceof SyntaxError || /answer id/.test(m)", T, "K1 no code|K2 a string code|K5 a head lag"],
  [R, "e instanceof SyntaxError || /RPC error|answer id/.test(m)", "e instanceof SyntaxError || /RPC error/.test(m)", T, "K3 an id"],
  [R, "pairError = `${reads.name}: ${cutError(e)}`;", "pairError = `${reads.name}: ${String(e)}`;", T, "a Transfer pair's failed check"],
  [R, "      a.signal?.throwIfAborted();\n      await poolHolds();\n      pairError", "      a.signal?.throwIfAborted();\n      pairError", T, "reorgs between the pool read"],
  [R, "      a.signal?.throwIfAborted();\n      await poolHolds();\n      wallets[k]!.error", "      a.signal?.throwIfAborted();\n      wallets[k]!.error", T, "reorgs while a W's"],
  [R, "reads = { holds: () => evmHoldsAnchor(walletRpcs, chainId,", "reads = { holds: () => evmHoldsAnchor(rpcs, chainId,", T, "another chain, or one that never holds"],
  [S, "if (ids[0] !== chainId || ids[1] !== chainId) throw new Error(`rpcs: chain ${ids[0]} and ${ids[1]}, not ${chainId}`);\n  const bs", "const bs", T, "another chain, or one that never holds"],
  [S, "if (bs.some((b) => b === null || b.hash !== anchor.hash)) lag(", "if (false) lag(", T, "another chain, or one that never holds"],
  [R, "a.walletRpcs.filter((w) => !a.rpcs.some((p) => solanaSameProvider(w, p)))", "a.walletRpcs", T, "their own list"],
  [R, "reads.tokens(s.w, s.block)", "reads.tokens(s.w, 0n)", T, "restore of a seeded chain"],
  // a Base or Robinhood W on the helper's route only (decision M359, card evm-transfer-rpc-spares)
  [R, "    if (a.walletRpcs !== undefined) throw new Error(`walletRpcs: a ${net} W is read on the helper's route only`);\n", "", T, "^M1 "],
  [R, "const reader = evmHelperRpc(a.helper, net);", "const reader = a.rpcs[0]!;", T, "^M1 "],
  [S, "if (b === null || b.hash !== anchor.hash) lag(`the reader does not hold", "if (false) lag(`the reader does not hold", T, "^M3 "],
  // the pool's event fields and the Transfer read (./evm.ts)
  [S, "value: dep ? w(2) : w(1),", "value: w(2),", T, "restore of a seeded chain"],
  [S, "token: t0 === TOPIC_BOUGHT ? addrWord(w(5), \"the token\") : null,", "token: t0 === TOPIC_BOUGHT ? addrWord(w(6), \"the token\") : null,", T, "restore of a seeded chain"],
  [S, "if (v >> 160n !== 0n) throw new Error(`${what}: ${name} is not an address`);", "", T, "a lying pool RPC"],
  [S, "if (topics[2] !== `0x${w.slice(2).padStart(64, \"0\")}`) throw", "if (false) throw", T, "a lying Transfer RPC"],
  [S, "if (topics[0] !== EVM_TRANSFER_TOPIC) throw", "if (false) throw", T, "a lying Transfer RPC"],
  [S, "(l.topics.length !== 3 && l.topics.length !== 4)", "(l.topics.length !== 3)", T, "restore of a seeded chain"],
  [S, "await evmAgreedLogs(rpcs, { topics: [EVM_TRANSFER_TOPIC, null, `0x${to.slice(2).padStart(64, \"0\")}`] }", "await evmAgreedLogs(rpcs, { topics: [EVM_TRANSFER_TOPIC, null, null] }", T, "restore of a seeded chain"],
  // the one pager and the one two-RPC compare, now shared by the pool's events and W's Transfers
  // any refusal of a page over one block halves it, in whatever words: dRPC's (HTTP 400 through the kit's client), a
  // results cap, and the caps read live 5 Nov in words never read before (card wallet-restore-transfer-rpcs)
  [S, "      if (end > at) {\n        again = 0;", "      if (false) {\n        again = 0;", T, "paging past|^D1 |^R1 |^R2 "],
  // a throttle is no cap: the same page again, bounded (the review of card wallet-restore-transfer-rpcs, MEDIUM); a
  // -32005 naming a cap halves; the read the other RPC stopped never shrinks this one's page (LOW)
  [S, "      if (t !== null && (t.kind === \"throttle\" || end === at || !slowHalves)) {", "      if (false) {", T, "^T1 |^T2 "],
  // no answer in time halves a page over one block (Pocket's under the device's 3.5 s client)
  [S, "      if (t !== null && (t.kind === \"throttle\" || end === at || !slowHalves)) {", "      if (t !== null) {", T, "^T4 "],
  [S, "      if (t === null) throw e;\n      const ms = throttleWaitMs(n, t.afterMs);", "      throw e;\n      const ms = throttleWaitMs(n, t.afterMs);", T, "^T6 "],
  // card evm-pool-reads-throttle: a pool read is tried again within its bound, and its failure is never tried again around it
  [S, "evmAnswered(f, signal, sleep, { tries: EVM_POOL_READ_TRIES, waitMs: EVM_POOL_READ_WAIT_MS, what })", "f()", TE, "a 429 with no Retry-After"],
  [S, "|| waited + BigInt(ms) > bound.waitMs)", ")", TE, "Retry-After is waited when it fits"],
  [S, "  if (t?.name === \"EvmUnansweredError\") return null;\n", "", TE, "never tried again by a read around it"],
  [S, "(LIMIT_32005.test(m) && !CAP_WORDS.test(m))", "LIMIT_32005.test(m)", T, "^R1 "],
  [S, "(LIMIT_32005.test(m) && !CAP_WORDS.test(m))", "false", T, "^T1 |^T2 "],
  [S, "      // the other RPC failed and this read was stopped: never a smaller page for the next W\n      signal?.throwIfAborted();\n", "", T, "^T3 "],
  // a head lag is a lag before it is a smaller page
  [S, "      if (HEAD_LAG.test(m)) lag(`rpc ${k}: its logs", "      if (false) lag(`rpc ${k}: its logs", TE, "F3a "],
  [S, "if (at === short.length && long.slice(at).every((e) => e.block > fin.number)) lag(", "if (false) lag(", T, "a lagging Transfer RPC"],
  [S, "  if (at >= 0) {\n    const [short, long]", "  if (false) {\n    const [short, long]", T, "a lying Transfer RPC"],
  [S, "if (e.block === anchor.number && e.blockHash !== anchor.hash) await refuse(", "if (false) await refuse(", T, "a lying Transfer RPC"],
  [S, "for (const e of [...x, ...y]) {\n    if (e.block === fin.number && e.blockHash !== fin.hash) throw", "for (const e of [...x, ...y]) {\n    if (false) throw", TE, "not of the anchor's block"],
];
let ok = 0;
for (const [f, find, repl, file, pat] of M) {
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  const r = runSync("node", ["--test", `--test-name-pattern=${pat}`, file], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
  writeFileSync(f, src);
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${pat}] pass ${pass} fail ${fail}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
