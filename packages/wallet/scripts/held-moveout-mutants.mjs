// node packages/wallet/scripts/held-moveout-mutants.mjs (card held-deposit-way-out, review of d791adda M3): plants one
// mutant at a time in the held deposit's way out (src/deposit/moveout.ts), runs its tests (test/deposit-moveout.test.ts
// and test/deposit-moveout-keys.test.ts), expects them to fail, puts the source back. The first 21 are the review's own
// sweep (12 of them killed at d791adda), each anchored on today's lines; the rest are this fold's rules (M1, M2, L1, L6).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const F = `${W}/src/deposit/moveout.ts`;
const TESTS = ["test/deposit-moveout.test.ts", "test/deposit-moveout-keys.test.ts"];
const SELF = "(async <T>(f: () => Promise<T>) => f())";
// [name, find, replace, (find, replace)...]
const M = [
  // the review's sweep
  ["M1 key list: no one-key check", "list.length !== 1 || ", ""],
  ["M1b key list: no own-key check", " || list[0].public_key !== own", ""],
  ["M2 no compare-and-set (overwrite a record another tab wrote)", 'isObj(o) && o.stage === "held" && o.follow.out === undefined ? { ...o, follow: { ...o.follow, out: record } }', "isObj(o) ? { ...o, follow: { ...o.follow, out: record } }"],
  ["M2b sent before it is written", '    await ops.update("ops", opId, (v) => {\n      const o = v as DepositOp | undefined;\n      return isObj(o) && o.stage === "held" && o.follow.out === undefined ? { ...o, follow: { ...o.follow, out: record } } : undefined;\n    });\n    const now = await heldOpOf(ops, opId);\n    if (now.follow.out === undefined) throw new MoveOutRefused("the move could not be written");\n    return { follow: now.follow.out, owner: opId };', "    return { follow: record, owner: opId };"],
  ["M2c the CAS loser sends its own bytes", "    return { follow: now.follow.out, owner: opId };", "    return { follow: record, owner: opId };"],
  ["M3 signed again on any state", '    if (st === "live") return follow(had, opId);', '    if (false) return follow(had, opId);'],
  ["M3b gone on any unknown", '  if (st !== "unknown") return "live";\n', '  if (st !== "unknown") return "live";\n  return { gone: "expired", usdc: null };\n'],
  ["M3c expired without the validity wait", ' && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired"', ') return { gone: "expired"'],
  ["M3d expired without the nonce test", "  if (r.nonce < BigInt(had.nonce) && BigInt(r.height)", "  if (BigInt(r.height)"],
  ["M3e a receipt Failure read as success", '    if (failed(res.status) || outs.some((o) => isObj(o) && isObj(o.outcome) && failed(o.outcome.status))) return "failed";\n', ""],
  ["M4 tx state on the first RPC only", '  return a === b ? a! : "split";', "  return a!;"],
  ["M4b reads compared on the first RPC only", "  if (!x || !y || x.blockHash !== y.blockHash || x.nonce !== y.nonce || x.free !== y.free || x.usdc !== y.usdc || x.registered !== y.registered || x.gasPrice !== y.gasPrice) return null;", "  if (!x) return null;"],
  ["M5 a typed account on resume signs anew to it", "  const had = op.follow.out;", "  const had = to === null ? op.follow.out : undefined;"],
  ["M5b another receiver, the payload rule's receiver test dropped", "args: { receiver_id: to, amount: amount.toString() }", 'args: { receiver_id: "bob.testnet", amount: amount.toString() }', " || last.args.receiver_id !== to", ""],
  ["M6 amount = U's whole USDC", "const calls = moveCalls(typed, read.usdc - 1n,", "const calls = moveCalls(typed, read.usdc,"],
  ["M6b whole USDC, the payload bound loosened too", "const calls = moveCalls(typed, read.usdc - 1n,", "const calls = moveCalls(typed, read.usdc,", "amount > usdc - 1n", "amount > usdc"],
  ["M7 U's key not zeroed", "          k.secretKey.fill(0);\n", ""],
  ["M8 no seed lock", "    const tx = await seedLock(async () => {", `    const tx = await ${SELF}(async () => {`],
  ["M9 the payload rule not called", "    checkMoveCalls(U, typed, token, calls, read.usdc, storageMin);\n", ""],
  ["M10 a NEAR refusal not answered gas", '        if (lack !== null) return { kind: "gas", need: lack, u: U };', ""],
  ["M11 the token allowed as the typed account", "to === u || to === token", "to === u"],
  // this fold
  ["N1 taken with no look SETTLE_BLOCKS back", "    const past = await keyNonceAt(U, r.height - SETTLE_BLOCKS, rpcs).catch(() => null);\n    if (past !== null && past >= BigInt(had.nonce)) return", "    return"],
  ["N2 a taken record never settled", "  if (r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {", "  if (false) {"],
  ["N3 a resume signs anew (L6)", '    if (to === null) return st.gone === "taken"', '    if (to === null && false) return st.gone === "taken"', "    await clear(opId, had);\n  }", "    await clear(opId, had);\n    to ??= had.to;\n  }"],
  ["N4 no lock of U", "  const signed = await uLock(async (): Promise<Signed> => {", `  const signed = await ${SELF}(async (): Promise<Signed> => {`],
  ["N5 another op's live record of U ignored", '      if ((await recordState(U, token, r, rpcs)) === "live") return { follow: r, owner: k };\n', ""],
  ["N6 no code hash read (M2)", "      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null; // the token's code is the pin (W:928)\n", ""],
  ["N7 the vault and intents.near allowed (L1)", "  if (to === net.vault || to === INTENTS) throw", "  if (false) throw"],
  ["N8 a gone record not kept as history", "out_past: [...(o.follow.out_past ?? []), r]", "out_past: o.follow.out_past"],
  ["N9 a split tx read counted as unknown on both", '  return a === b ? a! : "split";', '  return a === b ? a! : "unknown";'],
];
const src = readFileSync(F, "utf8");
let killed = 0;
for (const [name, ...pairs] of M) {
  let s = src;
  let bad = false;
  for (let k = 0; k < pairs.length; k += 2) {
    if (s.split(pairs[k]).length !== 2) {
      console.log(`NOT ONCE [${name}]: ${pairs[k]}`);
      bad = true;
      break;
    }
    s = s.replace(pairs[k], pairs[k + 1]);
  }
  if (bad) {
    process.exitCode = 1;
    continue;
  }
  writeFileSync(F, s);
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", ...TESTS], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
  } finally {
    writeFileSync(F, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const by = [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].slice(0, 70)).filter((v, i, a) => a.indexOf(v) === i);
  const dead = r.status !== 0 && Number(fail) > 0;
  if (dead) killed++;
  console.log(`${dead ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${by.length ? ` by: ${by.join(" | ")}` : ""}`);
}
console.log(`${killed}/${M.length} killed`);
console.log(readFileSync(F, "utf8") === src ? "source restored" : "SOURCE NOT RESTORED");
if (killed !== M.length) process.exitCode = 1;
