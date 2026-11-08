// node packages/wallet/scripts/held-moveout-mutants.mjs (card held-deposit-way-out, review of d791adda M3): plants one
// mutant at a time in the held deposit's way out (src/deposit/moveout.ts), runs its tests (TESTS below), expects them
// to fail, puts the source back. The first 21 are the review's own sweep (12 of them killed at d791adda), each anchored
// on today's lines; the rest are the folds' rules (M1, M2, L1, L6; the delta review's D1, D3, D4; review 3's M1, L1).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const F = `${W}/src/deposit/moveout.ts`;
const TESTS = ["test/deposit-moveout.test.ts", "test/deposit-moveout-keys.test.ts", "test/deposit-moveout-taken.test.ts"];
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
  ["M3b gone on any unknown", '  if (sides.some((x) => x === "ok" || x === "failed")) return "live";\n', '  if (sides.some((x) => x === "ok" || x === "failed")) return "live";\n  return { gone: "expired", usdc: null };\n'],
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
  // the move built as the rule would seal it, the rule never called (card signers-own-bytes: the rule's call returns the sealed move)
  ["M9 the payload rule not called", "    const move = checkMoveCalls(U, typed, token, calls, read.usdc, storageMin);\n", "    const move = { signer: U, receiver: token, calls } as SealedMove;\n"],
  ["M10 a NEAR refusal not answered gas", '        if (lack !== null) return { kind: "gas", need: lack, u: U };', ""],
  ["M11 the token allowed as the typed account", "to === u || to === token", "to === u"],
  // this fold
  ["N1 taken with no look SETTLE_BLOCKS back", "    const past = await keyNonceAt(U, r.height - SETTLE_BLOCKS, rpcs).catch(() => null);\n    if (past !== null && past >= BigInt(had.nonce)) return", "    return"],
  ["N2 a taken record never settled", '  if (st === "absent" && r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {', "  if (false) {"],
  ["N3 a resume signs anew (L6)", '    if (to === null) return st.gone === "taken"', '    if (to === null && false) return st.gone === "taken"', "    await clear(opId, had);\n  }", "    await clear(opId, had);\n    to ??= had.to;\n  }"],
  ["N4 no lock of U", "  const signed = await uLock(async (): Promise<Signed> => {", `  const signed = await ${SELF}(async (): Promise<Signed> => {`],
  ["N5 another op's live record of U ignored", '      if ((await recordState(U, token, r, rpcs)) === "live") return { follow: r, owner: k };\n', ""],
  ["N6 no code hash read (M2)", "      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null; // the token's code is the pin (W:928)\n", ""],
  ["N7 the vault and intents.near allowed (L1)", "  if (to === net.vault || to === INTENTS) throw", "  if (false) throw"],
  ["N8 a gone record not kept as history", "out_past: [...(o.follow.out_past ?? []), r]", "out_past: o.follow.out_past"],
  // (N9, a split read counted as absent, is gone: after review 3's L1 only follow() reads readBoth, and there split,
  // absent and unknown are one case, read again)
  ["N9 a tx read on one RPC only (ok, or failed on one) no longer keeps the record live", '  if (sides.some((x) => x === "ok" || x === "failed")) return "live";', '  if (sides.every((x) => x === "ok" || x === "failed")) return "live";'],
  ["N10 a tx read that throws (a timeout, a 429) counted as absent (D1)", '  } catch {\n    return "unknown";', '  } catch {\n    return "absent";'],
  ["N11 taken without both RPCs answering UNKNOWN_TRANSACTION (D1)", '  if (st === "absent" && r.nonce >= BigInt(had.nonce)', '  if (r.nonce >= BigInt(had.nonce)'],
  ["N12 the look-back nonce from the first RPC only (D3, review X2)", "  return a === null || b === null || a !== b ? null : a;", "  return a;"],
  ["N13 a code hash read with no answer passes (D3, review X7)", "      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null;", "      if ((resultAt(code, at)?.code_hash ?? VAULT_TOKEN_CODE_HASH) !== VAULT_TOKEN_CODE_HASH) return null;"],
  ["N14 another op's gone record followed, never cleared (D4, review X10)", '      if ((await recordState(U, token, r, rpcs)) === "live") return { follow: r, owner: k };', "      return { follow: r, owner: k };"],
  ["N15 absent on one RPC and no answer on the other kept live before the expired test (review 3 L1)", '  if (sides.some((x) => x === "ok" || x === "failed")) return "live";', '  if (sides[0] !== sides[1]) return "live";'],
  ["N16 taken on one RPC's UNKNOWN_TRANSACTION (review 3 L1)", '  const st = sides.every((x) => x === "absent") ? "absent" : "unknown";', '  const st = sides.some((x) => x === "absent") ? "absent" : "unknown";'],
  ["N17 the tx read asked with wait_until FINAL (review 3 M1: never UNKNOWN_TRANSACTION on the release RPCs)", 'sender_account_id: u, wait_until: "NONE" });', 'sender_account_id: u, wait_until: "FINAL" });'],
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
