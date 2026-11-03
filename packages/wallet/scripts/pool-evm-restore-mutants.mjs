// node packages/wallet/scripts/pool-evm-restore-mutants.mjs (card notes-restore-evm): plants one mutant at a time in the card's source, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  [R, "    } catch (e) {\n      a.signal?.throwIfAborted();\n      wallets[k]!.error", "    } catch (e) {\n      throw e;\n      wallets[k]!.error", T, "spam"],
  [R, "if (order.length > 0) await evmRetryLag(() => evmHoldsAnchor(", "if (false) await evmRetryLag(() => evmHoldsAnchor(", T, "another chain"],
  [S, "if (ids[0] !== chainId || ids[1] !== chainId) throw new Error(`rpcs: chain ${ids[0]} and ${ids[1]}, not ${chainId}`);\n  const bs", "const bs", T, "another chain"],
  [S, "if (bs.some((b) => b === null || b.hash !== anchor.hash)) lag(", "if (false) lag(", T, "another chain"],
  [R, "for (const w of a.walletRpcs) for (const p of a.rpcs) if (solanaSameProvider(w, p)) throw", "if (false) throw", T, "their own pair"],
  [R, "s.w, s.block, r, page", "s.w, 0n, r, page", T, "restore of a seeded chain"],
  // the pool's event fields and the Transfer read (./evm.ts)
  [S, "value: dep ? w(2) : w(1),", "value: w(2),", T, "restore of a seeded chain"],
  [S, "token: t0 === TOPIC_BOUGHT ? addrWord(w(5), \"the token\") : null,", "token: t0 === TOPIC_BOUGHT ? addrWord(w(6), \"the token\") : null,", T, "restore of a seeded chain"],
  [S, "if (v >> 160n !== 0n) throw new Error(`${what}: ${name} is not an address`);", "", T, "a lying pool RPC"],
  [S, "if (topics[2] !== `0x${w.slice(2).padStart(64, \"0\")}`) throw", "if (false) throw", T, "a lying Transfer RPC"],
  [S, "if (topics[0] !== EVM_TRANSFER_TOPIC) throw", "if (false) throw", T, "a lying Transfer RPC"],
  [S, "(topics.length !== 3 && topics.length !== 4)", "(topics.length !== 3)", T, "restore of a seeded chain"],
  [S, "{ topics: [EVM_TRANSFER_TOPIC, null, `0x${to.slice(2).padStart(64, \"0\")}`] }", "{ topics: [EVM_TRANSFER_TOPIC, null, null] }", T, "restore of a seeded chain"],
  // the one pager and the one two-RPC compare, now shared by the pool's events and W's Transfers
  [S, "if (RANGE_CAP.test(m) && end > at) {", "if (false) {", T, "paging past"],
  [S, "exceeds max(imum)? results [\\d,]+|", "", T, "paging past"],
  [S, "if (at === short.length && long.slice(at).every((e) => e.block > fin.number)) lag(", "if (false) lag(", T, "a lagging Transfer RPC"],
  [S, "  if (at >= 0) {\n    const [short, long]", "  if (false) {\n    const [short, long]", T, "a lying Transfer RPC"],
  [S, "if (e.block === anchor.number && e.blockHash !== anchor.hash) await refuse(", "if (false) await refuse(", T, "a lying Transfer RPC"],
  [S, "if (e.block === fin.number && e.blockHash !== fin.hash) throw", "if (false) throw", TE, "not of the anchor's block"],
];
let ok = 0;
for (const [f, find, repl, file, pat] of M) {
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  const r = spawnSync("node", ["--test", `--test-name-pattern=${pat}`, file], { cwd: W, encoding: "utf8", timeout: 120_000 });
  writeFileSync(f, src);
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${pat}] pass ${pass} fail ${fail}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
