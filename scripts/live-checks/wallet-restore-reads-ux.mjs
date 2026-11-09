#!/usr/bin/env node
// Live check of card wallet-restore-reads-ux: the signing page's restore reads each pool deposit id's U_X on the pool's
// own chain with the pool follow's own reader (packages/signpage/src/pool-restore.ts step 5; src/main.ts hands it the
// follow's balances: getBalance at finalized, one U_X per request, on the pool kinds' two RPCs), and its two RPCs must
// give the same balance. This check makes those very reads from SIGN_HOST's origin (https://confidential.unrealized.trade)
// on both providers of each Solana pool cluster the page's builds pin a pool on, or will:
//   - devnet, the testnet build's pool (SOL_POOLS.devnet): api.devnet.solana.com and the helper's /v1/rpc/solana-devnet
//     (packages/signpage/src/pool-testnet.ts TESTNET_RPCS.solana);
//   - mainnet, the mainnet build's pair (pageSolanaRpcs: PublicNode and the helper's /v1/rpc/solana), the pair a mainnet
//     restore reads U_X on once SOL_POOLS.mainnet is pinned.
// Each provider is asked for two accounts: the cluster's pool program data account (a balance that never moves, so two
// providers at different finalized slots still give one number) and an account no one holds (sha256 of this card's key,
// as a public key: 0 on both). PASS: every provider answers HTTP 200 with a balance, lets SIGN_HOST's origin read the
// answer (Access-Control-Allow-Origin: that origin or *), and the two providers of a cluster give the same balance, above
// 0 for the program data account and 0 for the empty one. Base and Robinhood pin no pool on any build yet (EVM_POOLS
// is empty), so the restore names their U_X unread and this check reads none there.
// And SIGN_HOST's served build (/app.js, the one its index.html pins by sha384) holds, as minified:
//   - ux_read: step 5's reader of an id reads its U_X beside the id on the pool's two RPCs (`balances({u})`, the id's
//     index handed on) and refuses two balances; any balance there is the id's history ("money"), kept for the carry;
//   - ux_carry: a U_X is carried as the follow carries it: the lower of two equal balances, the follow's floor and
//     askOf's ask, the page's pool.deposit, read again after a filled one, and named when it does not fill or a filled
//     one leaves the balance as it was; a U_X whose index has no deposit note in the store is named with its index,
//     address and balance, never carried (card notes-plan-at-restored-index makes that note);
//   - ux_wired: the restore's U_X reads are the follow's own deps (the very function the follows' `deps` calls), keyed by
//     the pool's chain.
// After: sign
//   node scripts/live-checks/wallet-restore-reads-ux.mjs [--local] [--origin <origin>] [--record <file>] [--answer <file>]
// --local judges this tree's committed build (packages/signpage/index.html and public/app.js) in SIGN_HOST's place, the
// providers still asked live; --origin asks them from another origin (a recorded bad answer). PASS exit 0, FAIL exit 1,
// error exit 2.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "wallet-restore-reads-ux";
export const SIGN = "https://confidential.unrealized.trade";
const HELPER = "https://ct-api.unrealized.trade";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes) => {
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = `1${s}`;
  }
  return s;
};
/** An account no one holds: sha256 of the card's key, as a public key. */
export const EMPTY = base58(createHash("sha256").update(KEY).digest());
/** Each cluster's pair and its pool program data account (contracts/pool-solana/deployments/mainnet.json,
 *  scripts/live-checks/pool-sol-deploy.devnet.json). */
export const CLUSTERS = Object.freeze({
  devnet: Object.freeze({ providers: ["https://api.devnet.solana.com", `${HELPER}/v1/rpc/solana-devnet`], held: "AVGA2PJ9cQGGtvDbHupfxoMBz2fqRKZToB61egkAT3Xt" }),
  mainnet: Object.freeze({ providers: ["https://solana-rpc.publicnode.com", `${HELPER}/v1/rpc/solana`], held: "EuoumSLYMugNL6TsEKRby4bYXH4EcEgwASFdWhWNBQxM" }),
});

const N = "[\\w$]+";
const Q = "`";
const UX_READ = new RegExp(
  `\\((${N}),(${N})\\)=>\\{if\\(\\2===void 0\\)throw Error\\(${Q}no deposit index for its U_X${Q}\\);let (${N})=await ${N}\\(\\1,\\2\\),(${N})=await ${N}\\(${N},${N},${N}\\.scope,\\2,\\1\\),` +
    `\\[(${N}),(${N})\\]=await ${N}\\.balances\\(\\{u:\\4\\}\\);if\\(\\5!==\\6\\)throw Error\\(${Q}its U_X reads [^${Q}]*${Q}\\);return \\5===0n\\?\\3:\\(${N}\\.set\\(\\2,\\{[^}]*u:\\4,refund_id:\\1\\}\\),${Q}money${Q}\\)\\}`,
);
const UX_CARRY = new RegExp(
  `async function ${N}\\((${N}),(${N}),(${N}),(${N})\\)\\{let (${N})=null;for\\(;;\\)\\{let\\[(${N}),(${N})\\]=await \\1\\.balances\\(\\2\\);if\\(\\6!==\\7\\)return${Q}reads [^${Q}]*${Q};` +
    `if\\(\\5!==null&&\\6>=\\5\\)return${Q}holds [^${Q}]*after a deposit from it filled: read again${Q};if\\(\\6<\\1\\.ladder\\.min\\)return null;let (${N})=await \\1\\.costs\\(\\2\\);if\\(\\6<\\8\\.floor\\)return null;` +
    `let (${N})=${N}\\(\\1\\.ladder,\\6,\\8\\.perRung,\\8\\.keep\\);if\\(\\9===0n\\)return null;if\\(!\\3\\)return${Q}holds \\$\\{String\\(\\6\\)\\}, with no deposit note on this device for its index to carry it into the pool${Q};` +
    `\\4\\.throwIfAborted\\(\\);let (${N})=await \\1\\.deposit\\(\\2,\\9,\\4\\);` +
    `if\\(\\10!==${Q}filled${Q}&&\\10!==${Q}part_filled${Q}\\)return${Q}holds [^${Q}]*its carry into the pool ended [^${Q}]*${Q};\\5=\\6\\}\\}`,
);
// the carry asked only with the store's word on the index: `noted(scope)` read once per scope with a U_X held, and the
// carry handed whether U_{s,i}'s own index is among them
const UX_NOTED = new RegExp(`=(${N})\\.size===0\\?new Set:await (${N})\\((${N})\\.scope\\);for\\(let (${N}) of\\[\\.\\.\\.\\1\\.values\\(\\)\\]\\.sort\\(\\([^)]*\\)=>[^)]*\\)\\)\\{${N}\\.throwIfAborted\\(\\);let ${N}=await ${N}\\(${N},\\4,(${N})\\.has\\(\\4\\.i\\),${N}\\)`);
const UX_WIRED = new RegExp(`ux:(${N})=>\\{let (${N})=(${N})\\(\\{chain:\\1,[^}]*\\},${N}\\);return \\2===null\\?null:\\{balances:\\2\\.balances,costs:\\2\\.costs,ladder:\\2\\.ladder,deposit:\\2\\.deposit\\}\\}`);
const FOLLOW_DEPS = (d) => new RegExp(`deps:\\((${N}),(${N})\\)=>${d.replace(/[$]/g, "\\$")}\\(\\1,\\2\\)`);

/** The bundle's facts, from SIGN_HOST's index.html and /app.js (or this tree's build). */
export function bundleFacts(index, js) {
  const wired = UX_WIRED.exec(js);
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: `sha384-${createHash("sha384").update(js).digest("base64")}`,
    ux_read: UX_READ.test(js),
    ux_carry: UX_CARRY.test(js) && UX_NOTED.test(js),
    ux_wired: !!wired && FOLLOW_DEPS(wired[3]).test(js),
  };
}
const SIGNPAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../packages/signpage");
/** This tree's committed SIGN_HOST build: its index.html and public/app.js. */
export const localBuild = () => ({ index: readFileSync(path.join(SIGNPAGE, "index.html"), "utf8"), js: readFileSync(path.join(SIGNPAGE, "public/app.js"), "utf8") });
/** SIGN_HOST's build as served (`fetchFn`), or this tree's committed one (`local`): its bundle facts. */
export async function readBundle(fetchFn = fetch, local = false) {
  if (local) {
    const b = localBuild();
    return { from: "local build", ...bundleFacts(b.index, b.js) };
  }
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, ...bundleFacts(await get("/"), await get("/app.js")) };
}
export const BUNDLE_WHY = {
  ux_read: "step 5 does not read each id's U_X beside it on the pool's two RPCs, refusing two balances and keeping a held one for the carry",
  ux_carry: "a U_X is not carried as the follow carries it (its floor and ask, the page's pool.deposit, read again after a fill, named when it does not fill), or one whose index has no deposit note here is not named",
  ux_wired: "the restore's U_X reads are not the follow's own deps keyed by the pool's chain",
};

/** One provider's getBalance at finalized of `u`, asked from `origin`: its status, its CORS answer and the balance. */
async function balanceOf(fetchFn, url, origin, u) {
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [u, { commitment: "finalized" }] }),
    redirect: "error",
  });
  const text = await r.text();
  let value = null;
  try {
    const v = JSON.parse(text)?.result?.value;
    if (Number.isSafeInteger(v) && v >= 0) value = v;
  } catch {}
  return { status: r.status, acao: r.headers.get("access-control-allow-origin"), value };
}

export async function read(fetchFn = fetch, origin = SIGN, local = false) {
  const out = { origin, bundle: await readBundle(fetchFn, local), clusters: {} };
  for (const [name, c] of Object.entries(CLUSTERS)) {
    const providers = [];
    for (const url of c.providers) providers.push({ url, held: await balanceOf(fetchFn, url, origin, c.held), empty: await balanceOf(fetchFn, url, origin, EMPTY) });
    out.clusters[name] = { held: c.held, empty: EMPTY, providers };
  }
  return out;
}

/** The bundle's verdict alone (readBundle()): the pin, and each fact. */
export function judgeBundle(b = {}) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  if (!b?.pin) bad("SIGN_HOST's index.html pins no /app.js");
  else if (b.pin !== b.sha384) bad("SIGN_HOST's served /app.js is not the one index.html pins");
  for (const [k, why] of Object.entries(BUNDLE_WHY)) if (b?.[k] !== true) bad(why);
  return { ok: lines.length === 0, lines };
}

/** The verdict on an answer (read()). */
export function judge(a) {
  const lines = [];
  const bad = (m) => lines.push(`BAD ${m}`);
  if (a?.origin !== SIGN) bad(`asked from ${String(a?.origin)}, not SIGN_HOST's origin ${SIGN}`);
  lines.push(...judgeBundle(a?.bundle).lines);
  for (const [name, c] of Object.entries(CLUSTERS)) {
    const got = a?.clusters?.[name];
    if (!got || got.held !== c.held || got.empty !== EMPTY || !Array.isArray(got.providers) || got.providers.length !== 2) {
      bad(`${name}: no read of the pair's two providers for its pool's accounts`);
      continue;
    }
    got.providers.forEach((p, k) => {
      if (p.url !== c.providers[k]) bad(`${name}: provider ${k} is ${String(p.url)}, not ${c.providers[k]}`);
      for (const what of ["held", "empty"]) {
        const x = p[what];
        if (x?.status !== 200) bad(`${name} ${p.url} ${what}: HTTP ${String(x?.status)}`);
        if (x?.acao !== "*" && x?.acao !== SIGN) bad(`${name} ${p.url} ${what}: SIGN_HOST's origin may not read its answer (Access-Control-Allow-Origin ${String(x?.acao)})`);
        if (!Number.isSafeInteger(x?.value)) bad(`${name} ${p.url} ${what}: no balance in its answer`);
      }
    });
    const [p, q] = got.providers;
    if (p.held?.value !== q.held?.value) bad(`${name}: the two providers give ${String(p.held?.value)} and ${String(q.held?.value)} for the program data account`);
    if (!(p.held?.value > 0)) bad(`${name}: the program data account reads no balance`);
    if (p.empty?.value !== 0 || q.empty?.value !== 0) bad(`${name}: the account no one holds reads ${String(p.empty?.value)} and ${String(q.empty?.value)}, not 0 on both`);
  }
  return { ok: lines.length === 0, lines };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, arg("--origin") ?? SIGN, process.argv.includes("--local"));
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.ok ? "PASS" : "FAIL"} ${KEY}${answer.bundle?.from === "local build" ? " (local build)" : ""}`);
    process.exit(v.ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
