#!/usr/bin/env node
// Live check of card kit-freeze-helper-api: the helper API /v1 is one typed file in the kit, as GitHub serves it.
// It reads packages/kit/src/helper/v1.ts and packages/kit/src/index.ts from GitHub (main, then the 06:00Z freeze tag)
// and parses them with the TypeScript parser, never running them. It checks, against values pinned here from
// markets.md at research main ffcba5e (the public repo carries no papers):
//   - the file imports nothing outside the kit (only `import type` of Chain and OrderRecord from ../orders/record.ts, the
//     CO's call at 00:35Z), redefines none of the wallet's exported names (a duplicate fails the kit's tsc with
//     TS2308), and index.ts exports it ("export * from ./helper/v1");
//   - the path list equals H7's table (markets.md:3329-3345) with 7.1's new POST /v1/log (:3277), and the health parts
//     are {proxy, relay, intents, delegate, orders, log} (:3278, :3331);
//   - /v1/bind's body is one signed delegate, and its deposit shape is a DelegateAction holding ft_transfer_call (:3274,
//     :3340);
//   - /v1/intents' body holds only the transfer and ft_withdraw kinds, verifying_contract intents.near, and no msg, memo
//     or storage_deposit field anywhere (:3341, :1910-1923);
//   - every answer-code list equals its row, in order (H4.3's for /v1/bind, :3338-3342), with 503 token_halted and 403
//     receiver_is_vault, and /v1/intents never answers token_halted;
//   - cross-origin reads for exactly APP_HOST and SIGN_HOST (:3280, :3291-3311): never "*", no credentials, Vary:
//     Origin, X-Helper-Commit exposed (:3287-3289);
//   - after 06:00Z, main's v1.ts equals the tag's byte for byte.
// Once the helper answers (card helper-host-health), it also reads https://api.confidential.unrealized.trade/v1/health
// from APP_HOST's Origin and from a stranger's, and compares its parts, X-Helper-Commit and CORS headers with the file.
// While the host does not answer at all, that part is skipped and said so; --require-health makes it a failure.
//   node scripts/live-checks/kit-freeze-helper-api.mjs [--tag <06:00Z tag>] [--require-health] [--record <file>]
//     PASS exit 0, FAIL exit 1, error exit 2 (after 06:00Z, --tag is required)
// --record writes every answer the run read to <file>, so the check's test can replay it.
import { writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const KEY = "kit-freeze-helper-api";
export const RAW = "https://raw.githubusercontent.com/UNRLZD/confidential-trenches";
export const V1 = "packages/kit/src/helper/v1.ts";
export const ENTRY = "packages/kit/src/index.ts";
// HELPER_HOST, markets.md:2434
export const HEALTH = "https://api.confidential.unrealized.trade/v1/health";
export const FREEZE = Date.parse("2026-11-01T06:00:00Z");
const STRANGER = "https://stranger.invalid";
const TIMEOUT_MS = 10_000;
const MAX_TEXT = 1 << 20; // a v1.ts or index.ts over 1 MB is not ours
const MAX_HEALTH = 1024; // H7: /v1/health answers 1 KB

// ---- pinned from markets.md at research main ffcba5e ----
// H7's table (:3331-3345) and 7.1's new row POST /v1/log (:3277)
export const PATHS = [
  "GET /v1/health",
  "POST /v1/proxy/{vendor}/{path}",
  "POST /v1/rpc/{chain}",
  "GET /v1/market/...",
  "GET /v1/logo/{chain}/{token}",
  "GET /v1/token-status",
  "GET /v1/withdraw/fee",
  "POST /v1/withdraw",
  "GET /v1/withdraw/{tx_hash}",
  "POST /v1/bind",
  "POST /v1/intents",
  "POST /v1/orders",
  "POST /v1/orders/status",
  "PUT /v1/orders/{order_id}",
  "DELETE /v1/orders/{order_id}",
  "POST /v1/log",
];
export const PARTS = ["proxy", "relay", "intents", "delegate", "orders", "log"]; // :3278, :3331
// APP_HOST and SIGN_HOST (M326 (5); wallet.md:1227), the only origins (:3297-3298)
export const ORIGINS = ["https://confidential.unrealized.trade", "https://sign.confidential.unrealized.trade"];
export const CODES = {
  // :3338, H3.4's order
  HELPER_WITHDRAW_CODES: ["bad_shape", "bad_proof", "bad_fee_recipient", "fee_too_low", "fee_above_cap", "spent", "unknown_root", "index_behind", "in_flight", "withdraw_failed", "recipient_refused", "register_deposit_wrong", "bad_recipient", "deadline_too_close", "token_halted", "fund_recipient_wrong", "relayer_low"],
  // :3340, H4.3's order
  HELPER_BIND_DEPOSIT_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "sender_struck", "expired", "resign_needed", "not_one_action", "not_ft_transfer_call", "token_not_accepted", "deposit_not_1_yocto", "gas_too_low", "gas_too_high", "bad_receiver", "amount_too_low", "amount_above_balance", "bad_msg", "p_used", "p_bound", "prepay_open", "in_flight", "token_halted", "relayer_low"],
  // :3340, checks 1-4, then the clean-up's own (:1871-1880)
  HELPER_BIND_CLEANUP_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "expired", "resign_needed", "id_not_ours", "bad_shape", "not_deposited", "not_settled"],
  // :3340, H3.7 item 2's order
  HELPER_BIND_ONWARD_CODES: ["bad_shape", "bad_signature", "no_account", "bad_key", "bad_nonce", "id_not_ours", "not_paid", "expired", "token_not_accepted", "deposit_not_1_yocto", "gas_too_high", "bad_msg", "not_helper_quote", "sender_struck", "in_flight", "bad_receiver", "amount_above_balance", "amount_not_whole", "receiver_not_registered", "token_halted", "relayer_low", "registration_failed"],
  // :3341, H4.3's paragraph "The ids' intents on /v1/intents"
  HELPER_INTENTS_CODES: ["id_not_ours", "receiver_is_vault", "bad_shape", "not_helper_quote", "expired", "sender_struck", "in_flight", "simulation_refused", "receiver_not_registered", "relayer_low", "registration_failed"],
  // :3342
  HELPER_ORDER_CODES: ["bad_bytes", "bad_signature", "nonce_mismatch", "nonce_spent", "no_balance", "expired", "duplicate"],
};
export const STATUS = { token_halted: 503, receiver_is_vault: 403, id_not_ours: 403, sender_struck: 403, prepay_open: 409, not_paid: 409, receiver_not_registered: 409 };
const DELEGATE_FIELDS = ["sender_id", "receiver_id", "actions", "nonce", "max_block_height", "public_key"];
const NEVER_IN_INTENTS = ["msg", "memo", "storage_deposit"];
// the one import v1.ts makes, and the wallet's exported names it must not declare (CO, 00:35Z)
export const IMPORTS = ['import type { Chain, OrderRecord } from "../orders/record.ts";'];
export const WALLET_NAMES = ["Chain", "CHAINS", "TxRef", "Stage", "ErrorCode", "Operation", "OrderState", "WalletState", "OrderRecord", "SigninWay", "ReturnKey"];

// ---- reading TypeScript as data ----
const fail = (m) => {
  throw new Error(m);
};

export function parse(text) {
  const sf = ts.createSourceFile("v1.ts", text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  if (sf.parseDiagnostics?.length) fail(`does not parse: ${sf.parseDiagnostics[0].messageText}`);
  const decls = new Map();
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) decls.set(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, d);
  }
  return { sf, decls };
}

// a literal value (string, number, boolean, null, array, object) behind `as const` and `satisfies`; anything else refused
export function literal(node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal);
  if (ts.isObjectLiteralExpression(node)) {
    const o = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) fail(`not a plain property: ${p.getText()}`);
      o[p.name.text] = literal(p.initializer);
    }
    return o;
  }
  return fail(`not a literal: ${node.getText().slice(0, 60)}`);
}

const constOf = ({ decls }, name) => {
  const d = decls.get(name);
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer) fail(`no const ${name}`);
  return literal(d.initializer);
};

// every property name, and every string literal each property can hold, over the types reachable from `roots`
export function reach({ sf, decls }, roots) {
  const props = new Set();
  const lits = new Map();
  const seen = new Set();
  const addLits = (name, t) => {
    const ls = ts.isUnionTypeNode(t) ? t.types : [t];
    for (const l of ls) if (ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal)) lits.set(name, new Set([...(lits.get(name) ?? []), l.literal.text]));
  };
  const member = (m) => {
    if (m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
      props.add(m.name.text);
      if (m.type) addLits(m.name.text, m.type);
    }
    if (m.type) node(m.type);
    for (const p of m.parameters ?? []) if (p.type) node(p.type);
  };
  const named = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const d = decls.get(name);
    if (!d) return;
    if (ts.isInterfaceDeclaration(d)) {
      for (const h of d.heritageClauses ?? []) for (const t of h.types) node(t);
      d.members.forEach(member);
    } else if (ts.isTypeAliasDeclaration(d)) node(d.type);
  };
  const node = (n) => {
    if (ts.isTypeReferenceNode(n)) named(n.typeName.getText(sf));
    else if (ts.isExpressionWithTypeArguments(n)) named(n.expression.getText(sf));
    else if (ts.isTypeQueryNode(n)) named(n.exprName.getText(sf));
    if (ts.isTypeLiteralNode(n)) n.members.forEach(member);
    else ts.forEachChild(n, node);
  };
  roots.forEach(named);
  return { props, lits, seen };
}

const membersOf = ({ decls }, name) => {
  const d = decls.get(name);
  if (!d || !ts.isInterfaceDeclaration(d)) fail(`no interface ${name}`);
  return d.members.map((m) => m.name?.getText());
};

const imports = ({ sf }) => {
  const found = [];
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || (ts.isExportDeclaration(n) && n.moduleSpecifier)) found.push(n.getText(sf).replace(/\s+/g, " "));
    else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) found.push(n.getText(sf).slice(0, 60));
    else if (ts.isImportTypeNode(n)) found.push(n.getText(sf).slice(0, 60));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The checks on one v1.ts text: [ok, line] pairs.
export function checkV1(text) {
  const out = [];
  const t = (what, fn) => {
    try {
      const r = fn();
      out.push([r === true, r === true ? what : `${what}: ${r}`]);
    } catch (e) {
      out.push([false, `${what}: ${e.message}`]);
    }
  };
  let f;
  try {
    f = parse(text);
  } catch (e) {
    return [[false, `v1.ts ${e.message}`]];
  }
  t("v1.ts imports only the kit's order record", () => {
    const i = imports(f);
    return same(i, IMPORTS) || `imports ${i.map((x) => x.slice(0, 80)).join("; ") || "nothing"}`;
  });
  t("v1.ts redefines none of the wallet's exported names", () => {
    const dup = WALLET_NAMES.filter((n) => f.decls.has(n));
    return dup.length === 0 || `declares ${dup.join(", ")}`;
  });
  t("the path list equals H7 with 7.1's changes", () => {
    const got = constOf(f, "HELPER_V1_PATHS").map((p) => `${p.method} ${p.path}`);
    const missing = PATHS.filter((p) => !got.includes(p));
    const extra = got.filter((p) => !PATHS.includes(p));
    const dup = got.filter((p, i) => got.indexOf(p) !== i);
    return (missing.length === 0 && extra.length === 0 && dup.length === 0) || `missing [${missing}], extra [${extra}], twice [${dup}]`;
  });
  t("the health parts are {proxy, relay, intents, delegate, orders, log}", () => {
    const parts = constOf(f, "HELPER_PARTS");
    if (!same(parts, PARTS)) return `HELPER_PARTS is ${JSON.stringify(parts)}`;
    const bad = constOf(f, "HELPER_V1_PATHS").filter((p) => p.part !== "all" && !PARTS.includes(p.part));
    if (bad.length) return `paths name parts outside the list: ${bad.map((p) => p.path)}`;
    const h = reach(f, ["HelperHealthAnswer"]);
    return (h.props.has("parts") && h.seen.has("HelperPart")) || "HelperHealthAnswer.parts is not keyed by HelperPart";
  });
  t("/v1/bind's body is one signed delegate, its deposit a DelegateAction holding ft_transfer_call", () => {
    const body = membersOf(f, "HelperBindRequest");
    if (!same(body, ["signed_delegate"])) return `HelperBindRequest has [${body}]`;
    const da = membersOf(f, "HelperDelegateAction");
    const lack = DELEGATE_FIELDS.filter((x) => !da.includes(x));
    if (lack.length) return `HelperDelegateAction lacks [${lack}]`;
    const dep = f.decls.get("HelperBindDeposit");
    if (!dep || !ts.isTypeAliasDeclaration(dep)) return "no type HelperBindDeposit";
    const ref = dep.type;
    if (!ts.isTypeReferenceNode(ref) || ref.typeName.getText(f.sf) !== "HelperDelegateAction") return `HelperBindDeposit is ${ref.getText(f.sf)}`;
    const call = ref.typeArguments?.[0];
    const m = call && ts.isTypeReferenceNode(call) && call.typeName.getText(f.sf) === "HelperFunctionCall" ? call.typeArguments?.[0] : null;
    if (!m || !ts.isLiteralTypeNode(m) || m.literal.text !== "ft_transfer_call") return `HelperBindDeposit's action is ${call?.getText(f.sf)}`;
    const all = f.decls.get("HelperBindDelegate");
    return (all && reach(f, ["HelperBindDelegate"]).seen.has("HelperBindDeposit")) || "HelperBindDelegate does not hold HelperBindDeposit";
  });
  t("/v1/intents' body holds only transfer and ft_withdraw, with no msg, memo or storage_deposit", () => {
    const body = membersOf(f, "HelperIntentsRequest");
    if (!same(body, ["signed_intent"])) return `HelperIntentsRequest has [${body}]`;
    const r = reach(f, ["HelperIntentsRequest", "HelperIntentPayload"]);
    if (!r.seen.has("HelperIntent")) return "HelperIntentPayload does not hold HelperIntent";
    const kinds = [...(r.lits.get("intent") ?? [])].sort();
    if (!same(kinds, ["ft_withdraw", "transfer"])) return `intent kinds [${kinds}]`;
    const bad = NEVER_IN_INTENTS.filter((p) => r.props.has(p));
    if (bad.length) return `a field ${bad.join(", ")} is in the body`;
    const vc = [...(r.lits.get("verifying_contract") ?? [])];
    return same(vc, ["intents.near"]) || `verifying_contract [${vc}]`;
  });
  t("every answer-code list equals its H7 row, in order", () => {
    const bad = Object.entries(CODES).filter(([k, v]) => !same(constOf(f, k), v));
    if (bad.length) return `differs: ${bad.map(([k]) => k).join(", ")}`;
    if (constOf(f, "HELPER_INTENTS_CODES").includes("token_halted")) return "/v1/intents answers token_halted";
    const st = constOf(f, "HELPER_CODE_STATUS");
    const wrong = Object.entries(STATUS).filter(([k, v]) => st[k] !== v);
    return wrong.length === 0 || `HTTP status wrong for ${wrong.map(([k, v]) => `${k} (${st[k]}, not ${v})`).join(", ")}`;
  });
  t("cross-origin reads for exactly APP_HOST and SIGN_HOST, never *, no credentials", () => {
    const c = constOf(f, "HELPER_CORS");
    if (JSON.stringify(c).includes("*")) return `HELPER_CORS holds "*": ${JSON.stringify(c)}`;
    if (!same(c.origins, ORIGINS)) return `origins ${JSON.stringify(c.origins)}`;
    if (c.credentials !== false) return `credentials ${c.credentials}`;
    if (c.vary !== "Origin") return `vary ${c.vary}`;
    return (Array.isArray(c.exposeHeaders) && c.exposeHeaders.includes("X-Helper-Commit")) || "X-Helper-Commit is not exposed";
  });
  t("X-Helper-Commit on every answer", () => constOf(f, "HELPER_COMMIT_HEADER") === "X-Helper-Commit" || "HELPER_COMMIT_HEADER is not X-Helper-Commit");
  return out;
}

// index.ts exports the file, so apps reach it through the kit's public entry
export function checkEntry(text) {
  const { sf } = parse(text);
  const ok = sf.statements.some((s) => ts.isExportDeclaration(s) && !s.exportClause && !s.isTypeOnly && s.moduleSpecifier && /^\.\/helper\/v1(\.ts|\.js)?$/.test(s.moduleSpecifier.text));
  return [ok, ok ? 'index.ts holds export * from "./helper/v1"' : 'index.ts does not export * from "./helper/v1"'];
}

async function readText(fetchFn, url, max = MAX_TEXT) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  const text = await r.text();
  if (text.length > max) return { status: r.status, text: null, over: true };
  return { status: r.status, text, headers: r.headers };
}

// The health answer, or { error } when the host does not answer at all.
async function readHealth(fetchFn) {
  try {
    return await readText(fetchFn, HEALTH, MAX_HEALTH);
  } catch (e) {
    return { error: String(e.cause?.code ?? e.name ?? e.message) };
  }
}

export function checkHealth(app, stranger, v1Parts = PARTS) {
  const out = [];
  const h = (ok, line) => out.push([ok, line]);
  if (app.over) return [[false, `health answers more than ${MAX_HEALTH} bytes`]];
  let j;
  try {
    j = JSON.parse(app.text);
  } catch {
    return [[false, `health answers status ${app.status}, not JSON`]];
  }
  const parts = j && typeof j.parts === "object" && j.parts !== null ? j.parts : {};
  const keys = Object.keys(parts).sort();
  h(app.status === 200 && same(keys, [...v1Parts].sort()), `health parts [${keys}] equal the file's [${v1Parts}] (status ${app.status})`);
  const vals = Object.values(parts).filter((v) => v !== "up" && v !== "down");
  h(vals.length === 0 && typeof j.ok === "boolean", `health ok is a boolean and every part is up or down${vals.length ? `: got ${JSON.stringify(vals)}` : ""}`);
  const commit = app.headers.get("x-helper-commit");
  h(typeof j.commit === "string" && j.commit.length > 0 && commit === j.commit, `X-Helper-Commit ${commit} equals the answer's commit ${j.commit}`);
  const acao = app.headers.get("access-control-allow-origin");
  h(acao === ORIGINS[0], `from APP_HOST's Origin, Access-Control-Allow-Origin is ${acao}`);
  const vary = (app.headers.get("vary") ?? "").toLowerCase().split(",").map((s) => s.trim());
  h(vary.includes("origin"), `Vary holds Origin (${app.headers.get("vary")})`);
  h(app.headers.get("access-control-allow-credentials") === null, "no Access-Control-Allow-Credentials");
  const sacao = stranger.error ? null : stranger.headers.get("access-control-allow-origin");
  h(!stranger.error && sacao === null, `from a stranger's Origin, Access-Control-Allow-Origin is ${stranger.error ? `unread (${stranger.error})` : sacao ?? "absent"}`);
  return out;
}

// fetchFn(url, init) as fetch; now: the check's clock; tag: the 06:00Z tag's name
export async function check({ fetchFn = fetch, now = Date.now(), tag, requireHealth = false } = {}) {
  const lines = [];
  let ok = true;
  const add = (good, line) => {
    ok &&= good;
    lines.push(`${good ? "ok " : "BAD"} ${line}`);
  };
  const refs = ["main"];
  if (now >= FREEZE) {
    if (!tag) throw new Error("after 06:00Z, name the freeze tag: --tag <tag>");
    refs.push(tag);
  } else if (tag) refs.push(tag);
  else lines.push("--  the 06:00Z tag is not due yet: main only");
  const texts = {};
  for (const ref of refs) {
    const url = `${RAW}/${encodeURIComponent(ref)}/${V1}`;
    const r = await readText(fetchFn, url);
    if (r.status !== 200 || r.text === null) {
      add(false, `${ref}: ${V1} answers ${r.over ? "over 1 MB" : `status ${r.status}`}`);
      continue;
    }
    texts[ref] = r.text;
    for (const [good, line] of checkV1(r.text)) add(good, `${ref}: ${line}`);
    const e = await readText(fetchFn, `${RAW}/${encodeURIComponent(ref)}/${ENTRY}`);
    if (e.status !== 200 || e.text === null) add(false, `${ref}: ${ENTRY} answers status ${e.status}`);
    else {
      const [good, line] = checkEntry(e.text);
      add(good, `${ref}: ${line}`);
    }
  }
  if (refs.length === 2 && texts.main !== undefined && texts[tag] !== undefined) add(texts.main === texts[tag], `main's v1.ts equals the tag ${tag}'s byte for byte`);
  const app = await readHealth((u, i) => fetchFn(u, { ...i, headers: { Origin: ORIGINS[0] } }));
  if (app.error) {
    if (requireHealth) add(false, `${HEALTH} does not answer (${app.error})`);
    else lines.push(`--  ${HEALTH} does not answer yet (${app.error}): the health comparison waits for helper-host-health`);
  } else {
    const stranger = await readHealth((u, i) => fetchFn(u, { ...i, headers: { Origin: STRANGER } }));
    let parts = PARTS;
    try {
      parts = constOf(parse(texts.main ?? ""), "HELPER_PARTS");
    } catch {
      // main's file failed above; compare with the pinned parts
    }
    for (const [good, line] of checkHealth(app, stranger, parts)) add(good, line);
  }
  return { ok, lines };
}

// a fetch that keeps every answer it reads: { url, origin, status, headers, text } or { url, origin, error }
export function recorder(fetchFn = fetch) {
  const answers = [];
  const wrapped = async (url, init = {}) => {
    const origin = init.headers?.Origin ?? null;
    try {
      const r = await fetchFn(url, init);
      const text = await r.text();
      answers.push({ url, origin, status: r.status, headers: Object.fromEntries(r.headers), text });
      return new Response(text, { status: r.status, headers: r.headers });
    } catch (e) {
      answers.push({ url, origin, error: String(e.cause?.code ?? e.name ?? e.message) });
      throw e;
    }
  };
  return { answers, fetchFn: wrapped };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  try {
    const rec = recorder();
    const r = await check({ fetchFn: opt("--record") ? rec.fetchFn : fetch, tag: opt("--tag"), requireHealth: a.includes("--require-health") });
    if (opt("--record")) writeFileSync(opt("--record"), JSON.stringify(rec.answers, null, 1) + "\n");
    for (const l of r.lines) console.log(`live-check ${KEY}: ${l}`);
    console.log(`live-check ${KEY}: ${r.ok ? "PASS" : "FAIL"}`);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${String(e.message).split("\n")[0]}`);
    process.exit(2);
  }
}
