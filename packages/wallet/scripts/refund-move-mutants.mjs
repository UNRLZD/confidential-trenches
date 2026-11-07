// node packages/wallet/scripts/refund-move-mutants.mjs (card wallet-refund-move): plants one broken money rule of the
// refund move at a time (the wallet's follow.ts and refund.ts, SIGN_HOST's deposit-follow.ts), runs the test that holds
// that rule, expects it to fail, and puts the source back. Each rule is wallet.md §2.4 point 8 and the §2.8 refund move
// row as the card's end state reads them, with the deposit-follow review's D1, finding 5 and r4.
// Then review wrm-58c238ab's M1, M2, L1 and L2 as folded, and its own plants no named test held; then the delta review
// of cf8a5524 (M1, L2, L4, L5 and its three pins); then the delta review of 8c046c2d (L1 to L4).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const P = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const FOLLOW = "wallet/src/deposit/follow.ts";
const REFUND = "wallet/src/deposit/refund.ts";
const HOST = "signpage/src/deposit-follow.ts";
const WT = ["wallet", "test/deposit-follow.test.ts"];
const WR = ["wallet", "test/deposit-refund.test.ts"];
const ST = ["signpage", "test/refund-move.test.ts"];
// [name, file, [[the source as written, the plant]...], [package, test file], test name pattern]
const M = [
  ["through only on a used nonce (a pruned nonce never through)", FOLLOW,
    [["} else if (at !== null && at.used === false && short && move.foreign !== true) {", "} else if (false) {"]], WT, "prunes"],
  ["through only once the balance drops (D1: a second refund holds it open)", FOLLOW,
    [["if (at !== null && at.used === true) {", "if (at !== null && at.used === true && short) {"]], WT, "D1: the move is through"],
  ["a new move before the old one's deadline", FOLLOW,
    [["at !== null && at.used === false && at.timeMs > move.deadline_ms", "at !== null && at.used === false"]], WT, "C4"],
  ["the move's state read at each RPC's own final (finding 5)", FOLLOW,
    [["args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))), block_id: at }), at);", "args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))), finality: \"final\" }));"]], WT, "finding 5"],
  ["the two RPCs' balances not compared", FOLLOW,
    [["a.timeNs !== b.timeNs || a.held !== b.held ||", "a.timeNs !== b.timeNs ||"]], WT, "readMoveAt"],
  ["no new move for what U holds after a move (D1)", FOLLOW,
    [["op.follow.status === \"REFUNDED\" && op.stage !== \"held\" && op.follow.final !== true", "op.follow.status === \"REFUNDED\" && op.stage !== \"held\" && op.follow.final !== true && !op.follow.moved"]], WT, "D1: the move is through"],
  ["final while a move is out", FOLLOW,
    [["if (deps.untilFinal && idle && !movable && !moveOut)", "if (deps.untilFinal && idle)"]], WT, "D1: the move is through"],
  ["a refund under MIN_DEPOSIT not held", FOLLOW,
    [["await write(id, \"held\", legFacts(op, \"held\"), { why: \"under_min\" });", "void [id, op];"]], WT, "under MIN_DEPOSIT waits"],
  ["dust under MIN_DEPOSIT asked about every round", FOLLOW,
    [["underMin.add(`${f.asset} ${f.at.held}`);", ""]], WT, "dust"],
  ["a lifted op not adopted (r4)", FOLLOW,
    [["if (op.stage === \"done\" && op.follow.final !== true) adopt(id);", "void [id, op, adopt];"]], WT, "r4"],
  ["the move recorded after it is sent", REFUND,
    [["  await deps.record(move);\n  // 4.", "  // 4."], ["  return { kind: \"sent\", move, status, code };", "  await deps.record(move);\n  return { kind: \"sent\", move, status, code };"]], WR, "the steps in order"],
  ["the intent's window past the rule's 120 s", REFUND,
    [["export const REFUND_INTENT_WINDOW_MS = 120_000;", "export const REFUND_INTENT_WINDOW_MS = 300_000;"]], ST, "a refund is moved"],
  ["SIGN_HOST's follow without the refund move", HOST,
    [["            refundMove: refundMover(f.network, { ...(h.fetch ? { fetch: h.fetch } : {}), ...(h.now ? { now: h.now } : {}) }),\n", ""]], ST, "passes the refund move"],
  ["SIGN_HOST asks a quote under MIN_DEPOSIT", HOST,
    [["    if (ask.reads[0].held < VAULT_CONSTANTS.MIN_DEPOSIT || ask.reads[1].held < VAULT_CONSTANTS.MIN_DEPOSIT) return { kind: \"under_min\" };\n", ""]], ST, "one under MIN_DEPOSIT"],
  ["SIGN_HOST reads a floor short of MIN_DEPOSIT as a refusal", HOST,
    [["            if (shortOnlyOfMinimum(e, request, answer, check)) throw new RefundMoveUnderMin();\n", ""]], ST, "short only of MIN_DEPOSIT"],
  ["SIGN_HOST quotes an asset it does not price", HOST,
    [["    if (!ONECLICK_USDC_ASSETS.includes(ask.asset)) return { kind: \"refused\", why: \"asset\" };\n", ""]], ST, "not USDC"],
  // review wrm-58c238ab: M1, M2, L1, L2
  ["M1: a NEAR USDC balance under MIN_DEPOSIT holds every open op", FOLLOW,
    [["if (op.follow.origin === f.asset) await write(id, \"held\", legFacts(op, \"held\"), { why: \"under_min\" });", "if (f.asset === usdcId || op.follow.origin === f.asset) await write(id, \"held\", legFacts(op, \"held\"), { why: \"under_min\" });"]], WT, "M1: "],
  ["M2: sender_struck not read: U's moves go on", FOLLOW,
    [["if (res.kind === \"sent\" && res.code === \"sender_struck\") {", "if (false) {"]], WT, "M2: sender_struck"],
  ["M2: a refused move asked again at once", FOLLOW,
    [["else if (res.kind === \"sent\" || (res.kind === \"refused\" && res.why === \"relay\")) backOff();", ""]], WT, "M2 and L5: a relayer with no route|M2 \\(delta\\)"],
  ["M2: 1 Hz reads on a move the relayer refused", FOLLOW,
    [["if (!relayDown) fast = true;", "fast = true;"]], WT, "M2 \\(delta\\)"],
  ["M2: a new quote and signature with no probe of the route", FOLLOW,
    [["probe: relayDown,", "probe: false,"]], WT, "M2 and L5: a relayer with no route"],
  ["M2: a REFUNDED status read every round", FOLLOW,
    [["if (op.follow.status === \"REFUNDED\") statusAt.set(id, now() + SLOW_MAX_MS);", ""]], WT, "M2: REFUNDED is read again"],
  ["M2: a listed code read on any status", REFUND,
    [[" && res.status >= 400 && res.status < 500) code", ") code"]], WR, "the relayer's answer"],
  ["M2: a route with no answer of its own still quoted and signed", REFUND,
    [["if (p.code === null) return { kind: \"refused\", why: \"relay\" };", ""]], WR, "after a refusal"],
  ["L1: one move's debit marks every op moved", FOLLOW,
    [["const its = asset === null || op.follow.origin === asset;", "const its = true;"]], WT, "L1: "],
  ["L2: a foreign debit in the move's window not remembered", FOLLOW,
    [["if (move.foreign !== true) await mark(null, { move: { ...move, foreign: true } });", ""]], WT, "L2: a withdraw.open from U while"],
  ["L2: an op whose money left U by another intent never ends", FOLLOW,
    [["await write(id, \"held\", legFacts(op, \"held\"), { why: \"moved_out\" });", "void [id, op];"]], WT, "takes it all"],
  // review wrm-58c238ab's own money-rule plants that no named test held (its sweep over whole files, 8 survivors)
  ["through when U's balance equals the move (debit not seen)", FOLLOW,
    [["at.held < BigInt(move.amount)", "at.held <= BigInt(move.amount)"]], WT, "a move past its window with its nonce unused"],
  ["the two RPCs' is_nonce_used not compared", FOLLOW,
    [["a.salt !== b.salt || a.used !== b.used)", "a.salt !== b.salt)"]], WT, "readMoveAt: is_nonce_used or the salt read apart"],
  ["the two RPCs' salts not compared", FOLLOW,
    [["a.salt !== b.salt || a.used", "a.used"]], WT, "readMoveAt: is_nonce_used or the salt read apart"],
  ["a block answer at another height accepted", FOLLOW,
    [["if (\"block_id\" in params && height !== params.block_id) return null;", ""]], WT, "readMoveAt: is_nonce_used or the salt read apart"],
  ["a view answer at another block accepted", FOLLOW,
    [["JSON.stringify(args))), block_id: at }), at);", "JSON.stringify(args))), block_id: at }));"]], WT, "readMoveAt: is_nonce_used or the salt read apart"],
  ["openKey signs without checking the seed's U", FOLLOW,
    [["if (k.id !== U) throw new DepositFollowRefused(\"the seed's U_{s,i} is not the op's U\");\n          return fn(k.secretKey);", "return fn(k.secretKey);"]], WT, "the refund move's key"],
  ["U's key not zeroed after the signature", FOLLOW,
    [["          k.secretKey.fill(0);\n        }\n      } finally {\n        seed.fill(0);", "          void 0;\n        }\n      } finally {\n        seed.fill(0);"]], WT, "the refund move's key"],
  ["the seed not zeroed after the signature", FOLLOW,
    [["          k.secretKey.fill(0);\n        }\n      } finally {\n        seed.fill(0);", "          k.secretKey.fill(0);\n        }\n      } finally {\n        void 0;"]], WT, "the refund move's key"],
  ["a record failure swallowed: the move sent unrecorded", REFUND,
    [["await deps.record(move);", "await deps.record(move).catch(() => {});"]], WR, "a record that fails"],
  // the delta review of cf8a5524
  ["M1 (delta): a held op's move never read: it keeps U followed for good", FOLLOW,
    [["if (op.stage !== \"held\" || m === undefined || !(await pastOnBoth(rpcs, m.deadline_ms))) continue;", "continue;"]], WT, "M1 \\(delta\\)|REVIEW R2"],
  ["L2 (delta): a read below the floor accepted", FOLLOW,
    [["if (r === null || r.height < floor) return null;", "if (r === null) return null;"]], WT, "L2 \\(delta\\)"],
  ["L2 (delta): the move's own block not kept as a floor", FOLLOW,
    [["Math.max(op.follow.move?.height ?? 0, op.follow.prior_height ?? 0)", "(op.follow.prior_height ?? 0)"]], WT, "L2 \\(delta\\), after a reload"],
  ["L2 (delta): the block that found a move over not kept", FOLLOW,
    [["prior_ms: move.deadline_ms, prior_height: at.height }", "prior_ms: move.deadline_ms }"]], WT, "L2 \\(delta\\), after a reload"],
  ["L2 (delta): the move recorded without its block", REFUND,
    [["amount: r.amountIn.toString(), height: ask.height };", "amount: r.amountIn.toString() } as MoveRecord;"]], WR, "the steps in order"],
  ["L4 (delta): sender_struck holds every op of U", FOLLOW,
    [["              for (const [id] of open) {\n                const op = (await ops.get(\"ops\", id)) as DepositOp;\n                if (!ENDS.has(op.stage)) await write(id, \"held\", legFacts(op, \"held\"), { why: \"sender_struck\" });\n              }", "              await holdAll(\"sender_struck\");"]], WT, "L4 \\(delta\\)"],
  ["L5 (delta): a session's first move sent with no probe", FOLLOW,
    [["let relayDown = true;", "let relayDown = false;"]], WT, "L5 and pin \\(delta\\)"],
  ["pin (delta): a 2xx leaves the route asked first", FOLLOW,
    [["              relayDown = false;\n              moveWait = 0;", "              moveWait = 0;"]], WT, "L5 and pin \\(delta\\)"],
  ["pin (delta): moves signed for U after sender_struck", FOLLOW,
    [["deps.refundMove !== undefined && !struck;", "deps.refundMove !== undefined;"]], WT, "pin \\(delta\\): after sender_struck"],
  ["pin (delta): the relayer's answer read past 1024 B", REFUND,
    [["export const INTENTS_ANSWER_MAX_BYTES = 1_024;", "export const INTENTS_ANSWER_MAX_BYTES = 1_025;"]], WR, "pin \\(delta\\)"],
  ["pin (delta): the relayer's answer cut short of 1024 B", REFUND,
    [["export const INTENTS_ANSWER_MAX_BYTES = 1_024;", "export const INTENTS_ANSWER_MAX_BYTES = 1_023;"]], WR, "pin \\(delta\\)"],
  // the delta review of 8c046c2d (L1 to L4)
  ["L1: an op refunded after the strike is never held", FOLLOW,
    [["if (struck) for (const [id, op] of open) if (!ENDS.has(op.stage) && (holds.get(op.follow.origin) ?? 0n) > 0n) await write(id, \"held\", legFacts(op, \"held\"), { why: \"sender_struck\" });", ""]], WT, "REVIEW R1 \\(L1\\):"],
  ["L1: the strike not read back from the store after a reload", FOLLOW,
    [["if (all.some(([, op]) => op.follow.intents_struck === true)) struck = true;", ""]], WT, "REVIEW R1 \\(L1, after a reload\\)"],
  ["L2: the block that read a move through not kept", FOLLOW,
    [["// through on its own debit, read at a final block on both RPCs. Whatever U holds after it is moved by a new move\n            await mark(\"in_transit\", { move: undefined, prior_ms: undefined, prior_height: at.height }", "// through on its own debit, read at a final block on both RPCs. Whatever U holds after it is moved by a new move\n            await mark(\"in_transit\", { move: undefined, prior_ms: undefined, prior_height: undefined }"]], WT, "REVIEW R4"],
  ["L3: a held op's landed move cleared, its USDC never bound", FOLLOW,
    [["if (at.used || (at.held < BigInt(m.amount) && m.foreign !== true)) {", "if (false) {"]], WT, "REVIEW R2"],
  ["L3: a held op's move does not keep U followed (a done op final first)", FOLLOW,
    [["for (const [, op] of await opsOfU()) if (op.follow.move !== undefined) moveOut = true;", "for (const [, op] of await opsOfU()) if (op.follow.move !== undefined && op.stage !== \"held\") moveOut = true;"]], WT, "REVIEW R2"],
  ["L4 (P1): the session floor never raised", FOLLOW,
    [["readFloor = Math.max(readFloor, r.height);", "void readFloor;"]], WT, "REVIEW R3"],
];
let ok = 0;
for (const [name, file, edits, [pkg, test], pat] of M) {
  const path = `${P}/${file}`;
  const src = readFileSync(path, "utf8");
  let planted = src;
  for (const [from, to] of edits) {
    if (planted.split(from).length !== 2) {
      console.log(`NOT ONCE [${name}]: ${from.slice(0, 60)}`);
      process.exit(1);
    }
    planted = planted.replace(from, to);
  }
  writeFileSync(path, planted);
  // a run past 180 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", `--test-name-pattern=${pat}`, test], { cwd: `${P}/${pkg}`, encoding: "utf8", timeoutMs: 180_000 });
  } finally {
    writeFileSync(path, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
