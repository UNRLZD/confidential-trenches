// node packages/wallet/scripts/refund-move-mutants.mjs (card wallet-refund-move): plants one broken money rule of the
// refund move at a time (the wallet's follow.ts and refund.ts, SIGN_HOST's deposit-follow.ts), runs the test that holds
// that rule, expects it to fail, and puts the source back. Each rule is wallet.md §2.4 point 8 and the §2.8 refund move
// row as the card's end state reads them, with the deposit-follow review's D1, finding 5 and r4.
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
    [["at !== null && (at.used === true || at.held < BigInt(move.amount))", "at !== null && at.used === true"]], WT, "prunes"],
  ["through only once the balance drops (D1: a second refund holds it open)", FOLLOW,
    [["at !== null && (at.used === true || at.held < BigInt(move.amount))", "at !== null && at.held < BigInt(move.amount)"]], WT, "D1: the move is through"],
  ["a new move before the old one's deadline", FOLLOW,
    [["at !== null && at.used === false && at.timeMs > move.deadline_ms", "at !== null && at.used === false"]], WT, "C4"],
  ["the move's state read at each RPC's own final (finding 5)", FOLLOW,
    [["args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))), block_id: at }), at);", "args_base64: base64.encode(new TextEncoder().encode(JSON.stringify(args))), finality: \"final\" }));"]], WT, "finding 5"],
  ["the two RPCs' balances not compared", FOLLOW,
    [["a.timeNs !== b.timeNs || a.held !== b.held ||", "a.timeNs !== b.timeNs ||"]], WT, "readMoveAt"],
  ["no new move for what U holds after a move (D1)", FOLLOW,
    [["op.follow.status === \"REFUNDED\" && op.stage !== \"held\" && op.follow.final !== true", "op.follow.status === \"REFUNDED\" && op.stage !== \"held\" && op.follow.final !== true && !op.follow.moved"]], WT, "D1: the move is through"],
  ["final while a move is out", FOLLOW,
    [["if (deps.untilFinal && idle && !movable && !(await opsOfU()).some(([, op]) => op.follow.move !== undefined))", "if (deps.untilFinal && idle)"]], WT, "D1: the move is through"],
  ["a refund under MIN_DEPOSIT not held", FOLLOW,
    [["await write(id, \"held\", legFacts(op, \"held\"), { why: \"under_min\" });", "void [id, op];"]], WT, "under MIN_DEPOSIT waits"],
  ["dust under MIN_DEPOSIT asked about every round", FOLLOW,
    [["underMin.add(`${f.asset} ${f.at.held}`);", ""]], WT, "dust"],
  ["a lifted op not adopted (r4)", FOLLOW,
    [["if (op.stage === \"done\" && op.follow.final !== true) adopt(id);", "void [id, op, adopt];"]], WT, "r4"],
  ["the move recorded after it is sent", REFUND,
    [["  await deps.record(move);\n  // 4.", "  // 4."], ["  return { kind: \"sent\", move, status };", "  await deps.record(move);\n  return { kind: \"sent\", move, status };"]], WR, "the steps in order"],
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
