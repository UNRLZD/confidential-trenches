// node packages/wallet/scripts/held-moveout-mutants.mjs (card held-deposit-way-out, review of d791adda M3): plants one
// mutant at a time in the held deposit's way out (src/deposit/moveout.ts), runs its tests (TESTS below), expects them
// to fail, puts the source back. The first 21 are the review's own sweep (12 of them killed at d791adda), each anchored
// on today's lines; the rest are the folds' rules (M1, M2, L1, L6; the delta review's D1, D3, D4; review 3's M1, L1; card held-move-forgotten-tx's archival read, its delta reviews of c3e71713 and its delta review 4,
// and delta review 8's holdAll status read in src/deposit/follow.ts, run against test/deposit-follow.test.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const F = `${W}/src/deposit/moveout.ts`;
const TESTS = ["test/deposit-moveout.test.ts", "test/deposit-moveout-keys.test.ts", "test/deposit-moveout-taken.test.ts", "test/deposit-moveout-forgotten.test.ts"];
const SELF = "(async <T>(f: () => Promise<T>) => f())";
// [name, find, replace, (find, replace)...]
const M = [
  // the review's sweep
  ["M1 key list: no one-key check", "list.length !== 1 || ", ""],
  ["M1b key list: no own-key check", " || list[0].public_key !== own", ""],
  ["M2 no compare-and-set (overwrite a record another tab wrote)", "      if (!isObj(o) || o.stage !== \"held\" || o.follow.out !== undefined) return undefined;", "      if (!isObj(o)) return undefined;"],
  ["M2b sent before it is written", "    await ops.update(\"ops\", opId, (v) => {\n      const o = v as DepositOp | undefined;\n      // an op follow.ts", "    if (record) return { follow: record, owner: opId };\n    await ops.update(\"ops\", opId, (v) => {\n      const o = v as DepositOp | undefined;\n      // an op follow.ts"],
  ["M2c the CAS loser sends its own bytes", "    return now.follow.out.hash === record.hash ? { follow: record, owner: opId, fresh: true } : { follow: now.follow.out, owner: opId };", "    return { follow: record, owner: opId, fresh: true };"],
  ["M3 signed again on any state", "    if (st === \"live\") {\n      const f = await follow(had, opId);", "    if (false) {\n      const f = await follow(had, opId);"],
  ["M3b gone on any unknown", "  if (sides.every((x) => x === \"ok\")) return \"live\";\n", "  if (sides.every((x) => x === \"ok\")) return \"live\";\n  return { gone: \"expired\", usdc: null };\n"],
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
  ["M11 the token allowed as the typed account", "throw new MoveOutRefused(strings);\n  if (!IMPLICIT.test(u) || to === u || to === token)", "throw new MoveOutRefused(strings);\n  if (!IMPLICIT.test(u) || to === u)"],
  // this fold
  ["N1 taken with no look SETTLE_BLOCKS back", "    const past = await keyNonceAt(U, r.height - SETTLE_BLOCKS, rpcs).catch(() => null);\n    if (past !== null && past >= BigInt(had.nonce)) {", "    {"],
  ["N2 a settled record never settled", "  if (r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {", "  if (false) {"],
  ["N3 a resume signs anew (L6)", '    if (to === null && st.gone === "replaced") {', '    if (to === null && st.gone === "replaced" && false) {', '    if (to === null) return { kind: "failed", ...shownOf(had) };', '    if (to === null && false) return { kind: "failed", ...shownOf(had) };', "    await clear(opId, had);\n  }", "    await clear(opId, had);\n    to ??= had.to;\n  }"],
  ["N4 no lock of U", "  const signed = await uLock(async (): Promise<Signed> => {", `  const signed = await ${SELF}(async (): Promise<Signed> => {`],
  ["N5 another op's live record of U ignored", '      if (st === "live") return { follow: r, owner: k };\n', ""],
  ["N6 no code hash read (M2)", "      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null; // the token's code is the pin (W:928)\n", ""],
  ["N7 the vault and intents.near allowed (L1)", "  if (to === net.vault || to === INTENTS) throw new MoveOutRefused(\"the typed account is the vault or intents.near: nothing sent there is the user's\");\n  const last = calls.at(-1);", "  if (false) throw new MoveOutRefused(\"the typed account is the vault or intents.near: nothing sent there is the user's\");\n  const last = calls.at(-1);"],
  ["N8 a gone record not kept as history", "\n      return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };", "\n      return { ...o, follow: { ...rest, out_past: o.follow.out_past } };"],
  // (N9, a split read counted as absent, is gone: after review 3's L1 only follow() reads readBoth, and there split,
  // absent and unknown are one case, read again)
  ["N9 (review 5, item 2) expired at the record's own nonce: an included tx one side reads FINAL is re-signed (hostile reads)", "  if (r.nonce < BigInt(had.nonce) && BigInt(r.height)", "  if (r.nonce <= BigInt(had.nonce) && BigInt(r.height)"],
  ["N10 a tx read that throws (a timeout, a 429) counted as absent (D1)", '    return isObj(res.status) && Object.hasOwn(res.status, "SuccessValue") ? "ok" : "unknown";\n  } catch {\n    return "unknown";', '    return isObj(res.status) && Object.hasOwn(res.status, "SuccessValue") ? "ok" : "unknown";\n  } catch {\n    return "absent";'],
  ["N11 (delta review 2 M1) the split window kept live: one side's word keeps the record followed", "  if (sides.every((x) => x === \"ok\")) return \"live\";", "  if (sides.every((x) => x === \"ok\")) return \"live\";\n  if (sides.some((x) => x === \"ok\" || x === \"failed\")) return \"live\";"],
  ["N12 the look-back nonce from the first RPC only (D3, review X2)", "  return a === null || b === null || a !== b ? null : a;", "  return a;"],
  ["N13 a code hash read with no answer passes (D3, review X7)", "      if (resultAt(code, at)?.code_hash !== VAULT_TOKEN_CODE_HASH) return null;", "      if ((resultAt(code, at)?.code_hash ?? VAULT_TOKEN_CODE_HASH) !== VAULT_TOKEN_CODE_HASH) return null;"],
  ["N14 another op's gone record followed, never cleared (D4, review X10)", '      if (st === "live") return { follow: r, owner: k };', "      return { follow: r, owner: k };"],
  ["N15 (delta review 2 M1) settled only with both of the pair absent (a 429 keeps it followed)", "  if (r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {", "  if (sides.every((x) => x === \"absent\") && r.nonce >= BigInt(had.nonce) && r.height > SETTLE_BLOCKS) {"],
  ["N16 FINAL success on both no longer left to follow()", "  if (sides.every((x) => x === \"ok\")) return \"live\";\n", ""],
  ["N17 the tx read asked with wait_until FINAL (review 3 M1: never UNKNOWN_TRANSACTION on the release RPCs)", 'sender_account_id: u, wait_until: "NONE" });', 'sender_account_id: u, wait_until: "FINAL" });'],
  // card held-move-forgotten-tx: a taken record is read on the archival RPC before it is settled
  ["N18 the archival RPCs never read", "      const words = await Promise.all(archival.map((h) => archivedState(h, had, U)));", '      const words = ["unknown" as const];'],
  ["N18b only the first archival RPC read", "await Promise.all(archival.map((h) => archivedState(h, had, U)));", "await Promise.all(archival.slice(0, 1).map((h) => archivedState(h, had, U)));"],
  ["N18c (review X3) the first archival answer wins", '      const a = words.every((w) => w === words[0]) ? words[0]! : "unknown";', '      const a = words.find((w) => w !== "unknown") ?? "unknown";'],
  ["N18d the last archival answer wins", '      const a = words.every((w) => w === words[0]) ? words[0]! : "unknown";', "      const a = words[words.length - 1]!;"],
  ["N18e the archival UNKNOWN counted with no read of the record's block", '    return head && head.height === had.height && head.hash === want ? "absent" : "unknown";', '    return "absent";'],
  ["N18f the record's block read by height only", "head && head.height === had.height && head.hash === want ?", "head && head.height === had.height ?"],
  ["N18g the record's block read by hash only", "head && head.height === had.height && head.hash === want ?", "head && head.hash === want ?"],
  ["N18h the signed bytes' block hash read for any signer", "    if (str() !== u || b[o] !== 0) return null;", "    if (b[o] !== 0) return null;"],
  ["N18i the signed bytes' block hash read at the wrong offset", "    o += 1 + 32 + 8;", "    o += 1 + 32;"],
  ["N19 the archival FINAL success not a landed move", "      if (a === \"ok\" && now.usdc <= 1n) return \"landed\";", "      if (false) return \"landed\";"],
  ["N19b (review M1 c) a landed move settled whatever U holds", "      if (r.usdc > 1n) return { gone: \"replaced\", usdc: r.usdc };\n", "", "      if (a === \"ok\" && now.usdc <= 1n) return \"landed\";", "      if (a === \"ok\") return \"landed\";"],
  ["N19c (delta review 2) landed while U holds what it moved", "      if (r.usdc > 1n) return { gone: \"replaced\"", "      if (r.usdc > BigInt(had.amount)) return { gone: \"replaced\"", "now.usdc <= 1n) return \"landed\";", "now.usdc <= BigInt(had.amount)) return \"landed\";"],
  ["N20 the archival FINAL failure read as replaced", "      if (a === \"failed\" && now.usdc <= 1n) return { gone: \"failed\", usdc: now.usdc };", "      if (a === \"failed\" && now.usdc <= 1n) return { gone: \"replaced\", usdc: now.usdc };"],
  ["N21 no archival answer settles the record as replaced", "      if (a === \"absent\" || now.usdc > 1n) return { gone: \"replaced\", usdc: now.usdc };", "      if (a !== \"ok\" || now.usdc > 1n) return { gone: \"replaced\", usdc: now.usdc };"],
  ["N22 a replaced record on a resume shown failed", '    if (to === null && st.gone === "replaced") {', "    if (false) {"],
  ["N23 another op's landed record cleared as gone", "      if (st === \"landed\") await landed(k, r);\n      else await clear(k, r);", "      await clear(k, r);"],
  ["N24 an archival RPC of another network allowed", " || names.some((n) => !listed.includes(n)))) throw", ")) throw"],
  ["N25 a landed record not marked moved_out", "      await landed(opId, had);\n      return stored(had);", "      return stored(had);"],
  // the delta review of c3e71713: money in U is always movable (items 1, 2), the whole archival list (L4), the tap's
  // write (item 3), every op of U marked (item 8)
  ["N19d landed while U holds 2", "      if (r.usdc > 1n) return { gone: \"replaced\"", "      if (r.usdc > 2n) return { gone: \"replaced\"", "now.usdc <= 1n) return \"landed\";", "now.usdc <= 2n) return \"landed\";"],
  ["N21b (F1) U's money behind an unsettled record: no equal archival word keeps it live", "      if (r.usdc > 1n) return { gone: \"replaced\", usdc: r.usdc };\n", "", "      if (a === \"absent\" || now.usdc > 1n) return", "      if (a === \"absent\") return"],
  ["N21c FINAL success with more in U kept live", "      if (r.usdc > 1n) return { gone: \"replaced\", usdc: r.usdc };\n", "", "      if (a === \"absent\" || now.usdc > 1n) return", "      if (a === \"absent\" || (a !== \"ok\" && now.usdc > 1n)) return"],
  ["N24b a part of the archival list allowed", "(names.length !== listed.length || ", "("],
  ["N24c one archival host listed twice allowed", " || new Set(names).size !== names.length", ""],
  ["N26 follow(): landed whatever U holds", "        if (now.usdc > 1n) {", "        if (false) {"],
  ["N26b follow(): no equal read of U is moved", "        if (now === null) return { kind: \"unread\" };", "        if (now === null) {\n          await landed(owner, r);\n          return { kind: \"moved\", ...shown };\n        }"],
  ["N27 a moved_out resume ignores U", "    if (now === null || now.usdc <= 1n) return { kind: \"moved\", ...shownOf(had) };", "    return { kind: \"moved\", ...shownOf(had) };"],
  ["N27b a moved_out resume with no equal read of U is open", "    if (now === null || now.usdc <= 1n) return", "    if (now !== null && now.usdc <= 1n) return"],
  ["N28 (F2) the tap keeps why moved_out", "...(why === undefined || why === \"moved_out\" ? {} : { why })", "...(why === undefined ? {} : { why })"],
  ["N28b the tap drops every why", ", ...(why === undefined || why === \"moved_out\" ? {} : { why })", ""],
  ["N29 (item 8) only the record's owner marked", "for (const { k, marked, need } of walk) {", "for (const { k, marked, need } of walk.filter((w) => w.k === owner)) {"],
  ["N29b every held op marked, of any U", " && o.follow.u === U && o.follow.network === network && o.follow.intents_struck !== true;", " && o.follow.intents_struck !== true;"],
  // delta review 2 of c3e71713: the split window (M1), one tap signs (L5), item 8's scope, and the survivors it named
  ["N30 a FINAL failure with more in U read failed (never open)", "      if (r.usdc > 1n) return { gone: \"replaced\", usdc: r.usdc };\n", "", "      if (a === \"failed\" && now.usdc <= 1n) return", "      if (a === \"failed\") return"],
  ["N31 (L5) a tap whose own followed record is open signs nothing", "      return f.kind === \"open\" && to !== null && again ? moveOut(opId, to, deps, false, tap) : f;", "      return f;"],
  ["N31b (L5) a tap following another op's record that is open signs nothing", "  return f.kind === \"open\" && again && signed.fresh !== true ? moveOut(opId, typed, deps, false, tap) : f;", "  return f;"],
  ["N31c (L5) a tap's own new record open signs again (two signatures a tap)", " && again && signed.fresh !== true ?", " && again ?"],
  ["N32 item 8: an op whose money never reached U marked (no need read as none)", "if (need === null || sum + need > cap) continue;", "if (sum + (need ?? 0n) > cap) continue;"],
  ["N32b (review 3 F3, review 5 item 1) a refund move through counted as U's money again", ": flight || stale ? min : null;", ": flight || stale || o.follow.moved === true ? min : null;"],
  ["N33 (V13) an intents_struck op marked", "o.follow.network === network && o.follow.intents_struck !== true;", "o.follow.network === network;"],
  ["N34 (V14) a non-held op marked", "o.kind === \"deposit\" && o.stage === \"held\" && isObj(o.follow) && o.follow.u === U", "o.kind === \"deposit\" && isObj(o.follow) && o.follow.u === U"],
  ["N35 (V15) an op's own record overwritten", ": o.follow.out !== undefined && o.follow.out.hash !== r.hash) continue;", ": false) continue;", "if (!ofU(o) || (o.follow.out !== undefined && (o.follow.out.hash !== r.hash || o.follow.why === \"moved_out\"))) return undefined;", "if (!ofU(o)) return undefined;"],
  ["N36 (V19) follow() clears the tapping op, not the record's owner", "          await landed(owner, r);\n          await reopen(r);", "          await landed(opId, r);\n          await reopen(r);"],
  ["N37 (V3b) follow(): landed while U holds 2", "        if (now.usdc > 1n) {", "        if (now.usdc > 2n) {"],
  ["N37b (V2b) a moved op's resume: moved while U holds 2", "if (now === null || now.usdc <= 1n) return", "if (now === null || now.usdc <= 2n) return"],
  ["N38 (V10b) the tap drops why sender_struck too", "why === undefined || why === \"moved_out\" ? {} : { why }", "why === undefined || why === \"moved_out\" || why === \"sender_struck\" ? {} : { why }"],
  ["N38b (V10c) the tap drops why under_min too", "why === undefined || why === \"moved_out\" ? {} : { why }", "why === undefined || why === \"moved_out\" || why === \"under_min\" ? {} : { why }"],
  // delta review 3 of held-move-forgotten-tx
  ["R10 (GAP-R10) no equal read of U files the record", '  if (r === null) return "live";', '  if (r === null) return { gone: "replaced", usdc: null };'],
  ["R20 (GAP-R20) landed() marks the owner without its compare-and-set", "if (k === owner ? o.follow.out?.hash !== r.hash :", "if (k === owner ? false :", "if (!ofU(o) || (o.follow.out !== undefined && (o.follow.out.hash !== r.hash || o.follow.why === \"moved_out\"))) return undefined;", "if (!ofU(o) || (o.follow.out !== undefined && o.follow.why === \"moved_out\")) return undefined;"],
  ["P1 (F1) a running receipt read as unknown", '    if (isObj(res) && PENDING.has(res.final_execution_status) && isObj(res.transaction) && res.transaction.hash === hash && res.transaction.signer_id === u) return "pending";\n', ""],
  ["P1b (F1) a running answer for another tx counted", " && res.transaction.hash === hash && res.transaction.signer_id === u) return \"pending\";", ") return \"pending\";"],
  ["P1c (F1) a running answer of another signer counted", " && res.transaction.signer_id === u) return \"pending\";", ") return \"pending\";"],
  ["P1d (F1) INCLUDED not read as running", '["INCLUDED", "EXECUTED_OPTIMISTIC"', '["EXECUTED_OPTIMISTIC"'],
  ["P1e (F1) EXECUTED_OPTIMISTIC not read as running", '"INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL"', '"INCLUDED", "INCLUDED_FINAL"'],
  ["P1f (F1) INCLUDED_FINAL not read as running", '"EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED"', '"EXECUTED_OPTIMISTIC", "EXECUTED"'],
  ["P1g (F1) EXECUTED not read as running", '"INCLUDED_FINAL", "EXECUTED"]', '"INCLUDED_FINAL"]'],
  ["P2 (F1) a running receipt kept live only when both read it", '  if (sides.some((x) => x === "pending")) return "live";', '  if (sides.every((x) => x === "pending")) return "live";'],
  ["P3 (F1) a running receipt not kept live", '  if (sides.some((x) => x === "pending")) return "live";\n', ""],
  ["A1 (F4) the archival host asked once", "      if (ask >= ARCHIVAL_ASKS) throw", "      if (ask >= 1) throw"],
  ["A2 (F4) the host's Retry-After not waited", "Math.max(after ?? 0, 1_000 * 2 ** (ask - 1))", "1_000 * 2 ** (ask - 1)"],
  ["A3 (F4) the wait not capped", "await sleep(Math.min(ARCHIVAL_WAIT_MAX_MS, Math.max(after ?? 0, 1_000 * 2 ** (ask - 1))));", "await sleep(Math.max(after ?? 0, 1_000 * 2 ** (ask - 1)));"],
  ["A4 (F4) no doubling", "Math.max(after ?? 0, 1_000 * 2 ** (ask - 1))", "Math.max(after ?? 0, 1_000)"],
  ["A5 (F4) a JSON-RPC -429 taken as the answer", "          if (!(isObj(body) && isObj(body.error) && body.error.code === -429)) return body;", "          return body;"],
  ["A6 (F4) a 5xx not asked again", "res.status === 429 || res.status >= 500", "res.status === 429"],
  ["A7 (F4) a 429 not asked again", "res.status === 429 || res.status >= 500", "res.status >= 500"],
  ["A8 (F4) any HTTP answer asked again", "        else throw new Error(`HTTP ${res.status}`);", "        else why = `HTTP ${res.status}`;"],
  ["A9 (F4) a timeout asked again", '        if ((e as Error).name === "TimeoutError" || (e as Error).message.startsWith("HTTP ")) throw e;', '        if ((e as Error).message.startsWith("HTTP ")) throw e;'],
  ["A10 (F4) more asks than ARCHIVAL_ASKS", "export const ARCHIVAL_ASKS = 4;", "export const ARCHIVAL_ASKS = 5;"],
  ["A11 (F4) a longer wait cap", "export const ARCHIVAL_WAIT_MAX_MS = 10_000;", "export const ARCHIVAL_WAIT_MAX_MS = 30_000;"],
  // delta review 4: its sweep, less the plants already here (H2, H3, H6, H7, H8 and H12 are A6, A5, A9, A8, A4 and A10;
  // its P1, P1b, P2b, P3 and P4 are P1d, P1g, P1c, P3 and P2; its F3 is N32b; MAIN is packages/signpage's held-mutants.mjs
  // MM6), then its folds (R1 to R4)
  ["H1 (review 4) one ask only", "export const ARCHIVAL_ASKS = 4;", "export const ARCHIVAL_ASKS = 1;"],
  ["H4 (review 4) Retry-After ignored", '        after = retryAfterMs(res.headers.get("retry-after"), Date.now());\n', "\n"],
  ["H5 (review 4) no cap on the wait", "await sleep(Math.min(ARCHIVAL_WAIT_MAX_MS, Math.max(after ?? 0, 1_000 * 2 ** (ask - 1))));", "await sleep(Math.max(after ?? 0, 1_000 * 2 ** (ask - 1)));"],
  ["H9 (review 4) no connection not asked again", '        if ((e as Error).name === "TimeoutError" || (e as Error).message.startsWith("HTTP ")) throw e;', "        throw e;"],
  ["H10 (review 4) a Retry-After date unread", "  const t = Date.parse(h);\n  return Number.isFinite(t) ? Math.max(0, t - now) : null;", "  return null;"],
  ["H11 (review 4) the archival block read not asked again", 'tx: (params) => post("tx", params), block: (params) => post("block", params) };', 'tx: (params) => post("tx", params) };'],
  ["P1h (review 4) NONE counted running", 'new Set(["INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED"])', 'new Set(["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED"])'],
  ["P1i (review 4) running without the hash check only", "PENDING.has(res.final_execution_status) && isObj(res.transaction) && res.transaction.hash === hash && res.transaction.signer_id === u", "PENDING.has(res.final_execution_status) && isObj(res.transaction) && res.transaction.signer_id === u"],
  ["P5 (review 4) an archival host's running read counted as its word", '  if (st === "pending") return "unknown";\n', '  if (st === "pending") return "ok";\n'],
  ["F3c (review 5, item 1) a refund move read through SETTLE_BLOCKS before counted as U's money (R4-MOVED's rule)", ": flight || stale ? min : null;", ": flight || stale || (o.follow.moved === true && o.follow.prior_height !== undefined && r.height >= o.follow.prior_height + SETTLE_BLOCKS) ? min : null;"],
  ["F6a (review 6, F1) the owner marked whatever its need", "if (need === null || sum + need > cap) continue;", "if (k !== owner && (need === null || sum + need > cap)) continue;"],
  ["F6b (review 6, F2) no cap: every op 1Click names delivered marked", "if (need === null || sum + need > cap) continue;", "if (need === null) continue;"],
  ["F6c (review 6) the cap off by one: what U held, not the move's amount + 1", "const cap = BigInt(r.amount) + 1n;", "const cap = BigInt(r.amount) + 2n;"],
  ["F6d (review 6) an op held before SUCCESS walked before a delivered one", "const rank = marked ? 0 : told ? 1 : flight ? 2 : 3;", "const rank = marked ? 0 : told || flight ? 1 : 3;"],
  ["F6e (review 6) an op reopened with no record needs its min again", "const need = reopened || (k === owner", "const need = (k === owner"],
  ["F6f (review 6) a later record's owner needs its min again", " || (k === owner && r.later === true) ? 0n :", " ? 0n :"],
  ["F6g (review 6) a later record never written", "...(op.follow.why === \"moved_out\" ? { later: true as const } : {})", "...{}"],
  ["F6h (review 6) an unmarked owner keeps the landed record live", "if (!mine) await clear(owner, r);", ""],
  ["F6i (review 6) a delivered op's need its min only", "got > min ? got : min) :", "min) :"],
  ["F7a (review 7, item 1) a REFUNDED op counted at its min", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\");", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\" || o.follow.status === \"REFUNDED\");"],
  ["F7b (review 7, item 1) a FAILED op counted at its min", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\");", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\" || o.follow.status === \"FAILED\");"],
  ["F7c (review 7, item 1) an INCOMPLETE_DEPOSIT op counted at its min", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\");", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\" || o.follow.status === \"INCOMPLETE_DEPOSIT\");"],
  ["F7d (review 7, item 1) a quote never paid (PENDING_DEPOSIT, or no status) counted at its min", "const flight = o.follow.sent === true && (o.follow.status === \"KNOWN_DEPOSIT_TX\" || o.follow.status === \"PROCESSING\");", "const flight = o.follow.status !== \"REFUNDED\" && o.follow.status !== \"FAILED\" && o.follow.status !== \"INCOMPLETE_DEPOSIT\";"],
  ["F7e (review 7, item 1) an in-flight status counted with nothing sent", "const flight = o.follow.sent === true && (", "const flight = ("],
  ["F7f (review 7, item 2) ops this record already marked counted at 0", "        sum += need ?? 0n;\n", "        sum += 0n;\n"],
  ["F7g (review 7, item 2) an op this record already marked read as reopened", "const reopened = o.follow.why === \"moved_out\" && o.follow.out === undefined;", "const reopened = o.follow.why === \"moved_out\";"],
  ["F7h (review 7, item 3) the marking write never re-checks the walk's filter", "if (!ofU(o) || (o.follow.out !== undefined && (o.follow.out.hash !== r.hash || o.follow.why === \"moved_out\"))) return undefined;", "if (!isObj(o) || (o.follow.out !== undefined && (o.follow.out.hash !== r.hash || o.follow.why === \"moved_out\"))) return undefined;"],
  ["F7i (review 7, item 4) follow() answers moved with the owner left unmarked", "        await landed(owner, r);\n        return stored(r);", "        await landed(owner, r);\n        return { kind: \"moved\", ...shown };"],
  ["R1 (review 4, item 1) landed on U's first read, the one before the archival asks", '      if (a === "ok" && now.usdc <= 1n) return "landed";', '      if (a === "ok" && r.usdc <= 1n) return "landed";'],
  ["R2 (review 4, item 1) a failed second read of U falls back on the first", '      const now = await readMoveOut(U, had.to, token, rpcs).catch(() => null);\n      if (now === null) return "live";', "      const now = (await readMoveOut(U, had.to, token, rpcs).catch(() => null)) ?? r;"],
  ["R3 (review 4, item 2) the archival hosts asked with U holding more than 1", '      if (r.usdc > 1n) return { gone: "replaced", usdc: r.usdc };', '      if (r.usdc > 1n && archival.length === 0) return { gone: "replaced", usdc: r.usdc };'],
  // the merge of signers-own-bytes: the u64 cap at the signing, where the next nonce is formed (a nonce of 2^64 - 1 read back)
  ["U1 the tap signs past a nonce of 2^64 - 1", "    if (read === null || read.nonce >= U64_MAX) return { outcome: { kind: \"unread\" } };", "    if (read === null) return { outcome: { kind: \"unread\" } };"],
  ["U2 a nonce of 2^64 - 1 unread (a move landed at it never reads moved)", "  return n !== null && n <= U64_MAX ? n : null;", "  return n !== null && n < U64_MAX ? n : null;"],
  ["R4 (review 4, item 3) a running read before the expired test", '  if (r.nonce < BigInt(had.nonce) && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired", usdc: r.usdc };\n', '  if (sides.some((x) => x === "pending")) return "live";\n  if (r.nonce < BigInt(had.nonce) && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired", usdc: r.usdc };\n'],
  ["H1v (review 6, F4) expired at exactly base + V, where nearcore can still include the old bytes", ' && BigInt(r.height) > BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired"', ' && BigInt(r.height) >= BigInt(had.height) + TX_VALIDITY_BLOCKS) return { gone: "expired"'],
  // delta review 8 of 0f398416: the stale status fallback, landed then reopen, the page's answer for the tap
  ["R8a (review 8, ruling 1) an op held with status none or PENDING_DEPOSIT needs nothing", ": flight || stale ? min : null;", ": flight ? min : null;"],
  ["R8b (review 8, ruling 1) a stale op walked by age with the in-flight ones", "const rank = marked ? 0 : told ? 1 : flight ? 2 : 3;", "const rank = marked ? 0 : told ? 1 : flight || stale ? 2 : 3;"],
  ["R8c (review 8, ruling 1) a stale op walked before the delivered and in-flight ones", "const rank = marked ? 0 : told ? 1 : flight ? 2 : 3;", "const rank = marked ? 0 : stale ? 1 : told ? 2 : flight ? 3 : 4;"],
  ["R8d (review 8, ruling 1) a REFUNDED, FAILED or INCOMPLETE_DEPOSIT op taken as stale", "const stale = o.follow.status === undefined || o.follow.status === \"PENDING_DEPOSIT\";", "const stale = o.follow.status !== \"KNOWN_DEPOSIT_TX\" && o.follow.status !== \"PROCESSING\";"],
  ["R8e (review 8, ruling 2) a landed move read with money in U leaves its ops Moved (no reopen)", "          await landed(owner, r);\n          await reopen(r);", "          await landed(owner, r);"],
  ["R8f (review 8, ruling 2) a landed move read with money in U marks nothing before it reopens", "          await landed(owner, r);\n          await reopen(r);", "          await reopen(r);"],
  ["R8g (review 8, ruling 2) a reopened op loses its moved_out (its next tap carries no later)", "\n        return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };", "\n        return { ...o, follow: { ...rest, why: \"sender_struck\", out_past: [...(o.follow.out_past ?? []), r] } };"],
  ["R8h (review 8, ruling 2) a reopened op's record not kept as history", "\n        return { ...o, follow: { ...rest, out_past: [...(o.follow.out_past ?? []), r] } };", "\n        return { ...o, follow: { ...rest, out_past: o.follow.out_past } };"],
  ["R8i (review 8, ruling 3) the page answers for its own op only, by key order", "o.follow.out?.hash === r.hash) return { kind: \"moved\", ...shownOf(r) };", "o.follow.out?.hash === r.hash && k === opId) return { kind: \"moved\", ...shownOf(r) };"],
  ["R8j (review 8, ruling 3 and point 3 fold) a tap whose landed move carried money answers empty unless an op of U is marked", "    return BigInt(r.amount) + 1n >= VAULT_CONSTANTS.MIN_DEPOSIT ? { kind: \"moved\", ...shownOf(r) } : { kind: \"empty\" };", "    return { kind: \"empty\" };"],
  ["R8k (review 10, F1) a landed move of a stranger's dust (above 1, under MIN_DEPOSIT) answers moved", "    return BigInt(r.amount) + 1n >= VAULT_CONSTANTS.MIN_DEPOSIT ? { kind: \"moved\"", "    return BigInt(r.amount) > 1n ? { kind: \"moved\""],
  ["F7j (review 7, item 4; review 10, F3) a landed record's resume answers moved with the owner left unmarked", "      await landed(opId, had);\n      return stored(had);", "      await landed(opId, had);\n      return { kind: \"moved\", ...shownOf(had) };"],
  ["R9a (review 9, ruling 1) the tap signs with no status read again", "    await reread();\n    // another op of U with a live record", "    // another op of U with a live record"],
  ["R10a (review 10, F2) the tap's re-reads one after another", "    const reads = await Promise.all(stale.map(read1));", "    const reads: Awaited<ReturnType<typeof read1>>[] = [];\n    for (const x of stale) reads.push(await read1(x));"],
  ["R10b (review 10, F2) each pass of a tap reads its stale ops again", "      tap.asked.add(k);\n", ""],
  ["P9 (review 10, order) the tap's re-read after another op's landed record is walked", "    await reread();\n    // another op of U with a live record", "    // another op of U with a live record", "    const read = await readMoveOut(U, typed, token, rpcs);", "    await reread();\n    const read = await readMoveOut(U, typed, token, rpcs);"],
  ["P10 (review 10, F4) the tap's re-read outside U's lock", "    await reread();\n    // another op of U with a live record", "    // another op of U with a live record", "  const signed = await uLock(async (): Promise<Signed> => {\n", "  await reread();\n  const signed = await uLock(async (): Promise<Signed> => {\n"],
  ["R9b (review 9, ruling 1) an INCOMPLETE_DEPOSIT op never read again at the tap", " || o.follow.status === \"INCOMPLETE_DEPOSIT\")) continue;", ")) continue;"],
  ["R9d (review 9, ruling 1) the tap's read never keeps what it read", "        return Object.keys(read).length === 0 ? undefined : { ...x, follow: { ...x.follow, ...read } };", "        return undefined;"],
  // delta review 11: the floor on what U held (F1, and its fix reverted), the tap's one budget over both passes (F2)
  ["X1 (review 11, F2) the tap's budget never passed to the reads", "fetchFn ?? fetch, budget, Date.now())", "fetchFn ?? fetch, undefined, Date.now())"],
  ["X2 (review 11, F2) a fresh budget each pass of a tap", "    tap.budget ??= AbortSignal.timeout(DEPOSIT_STATUS_TIMEOUT_MS);", "    tap.budget = AbortSignal.timeout(DEPOSIT_STATUS_TIMEOUT_MS);"],
  ["X3 (review 11, F3) the floor strict (> MIN_DEPOSIT)", "BigInt(r.amount) + 1n >= VAULT_CONSTANTS.MIN_DEPOSIT ?", "BigInt(r.amount) + 1n > VAULT_CONSTANTS.MIN_DEPOSIT ?"],
  ["F1r (review 11, F1 reverted) the floor on the moved amount, not what U held", "BigInt(r.amount) + 1n >= VAULT_CONSTANTS.MIN_DEPOSIT ?", "BigInt(r.amount) >= VAULT_CONSTANTS.MIN_DEPOSIT ?"],
];
// delta review 8, ruling 1: holdAll's status read (src/deposit/follow.ts), run against the follow's own tests
const FF = `${W}/src/deposit/follow.ts`;
const MF = [
  ["H8a (review 8, ruling 1) holdAll holds an op with no status read", "      const st = await readDepositStatus(op.follow.address, U, fetchFn, signal, now());\n      await ops.update", "      const st = null as StatusRead | null;\n      await ops.update"],
  ["H8b (review 8, ruling 1) holdAll's read never marks the send seen", "  if (st.status !== \"PENDING_DEPOSIT\" && !f.sent) read.sent = true;\n", ""],
  ["H8c (review 8, ruling 1) holdAll's SUCCESS read never keeps delivered", "  if (st.status === \"SUCCESS\" && f.delivered === undefined) read.delivered = (st.delivered ?? 0n).toString();\n", ""],
  ["H9a (review 9, ruling 2) holdAll reads each op's status before its held write", "    for (const [id, op] of all) await write(id, \"held\", legFacts(op, \"held\"), { why });\n    for (const [id, op] of all) {\n      const st = await readDepositStatus(op.follow.address, U, fetchFn, signal, now());\n", "    for (const [id, op] of all) {\n      const st = await readDepositStatus(op.follow.address, U, fetchFn, signal, now());\n      await write(id, \"held\", legFacts(op, \"held\"), { why });\n"],
];
let killed = 0;
const ALL = [...M.map((m) => [F, TESTS, m]), ...MF.map((m) => [FF, ["test/deposit-follow.test.ts"], m])];
const srcs = new Map([F, FF].map((f) => [f, readFileSync(f, "utf8")]));
for (const [file, tests, [name, ...pairs]] of ALL) {
  const src = srcs.get(file);
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
  writeFileSync(file, s);
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  let r;
  try {
    r = runSync("node", ["--test", ...tests], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
  } finally {
    writeFileSync(file, src);
  }
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const by = [...r.stdout.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1].slice(0, 70)).filter((v, i, a) => a.indexOf(v) === i);
  const dead = r.status !== 0 && Number(fail) > 0;
  if (dead) killed++;
  console.log(`${dead ? "KILLED" : "SURVIVED"} [${name}] pass ${pass} fail ${fail}${by.length ? ` by: ${by.join(" | ")}` : ""}`);
}
console.log(`${killed}/${ALL.length} killed`);
console.log([...srcs].every(([f, src]) => readFileSync(f, "utf8") === src) ? "source restored" : "SOURCE NOT RESTORED");
if (killed !== ALL.length) process.exitCode = 1;
