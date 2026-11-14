// node --test scripts/live-checks/same-coin-deposits-across-chains-quote.test.mjs: the live check replays recorded
// answers (same-coin-deposits-across-chains-quote.answers.json, its note says where each was read). good: this card's
// signing page build beside 1Click's live dry answers through the helper (fee 1 on the four listed routes, 20 on the
// three Robinhood neighbours, both modes): PASS. liveBefore: the same run with SIGN_HOST as served at 07:09Z, which
// carries no same-coin route: FAIL. Bad answers derived from good (a fee entry 1Click did not give, a route missing
// from the bundle, a pin that is not the served script, a record of another route): FAIL; 1Click's no-liquidity 400:
// INCONCLUSIVE.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The recorded bodies carry no signature (an "ed25519:" signature has a NEAR secret key's shape). Each is signed again
// here, as 1Click signs (bs58(sha256(stable-json)) as UTF-8, built with node:crypto apart from the kit), with a throwaway
// key this process alone trusts, given by a load hook in place of the kit's key set (the pins are frozen).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (b) => {
  let n = 0n, s = "";
  for (const x of b) n = (n << 8n) | BigInt(x);
  for (; n > 0n; n /= 58n) s = B58[Number(n % 58n)] + s;
  for (const x of b) { if (x !== 0) break; s = `1${s}`; }
  return s;
};
const stable = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
};
const KEY = generateKeyPairSync("ed25519");
const HARNESS_KEY = `ed25519:${b58(Buffer.from(KEY.publicKey.export({ format: "jwk" }).x, "base64url"))}`;
registerHooks({
  load(url, context, next) {
    if (!url.endsWith("/checks/oneclick-keys.ts")) return next(url, context);
    const source = `import { ONECLICK_SIGNING_KEYS as PINNED } from ${JSON.stringify(`${url}?pinned`)};
export const ONECLICK_SIGNING_KEYS = Object.freeze([...PINNED, ${JSON.stringify(HARNESS_KEY)}]);
`;
    return { format: "module", source, shortCircuit: true };
  },
});
const { COLLECTOR, EXIT, MODES, NEIGHBOURS, ROUTES, bundle, facts, judge, read, routeName, unsigned } = await import("./same-coin-deposits-across-chains-quote.mjs");
const { ONECLICK_SAME_COIN_ROUTES, ONECLICK_SIGNING_KEYS, oneClickFeeBps } = await import("../../packages/kit/src/index.ts");
assert.ok(ONECLICK_SIGNING_KEYS.includes(HARNESS_KEY) && Object.isFrozen(ONECLICK_SIGNING_KEYS));
const u = (x) => (x ? x : undefined);
function signBody(text) {
  const a = JSON.parse(text);
  if (!a?.quoteRequest || !a?.quote) return text;
  const r = a.quoteRequest, q = a.quote;
  const req = { dry: r.dry, swapType: r.swapType, slippageTolerance: r.slippageTolerance, originAsset: r.originAsset, depositType: r.depositType,
    destinationAsset: r.destinationAsset, amount: r.amount, refundTo: r.refundTo, refundType: r.refundType, recipient: r.recipient,
    recipientType: r.recipientType, deadline: r.deadline, quoteWaitingTimeMs: u(r.quoteWaitingTimeMs), referral: u(r.referral),
    virtualChainRecipient: u(r.virtualChainRecipient), virtualChainRefundRecipient: u(r.virtualChainRefundRecipient), customRecipientMsg: u(r.customRecipientMsg) };
  const base = { amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountInUsd: q.amountInUsd, minAmountIn: q.minAmountIn,
    amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, amountOutUsd: q.amountOutUsd, minAmountOut: q.minAmountOut };
  const h = b58(createHash("sha256").update(stable({ ...req, ...base, timestamp: a.timestamp })).digest());
  a.signature = `ed25519:${b58(sign(null, Buffer.from(h, "utf8"), KEY.privateKey))}`;
  return JSON.stringify(a);
}
const signed = (rec) => {
  const r = structuredClone(rec);
  for (const a of r.quotes) if (a.status === 200 || a.status === 201) a.body = signBody(a.body);
  return r;
};
const FILE = path.join(HERE, "same-coin-deposits-across-chains-quote.answers.json");
const RAW = JSON.parse(readFileSync(FILE, "utf8"));
const A = { good: signed(RAW.good), liveBefore: signed(RAW.liveBefore) };
const bads = (v) => v.lines.filter((l) => l.startsWith("BAD "));
const ETH_BASE = "nep141:eth.omft.near > nep141:base.omft.near";
const HOOD_BASE = "nep141:hood.omft.near > nep141:base.omft.near";
/** good with one quote's body changed by `f` (then signed again), or the record changed by `g`. */
const withQuote = (route, mode, f) => {
  const r = structuredClone(RAW.good);
  const a = r.quotes.find((x) => x.route === route && x.mode === mode);
  const b = JSON.parse(a.body); f(b, a); a.body = JSON.stringify(b);
  return signed(r);
};

test("good: this card's build beside 1Click's live answers passes, every route both modes", () => {
  const v = judge(A.good);
  assert.equal(v.verdict, "PASS", v.lines.join("\n"));
  assert.equal(v.lines.filter((l) => l.startsWith("ok  ")).length, 1 + ROUTES.length * MODES.length);
});
test("liveBefore: SIGN_HOST as served at 07:09Z carries no same-coin route: FAIL on that alone", () => {
  const v = judge(A.liveBefore);
  assert.equal(v.verdict, "FAIL");
  assert.equal(bads(v).length, 1);
  assert.match(bads(v)[0], /lacks the kit's same-coin routes/);
  assert.deepEqual(RAW.liveBefore.sign.routes, []);
});
test("the recorded answers carry no 1Click signature; unsigned, the whole check refuses each public answer", () => {
  assert.doesNotMatch(readFileSync(FILE, "utf8"), /ed25519:/);
  const v = judge(RAW.good);
  assert.equal(v.verdict, "FAIL");
  assert.equal(bads(v).length, ROUTES.length);
  assert.ok(bads(v).every((l) => / public: .*\(signature\)/.test(l)), bads(v).join("\n"));
});
test("the fee entry is held to the kit's rule both ways: 20 on a listed route, 1 on a neighbour, another collector: FAIL", () => {
  for (const mode of MODES) {
    const v20 = judge(withQuote(ETH_BASE, mode, (b) => { b.quoteRequest.appFees[0].fee = 20; }));
    assert.equal(v20.verdict, "FAIL");
    assert.match(bads(v20).join("\n"), new RegExp(`${ETH_BASE} ${mode}: appFees .*fee 1`));
    const v1 = judge(withQuote(HOOD_BASE, mode, (b) => { b.quoteRequest.appFees[0].fee = 1; }));
    assert.equal(v1.verdict, "FAIL");
    assert.match(bads(v1).join("\n"), new RegExp(`${HOOD_BASE} ${mode}: appFees .*fee 20`));
    const other = mode === "public" ? COLLECTOR.advanced : COLLECTOR.public;
    assert.equal(judge(withQuote(ETH_BASE, mode, (b) => { b.quoteRequest.appFees[0].recipient = other; })).verdict, "FAIL");
    assert.equal(judge(withQuote(ETH_BASE, mode, (b) => { b.quoteRequest.appFees.push({ recipient: COLLECTOR[mode], fee: 1 }); })).verdict, "FAIL");
  }
});
test("a public answer short of the device's floor fails the whole check (its signed amounts, signed again)", () => {
  const v = judge(withQuote(ETH_BASE, "public", (b) => { b.quote.minAmountOut = "1"; b.quote.amountOut = "2"; b.quote.amountOutFormatted = "0.000000000000000002"; }));
  assert.equal(v.verdict, "FAIL");
  assert.match(bads(v).join("\n"), /\(floor\)/);
});
test("the bundle: a route missing, or a pin that is not the served script: FAIL", () => {
  const miss = structuredClone(A.good); miss.sign.routes = miss.sign.routes.slice(1);
  assert.match(bads(judge(miss)).join("\n"), new RegExp(`lacks the kit's same-coin route ${ETH_BASE}`));
  const pin = structuredClone(A.good); pin.sign.pin = "sha384-x";
  assert.match(bads(judge(pin)).join("\n"), /not the one index\.html pins/);
  const none = structuredClone(A.good); none.sign.pin = null;
  assert.match(bads(judge(none)).join("\n"), /pins no \/app\.js/);
});
test("a missing quote, an HTTP refusal or a record of another route: FAIL; 1Click's no liquidity: INCONCLUSIVE", () => {
  const gone = structuredClone(A.good); gone.quotes = gone.quotes.filter((q) => !(q.route === ETH_BASE && q.mode === "public"));
  assert.match(bads(judge(gone)).join("\n"), /no quote read/);
  const refused = structuredClone(A.good); Object.assign(refused.quotes.find((q) => q.route === ETH_BASE), { status: 401, body: "{\"message\":\"Invalid token\"}" });
  assert.equal(judge(refused).verdict, "FAIL");
  const swapped = withQuote(ETH_BASE, "public", (_b, a) => { a.request.originAsset = "nep141:hood.omft.near"; });
  assert.match(bads(judge(swapped)).join("\n"), /not this route's/);
  const dry = structuredClone(A.good); Object.assign(dry.quotes.find((q) => q.route === ETH_BASE), { status: 400, body: "{\"message\":\"No liquidity available for this pair\"}" });
  const v = judge(dry);
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.equal(EXIT[v.verdict], 3);
});
test("facts reads a minified bundle: each route as its own frozen pair, any quotes and spacing; a plain pair is not counted", () => {
  const [[o0, d0], [o1, d1], ...rest] = ONECLICK_SAME_COIN_ROUTES;
  const index = '<script type="module" src="/app.js" integrity="sha384-x"></script>';
  const tail = rest.map(([o, d]) => `Object.freeze([\`${o}\`,\`${d}\`])`).join(",");
  const f = facts(index, `a=Object.freeze([Object.freeze( [ "${o0}" , '${d0}' ] ),[\`${o1}\`,\`${d1}\`],${tail}])`);
  assert.equal(f.pin, "sha384-x");
  assert.deepEqual(f.routes, [routeName([o0, d0]), ...rest.map(routeName)]);
  // the way back is another route
  assert.deepEqual(facts(index, `Object.freeze([\`${d0}\`,\`${o0}\`])`).routes, []);
});
test("the check reads the kit's routes, then the neighbours the kit holds at 20, each at the kit's own fee", () => {
  assert.deepEqual(ROUTES.slice(0, ONECLICK_SAME_COIN_ROUTES.length), ONECLICK_SAME_COIN_ROUTES.map(([o, d]) => [o, d]));
  for (const [o, d] of ONECLICK_SAME_COIN_ROUTES) assert.equal(oneClickFeeBps("partner", o, d), 1);
  for (const [o, d] of NEIGHBOURS) assert.equal(oneClickFeeBps("partner", o, d), 20);
});
test("read asks SIGN_HOST and every route in both modes through the helper, dry, and --record drops the signature", async () => {
  const asked = [];
  const js = "x";
  const index = `<script type="module" src="/app.js" integrity="sha384-${createHash("sha384").update(js).digest("base64")}"></script>`;
  const fetchFn = async (url, init) => {
    asked.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.endsWith("/app.js")) return new Response(js);
    if (url.startsWith("https://confidential.unrealized.trade")) return new Response(index);
    return new Response(JSON.stringify({ quoteRequest: { appFees: [] }, quote: {}, signature: "ed25519:x" }), { status: 201 });
  };
  const rec = await read(fetchFn, () => 1_800_000_000_000, async () => {});
  const quotes = asked.filter((a) => a.body);
  assert.equal(quotes.length, ROUTES.length * MODES.length);
  assert.ok(quotes.every((a) => a.url === "https://ct-api.unrealized.trade/v1/proxy/oneclick/v0/quote" && a.body.dry === true));
  assert.equal(quotes.filter((a) => a.body.confidentiality === "advanced").length, ROUTES.length);
  assert.doesNotMatch(JSON.stringify(unsigned(rec)), /ed25519:/);
});
test("bundle: the SIGN_HOST half alone, on a build that carries every route frozen PASS, one route short FAIL; it asks nothing else", async () => {
  const routes = ONECLICK_SAME_COIN_ROUTES.map(([o, d]) => `Object.freeze([\`${o}\`,\`${d}\`])`);
  const serve = (js) => {
    const index = `<script type="module" src="/app.js" integrity="sha384-${createHash("sha384").update(js).digest("base64")}"></script>`;
    return async (url) => {
      if (url === "https://confidential.unrealized.trade/app.js") return new Response(js);
      if (url === "https://confidential.unrealized.trade/") return new Response(index);
      throw new Error(`${url}: not this build`);
    };
  };
  const all = await bundle(serve(`a=Object.freeze([${routes.join(",")}])`));
  assert.equal(all.ok, true, all.lines.join("\n"));
  const short = await bundle(serve(`a=Object.freeze([${routes.slice(1).join(",")}])`));
  assert.equal(short.ok, false);
  assert.match(short.lines.join("\n"), new RegExp(`lacks the kit's same-coin route ${ETH_BASE}`));
});
