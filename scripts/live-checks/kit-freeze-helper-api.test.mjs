// node --test scripts/live-checks/kit-freeze-helper-api.test.mjs: the live check replays recorded answers
// (kit-freeze-helper-api.answers.json):
//   live_main: the real run on GitHub main at 2026-11-01 00:14:53Z, before this card merged: v1.ts answers 404, and the
//     helper host does not answer (a timeout), so the health part is skipped;
//   good: v1.ts and index.ts as GitHub serves them once this card merges (the branch's files, with index.ts's export
//     line), on main and on a stand-in for the 06:00Z tag, and the same real health timeout;
//   health_up: a /v1/health answer written to H7 and card helper-host-health's end state (every part "down"), read
//     from APP_HOST's Origin and from a stranger's, since the host does not answer yet.
// The bad answers are the good one with one change each: a /v1/intents type that carries a msg (a move into the
// vault), a CORS list holding "*", and more below (an import from outside the kit, the wallet's names redefined). Each
// must FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { check, checkV1, FREEZE, V1 } from "./kit-freeze-helper-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REC = JSON.parse(readFileSync(path.join(HERE, "kit-freeze-helper-api.answers.json"), "utf8"));
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

test("recorded good answer, main and the tag, the helper not up yet: PASS", async () => {
  const r = await check({ fetchFn: replay(REC.good), now: AFTER, tag: TAG });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.equal(r.lines.filter((l) => l.startsWith("ok ")).length, 2 * 10 + 1, r.lines.join("\n"));
  assert.ok(r.lines.includes(`ok  main's v1.ts equals the tag ${TAG}'s byte for byte`));
  assert.match(r.lines.at(-1), /^-- {2}https:\/\/api\.confidential\.unrealized\.trade\/v1\/health does not answer yet \(TimeoutError\)/);
});

test("recorded good answer with the helper up: the health parts and CORS headers match: PASS", async () => {
  const r = await check({ fetchFn: replay([...REC.good, ...REC.health_up]), now: AFTER, tag: TAG, requireHealth: true });
  assert.equal(r.ok, true, r.lines.join("\n"));
  assert.ok(r.lines.includes("ok  health parts [delegate,intents,log,orders,proxy,relay] equal the file's [proxy,relay,intents,delegate,orders,log] (status 200)"));
  assert.ok(r.lines.includes("ok  from a stranger's Origin, Access-Control-Allow-Origin is absent"));
});

test("recorded real run on GitHub main before the merge: v1.ts is missing: FAIL", async () => {
  const r = await check({ fetchFn: replay(REC.live_main), now: BEFORE });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["BAD main: packages/kit/src/helper/v1.ts answers status 404"]);
});

test("recorded bad answer: a /v1/intents type that carries a msg (a move into the vault): FAIL", async () => {
  const bad = withV1((t) => t.replace("  intent: \"ft_withdraw\";\n  token: HelperNearAccount;\n", "  intent: \"ft_withdraw\";\n  token: HelperNearAccount;\n  msg?: string;\n"));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["main", TAG].map((ref) => `BAD ${ref}: /v1/intents' body holds only transfer and ft_withdraw, with no msg, memo or storage_deposit: a field msg is in the body`));
});

test("recorded bad answer: a CORS list holding \"*\": FAIL", async () => {
  const bad = withV1((t) => t.replace('origins: ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"],', 'origins: ["*"],'));
  const r = await check({ fetchFn: replay(bad), now: AFTER, tag: TAG });
  assert.equal(r.ok, false);
  assert.equal(failed(r).length, 2);
  assert.match(failed(r)[0], /^BAD main: cross-origin reads for exactly APP_HOST and SIGN_HOST, never \*, no credentials: HELPER_CORS holds "\*"/);
});

test("more bad answers, each caught by its own line", () => {
  const cases = [
    ["an import from outside the kit", (t) => t.replace('import type { Chain, OrderRecord } from "../orders/record";', 'import type { Chain, OrderRecord } from "../orders/record";\nimport { x } from "@blindfill/wallet";'), /^v1\.ts imports only the kit's order record: imports .*@blindfill\/wallet/],
    ["no import, the order record redefined", (t) => t.replace('import type { Chain, OrderRecord } from "../orders/record";', 'export type Chain = "solana" | "base" | "robinhood" | "near";\nexport interface OrderRecord { v: 1; variants: [string]; expires_at?: number; order_id: string }'), null],
    ["a local Chain beside the import", (t) => t.replace("export type HelperBase64 = string;", 'export type HelperBase64 = string;\nexport type ErrorCode = string;'), /^v1\.ts redefines none of the wallet's exported names: declares ErrorCode/],
    ["/v1/log dropped", (t) => t.replace('  { method: "POST", path: "/v1/log", part: "log", limitBytes: 4096 },\n', ""), /path list .*missing \[POST \/v1\/log\]/],
    ["a third intent kind", (t) => t.replace("export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw;", 'export type HelperIntent = HelperIntentTransfer | HelperIntentFtWithdraw | { intent: "mt_withdraw" };'), /intent kinds \[ft_withdraw,mt_withdraw,transfer\]/],
    ["storage_deposit on ft_withdraw", (t) => t.replace("  amount: HelperDecimal;\n}\n\nexport type HelperIntent", "  amount: HelperDecimal;\n  storage_deposit?: HelperDecimal;\n}\n\nexport type HelperIntent"), /a field storage_deposit is in the body/],
    ["the deposit carried by ft_withdraw", (t) => t.replace('HelperDelegateAction<HelperFunctionCall<"ft_transfer_call", HelperFtTransferCallArgs>>;\n\n/**\n * An onward', 'HelperDelegateAction<HelperFunctionCall<"ft_withdraw", HelperFtTransferCallArgs>>;\n\n/**\n * An onward'), /HelperBindDeposit's action is HelperFunctionCall<"ft_withdraw"/],
    ["bind codes out of H4.3's order", (t) => t.replace('  "sender_struck",\n  "expired",\n  "resign_needed",\n  "not_one_action",', '  "expired",\n  "sender_struck",\n  "resign_needed",\n  "not_one_action",'), /differs: HELPER_BIND_DEPOSIT_CODES/],
    ["token_halted on /v1/intents", (t) => t.replace('  "relayer_low",\n  "registration_failed",\n] as const;\nexport type HelperIntentsCode', '  "relayer_low",\n  "registration_failed",\n  "token_halted",\n] as const;\nexport type HelperIntentsCode'), /differs: HELPER_INTENTS_CODES/],
    ["token_halted not 503", (t) => t.replace("  token_halted: 503,", "  token_halted: 400,"), /HTTP status wrong for token_halted \(400, not 503\)/],
    ["credentials allowed", (t) => t.replace("  credentials: false,", "  credentials: true,"), /credentials true/],
    ["a computed origin", (t) => t.replace('origins: ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"],', "origins: [process.env.ORIGIN],"), /not a literal: process\.env\.ORIGIN/],
  ];
  for (const [what, edit, want] of cases) {
    const text = edit(good);
    assert.notEqual(text, good, what);
    const bad = checkV1(text).filter(([ok]) => !ok).map(([, line]) => line);
    if (want === null) {
      // two lines: the import is gone, and Chain and OrderRecord are declared here
      assert.deepEqual(bad, ["v1.ts imports only the kit's order record: imports nothing", "v1.ts redefines none of the wallet's exported names: declares Chain, OrderRecord"], what);
      continue;
    }
    assert.equal(bad.length, 1, `${what}: ${bad.join(" | ")}`);
    assert.match(bad[0], want, what);
  }
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
