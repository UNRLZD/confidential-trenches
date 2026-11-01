// node --test scripts/live-checks/kit-freeze-helper-api.test.mjs: the live check replays recorded answers
// (kit-freeze-helper-api.answers.json):
//   live_main: the real run on GitHub main at 2026-11-01 00:14:53Z, before this card merged: v1.ts answers 404, and the
//     helper host does not answer (a timeout), so the health part is skipped;
//   good: v1.ts, orders/record.ts and index.ts as GitHub serves them once this card merges (all from the branch at
//     5682bcf, index.ts with its export line), on main and on a stand-in for the 06:00Z tag, and the same real
//     health timeout; v1.ts is the file with card kit-deposit-cap's additions (the cap and amount_above_cap);
//   live_kit_v1: the real run on GitHub main and the kit-v1 tag at 2026-11-01 08:32:10Z, before kit-deposit-cap
//     merged: both v1.ts files lack the cap and its code, and the helper answers its health. Its two orders/record.ts
//     reads answered the same text as good's main record.ts byte for byte, so the file names that answer
//     (text_same_as) instead of holding the text twice;
//   health_up: a /v1/health answer written to H7 and card helper-host-health's end state (every part "down"), read
//     from APP_HOST's Origin and from a stranger's, since the host does not answer yet.
// The bad answers are the good one with one change each: a /v1/intents type that carries a msg (a move into the
// vault), a CORS list holding "*", the withdrawal without its salt, relay_fee renamed, and more below (an import from
// outside the kit, the wallet's names redefined, a limit or pin changed). Each must FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, checkV1, FREEZE, V1 } from "./kit-freeze-helper-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC = JSON.parse(readFileSync(path.join(HERE, "kit-freeze-helper-api.answers.json"), "utf8"));
for (const set of Object.values(REC)) for (const a of set) if (a.text_same_as) a.text = REC.good.find((g) => g.url === a.text_same_as).text;
const TAG = "freeze-test-tag";
const BEFORE = Date.parse("2026-11-01T00:14:53Z");
const AFTER = FREEZE + 60_000;

// each (url, Origin) gets its last recorded answer, so a later set overrides; a recorded error is thrown as fetch throws it
function replay(answers) {
  return async (url, init = {}) => {
    const origin = init.headers?.Origin ?? null;
    const a = answers.findLast((x) => x.url === url && x.origin === origin);
    if (!a) throw new Error(`no recorded answer for ${url} from ${origin}`);
    if (a.error) throw Object.assign(new Error(a.error), { name: a.error });
    return new Response(a.text, { status: a.status, headers: a.headers });
  };
}

// the good answer with v1.ts's text changed by `edit` on every ref (the edit must apply)
function withV1(edit, answers = REC.good) {
  return answers.map((a) => {
    if (!a.url?.endsWith(V1)) return a;
    const text = edit(a.text);
    assert.notEqual(text, a.text, "the edit changed nothing");
    return { ...a, text };
  });
}
const good = REC.good.find((a) => a.url.endsWith(`/main/${V1}`)).text;
const failed = (r) => r.lines.filter((l) => l.startsWith("BAD"));
const IMP = 'import { ORDER_RECORD_FIELDS, type Chain, type OrderRecord } from "../orders/record.ts";';

test("recorded good answer, main and the tag, the helper not up yet: PASS", async () => {
  const r = await check({ fetchFn: replay(REC.good), now: AFTER, tag: TAG });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ")).length, 2 * 12 + 1, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  main's v1.ts equals the tag ${TAG}'s byte for byte`));
  assert.match(r.lines.at(-1), /^-- {2}https:\/\/api\.confidential\.unrealized\.trade\/v1\/health does not answer yet \(TimeoutError\)/);
});

test("recorded good answer with the helper up: the health parts and CORS headers match: PASS", async () => {
  const r = await check({ fetchFn: replay([...REC.good, ...REC.health_up]), now: AFTER, tag: TAG, requireHealth: true });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  health parts [delegate,intents,log,orders,proxy,relay] equal the file's [proxy,relay,intents,delegate,orders,log] (status 200)"));
  assert.ok(r.lines.includes("ok  from a stranger's Origin, Access-Control-Allow-Origin is absent"));
});

test("recorded real run on GitHub main and kit-v1, before the cap was added: the cap and its code missing: FAIL", async () => {
  const r = await check({ fetchFn: replay(REC.live_kit_v1), now: Date.parse("2026-11-01T08:32:10Z"), tag: "kit-v1", requireHealth: true });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["main", "kit-v1"].flatMap((ref) => [`BAD ${ref}: every answer-code list equals its H7 row, in order: differs: HELPER_BIND_DEPOSIT_CODES`, `BAD ${ref}: every frozen value equals its pin: differs: HELPER_BIND_DEPOSIT_CAP`]));
  assert.ok(r.lines.includes("ok  main's v1.ts equals the tag kit-v1's byte for byte"));
});

test("recorded real run on GitHub main before the merge: v1.ts is missing: FAIL", async () => {
  const r = await check({ fetchFn: replay(REC.live_main), now: BEFORE });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["BAD main: packages/kit/src/helper/v1.ts answers status 404"]);
});

// the failing lines of one bad v1.ts on both refs
const both = (lines) => ["main", TAG].flatMap((ref) => lines.map((l) => `BAD ${ref}: ${l}`));
const SHAPE = (names) => `every money-path shape equals its pin: differs: ${names}`;
const VALUE = (names) => `every frozen value equals its pin: differs: ${names}`;

test("recorded bad answer: a /v1/intents type that carries a msg (a move into the vault): FAIL", async () => {
  const bad = withV1((t) => t.replace("  intent: \"ft_withdraw\";\n  token: HelperNearAccount;\n", "  intent: \"ft_withdraw\";\n  token: HelperNearAccount;\n  msg?: string;\n"));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), both(["/v1/intents' body holds only transfer and ft_withdraw, with no msg, memo or storage_deposit: a field msg is in the body", SHAPE("HelperIntentFtWithdraw")]));
});

test("recorded bad answer: a CORS list holding \"*\": FAIL", async () => {
  const bad = withV1((t) => t.replace('origins: ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"],', 'origins: ["*"],'));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), both(['cross-origin reads for exactly APP_HOST and SIGN_HOST, never *, no credentials: HELPER_CORS holds "*": ' + JSON.stringify({ origins: ["*"], allowMethods: ["GET", "POST", "PUT", "DELETE"], allowHeaders: ["content-type"], exposeHeaders: ["X-Helper-Commit", "X-Helper-Source", "X-Fetched-At"], maxAgeSeconds: 600, vary: "Origin", allowCredentialsHeader: "absent" }), VALUE("HELPER_CORS")]));
});

test("recorded bad answer: the withdrawal without its salt: FAIL", async () => {
  const bad = withV1((t) => t.replace("  deadline_ms: number;\n  salt: string;\n}", "  deadline_ms: number;\n}"));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.deepEqual(failed(r), both([SHAPE("HelperWithdrawal")]));
});

test("recorded bad answer: relay_fee renamed fee in the fee answer: FAIL", async () => {
  const bad = withV1((t) => t.replace("  fee_recipient: HelperNearAccount;\n  relay_fee: HelperDecimal;\n  gp: HelperDecimal;", "  fee_recipient: HelperNearAccount;\n  fee: HelperDecimal;\n  gp: HelperDecimal;"));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.deepEqual(failed(r), both([SHAPE("HelperWithdrawFeeAnswer")]));
});

test("more bad answers, each caught by exactly the lines named", () => {
  const cases = [
    ["an import from outside the kit", (t) => t.replace(IMP, `${IMP}\nimport { x } from "@blindfill/wallet";`), [/^v1\.ts imports only the kit's order record: imports .*@blindfill\/wallet/]],
    ["no import, the order record redefined", (t) => t.replace(IMP, 'export type Chain = "solana" | "base" | "robinhood" | "near";\nexport interface OrderRecord { v: 1; variants: [string]; expires_at?: number; order_id: string }\nconst ORDER_RECORD_FIELDS = ["v"] as const;'), [/^v1\.ts imports only the kit's order record: imports nothing$/, /^v1\.ts redefines none of the wallet's exported names: declares Chain, OrderRecord$/]],
    ["a wallet name beside the import", (t) => t.replace("export type HelperBase64 = string;", "export type HelperBase64 = string;\nexport type ErrorCode = string;"), [/^v1\.ts redefines none of the wallet's exported names: declares ErrorCode$/]],
    ["/v1/log dropped", (t) => t.replace('  { method: "POST", path: "/v1/log", part: "log", limitBytes: 4096 },\n', ""), [/path list .*missing \[POST \/v1\/log\]/, /^every frozen value equals its pin: differs: HELPER_V1_PATHS$/]],
    ["a body limit raised", (t) => t.replace('{ method: "POST", path: "/v1/bind", part: "delegate", limitBytes: 4096 }', '{ method: "POST", path: "/v1/bind", part: "delegate", limitBytes: 65536 }'), [/^every frozen value equals its pin: differs: HELPER_V1_PATHS$/]],
    ["an RPC method added", (t) => t.replace('near: ["query",', 'near: ["query", "EXPERIMENTAL_changes",'), [/^every frozen value equals its pin: differs: HELPER_RPC_METHODS$/]],
    ["a third intent kind", (t) => t.replace("export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw;", 'export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw | { intent: "mt_withdraw" };'), [/intent kinds \[ft_withdraw,mt_withdraw,transfer\]/, /^every money-path shape equals its pin: differs: HelperIntent$/]],
    ["the deposit carried by ft_withdraw", (t) => t.replace('export type HelperBindDeposit = HelperDelegateAction<HelperFunctionCall<"ft_transfer_call",', 'export type HelperBindDeposit = HelperDelegateAction<HelperFunctionCall<"ft_withdraw",'), [/HelperBindDeposit's action is HelperFunctionCall<"ft_withdraw"/, /^every money-path shape equals its pin: differs: HelperBindDeposit$/]],
    ["the onward receiver loosened", (t) => t.replace("  receiver_id: typeof HELPER_ONWARD_RECEIVER;", "  receiver_id: HelperNearAccount;"), [/^every money-path shape equals its pin: differs: HelperOnwardArgs$/]],
    ["fund_recipient optional", (t) => t.replace("  fund_recipient: true;", "  fund_recipient?: boolean;"), [/^every money-path shape equals its pin: differs: HelperWithdrawRequest$/]],
    ["a base64 signature", (t) => t.replace("  signature: HelperEd25519Signature;", "  signature: HelperBase64;"), [/^every money-path shape equals its pin: differs: HelperSignedIntent$/]],
    ["status items unbounded", (t) => t.replace("export const HELPER_STATUS_ITEMS_MAX = 100;", "export const HELPER_STATUS_ITEMS_MAX = 1000;"), [/^every frozen value equals its pin: differs: HELPER_STATUS_ITEMS_MAX$/]],
    ["salt in any case", (t) => t.replace("export const HELPER_SALT_PATTERN = /^[0-9a-f]{32}$/;", "export const HELPER_SALT_PATTERN = /^[0-9a-fA-F]{32}$/;"), [/^every frozen value equals its pin: differs: HELPER_SALT_PATTERN$/]],
    ["a field on the order", (t) => t.replace('[...ORDER_RECORD_FIELDS, "token_hash"]', '[...ORDER_RECORD_FIELDS, "token_hash", "note"]'), [/^every frozen value equals its pin: differs: HELPER_ORDER_FIELDS$/]],
    ["bind codes out of H4.3's order", (t) => t.replace('  "sender_struck",\n  "expired",\n  "resign_needed",\n  "not_one_action",', '  "expired",\n  "sender_struck",\n  "resign_needed",\n  "not_one_action",'), [/differs: HELPER_BIND_DEPOSIT_CODES/]],
    ["the cap raised", (t) => t.replace("export const HELPER_BIND_DEPOSIT_CAP = 1_000_000_000n;", "export const HELPER_BIND_DEPOSIT_CAP = 10_000_000_000n;"), [/^every frozen value equals its pin: differs: HELPER_BIND_DEPOSIT_CAP$/]],
    ["the cap a number, not a bigint", (t) => t.replace("export const HELPER_BIND_DEPOSIT_CAP = 1_000_000_000n;", "export const HELPER_BIND_DEPOSIT_CAP = 1_000_000_000;"), [/^every frozen value equals its pin: differs: HELPER_BIND_DEPOSIT_CAP$/]],
    ["the cap's code dropped", (t) => t.replace('  "amount_too_low",\n  "amount_above_cap",\n', '  "amount_too_low",\n'), [/differs: HELPER_BIND_DEPOSIT_CODES/]],
    ["the cap's code after the balance", (t) => t.replace('  "amount_above_cap",\n  "amount_above_balance",\n', '  "amount_above_balance",\n  "amount_above_cap",\n'), [/differs: HELPER_BIND_DEPOSIT_CODES/]],
    ["token_halted on /v1/intents", (t) => t.replace('  "relayer_low",\n  "registration_failed",\n] as const;\nexport type HelperIntentsCode', '  "relayer_low",\n  "registration_failed",\n  "token_halted",\n] as const;\nexport type HelperIntentsCode'), [/differs: HELPER_INTENTS_CODES/]],
    ["index_behind not 503", (t) => t.replace("  index_behind: 503,", "  index_behind: 500,"), [/^every frozen value equals its pin: differs: HELPER_CODE_STATUS$/]],
    ["token_halted not 503", (t) => t.replace("  token_halted: 503,", "  token_halted: 400,"), [/HTTP status wrong for token_halted \(400, not 503\)/, /^every frozen value equals its pin: differs: HELPER_CODE_STATUS$/]],
    ["the credentials header allowed", (t) => t.replace('  allowCredentialsHeader: "absent",', "  allowCredentialsHeader: true,"), [/allowCredentialsHeader true/, /^every frozen value equals its pin: differs: HELPER_CORS$/]],
    ["a longer preflight cache", (t) => t.replace("  maxAgeSeconds: 600,", "  maxAgeSeconds: 86400,"), [/^every frozen value equals its pin: differs: HELPER_CORS$/]],
    ["a computed origin", (t) => t.replace('origins: ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"],', "origins: [process.env.ORIGIN],"), [/not a literal: process\.env\.ORIGIN/, /^every frozen value equals its pin: differs: HELPER_CORS$/]],
  ];
  const record = REC.good.find((a) => a.url.endsWith("/main/packages/kit/src/orders/record.ts")).text;
  for (const [what, edit, wants] of cases) {
    const text = edit(good);
    assert.notEqual(text, good, what);
    const bad = checkV1(text, record).filter(([ok]) => !ok).map(([, line]) => line);
    assert.equal(bad.length, wants.length, `${what}: ${bad.join(" | ")}`);
    wants.forEach((w, i) => assert.match(bad[i], w, what));
  }
  assert.deepEqual(checkV1(good, "").filter(([ok]) => !ok).map(([, l]) => l), ["every frozen value equals its pin: differs: HELPER_ORDER_FIELDS"], "no record.ts read");
});

test("after 06:00Z: main's v1.ts must equal the tag's, and the tag is required", async () => {
  const drift = REC.good.map((a) => (a.url.endsWith(`/${TAG}/${V1}`) ? { ...a, text: `${a.text}// changed after the freeze\n` } : a));
  const r = await check({ fetchFn: replay(drift), now: AFTER, tag: TAG });
  assert.deepEqual(failed(r), [`BAD main's v1.ts equals the tag ${TAG}'s byte for byte`]);
  await assert.rejects(check({ fetchFn: replay(REC.good), now: AFTER }), /after 06:00Z, name the freeze tag/);
});

test("health that answers \"*\" or the wrong parts: FAIL", async () => {
  const [app, stranger] = REC.health_up;
  const star = [{ ...app, headers: { ...app.headers, "access-control-allow-origin": "*" } }, { ...stranger, headers: { ...stranger.headers, "access-control-allow-origin": "*" } }];
  const r1 = await check({ fetchFn: replay([...REC.good, ...star]), now: AFTER, tag: TAG });
  assert.deepEqual(failed(r1), ["BAD from APP_HOST's Origin, Access-Control-Allow-Origin is *", "BAD from a stranger's Origin, Access-Control-Allow-Origin is *"]);
  const fewer = JSON.parse(app.text);
  delete fewer.parts.log;
  const r2 = await check({ fetchFn: replay([...REC.good, { ...app, text: JSON.stringify(fewer) }, stranger]), now: AFTER, tag: TAG });
  assert.equal(r2.ok, false);
  assert.match(failed(r2)[0], /^BAD health parts \[delegate,intents,orders,proxy,relay\] equal the file's/);
  const r3 = await check({ fetchFn: replay(REC.good), now: AFTER, tag: TAG, requireHealth: true });
  assert.deepEqual(failed(r3), ["BAD https://api.confidential.unrealized.trade/v1/health does not answer (TimeoutError)"]);
});
