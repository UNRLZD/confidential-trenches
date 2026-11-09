#!/usr/bin/env node
// Live check of card wallet-restore-reads-ux: the signing page's restore reads each pool deposit id's U_X on the pool's
// own chain with the pool follow's own reader (packages/signpage/src/pool-restore.ts step 5, restoreUxOf: getBalance at
// finalized, one U_X per request) on the restore's own pair, two public operators and never our helper relay (one
// restore asks for all of a user's U_X, and our server is not the provider the paper lets see some ids),
// and the two must give the same balance. This check makes those very reads from SIGN_HOST's origin
// (https://confidential.unrealized.trade, sent as the Origin header, so a provider that refuses a page fails here) on
// both of the restore's providers (RESTORE_UX_SOLANA: PublicNode and Pocket's Solana gateway, the pair Verify reads the
// pool on, d8657094; api.mainnet-beta.solana.com answers any request with an Origin header 403). It reads the mainnet
// build's pair only: 1Click pays a pool deposit out on mainnet alone, and the testnet build reads no deposit id nor any
// U_X (devnet has no two public operators), so its restore ends stalled by name (POOL_UX_UNREAD_TESTNET), never done.
// Each is asked for two accounts: the mainnet pool's program data account (a balance
// that never moves, so two providers at different finalized slots still give one number) and an account no one holds
// (sha256 of this card's key, as a public key: 0 on both). PASS: neither provider is our helper, each answers HTTP 200
// with a balance and lets SIGN_HOST's origin read it (Access-Control-Allow-Origin: that origin or *), and the two give the
// same balance, above 0 for the program data account and 0 for the empty one. Base and Robinhood pin no pool on any build
// yet (EVM_POOLS is empty), so the restore names their U_X unread and this check reads none there.
// And SIGN_HOST's served build (/app.js, the one its index.html pins by sha384) holds, as minified, each marker exactly
// once in the whole bundle (review P2: a dead same-shaped copy beside a broken real one fails), each bound to its use:
//   - ux_read: step 5's reader of an id reads its U_X beside the id's NEAR read (both asked at once, `balances({u})`, the
//     id's index handed on) and refuses two balances; any balance there is the id's history ("money"), kept for the carry;
//     an id NEAR reads as money is noted for the held reads; and that reader is the one the scope's restoreDepositIds
//     call right after it is handed;
//   - ux_carry: a U_X is carried as the follow carries it: the lower of two equal balances, the follow's floor and
//     askOf's ask, the page's pool.deposit (its run's end, card pool-deposit-op-txs), read again after a filled one, and named when it does not fill or a filled
//     one leaves the balance as it was; a U_X whose index has no deposit note in the store is named with its index,
//     address and balance, never carried (card notes-plan-at-restored-index makes that note); the carry called is this
//     one, on the scope's own U_X reads and held map;
//   - id_held: each id NEAR read as money is read again by asset on both providers at once (the wallet's
//     nearIdHeldReader: the token and what intents.near holds, on each, an asset dropped only at 0 on both), and named
//     into step 5's own list while one asset is above the kept unit a move out leaves (ID_KEEP, 1n) or the two read it
//     apart (review P1; card restore-carries-pool-refund carries it);
//   - ux_pair: the restore's pair is PublicNode and Pocket's Solana gateway, each on its URL's own queue at the kit's
//     keyless limit (10 s: 100 calls, 40 of one method), read through the follow's own reader, the deposit the follow's own;
//   - ux_wired: the restore host's U_X reads are built from the follows' own deps (the very function their `deps` calls),
//     keyed by the pool's chain.
// After: sign
//   node scripts/live-checks/wallet-restore-reads-ux.mjs [--local] [--with <url>] [--record <file>] [--answer <file>]
// --local judges this tree's committed build (packages/signpage/index.html and public/app.js) in SIGN_HOST's place, the
// providers still asked live; --with asks <url> in the second provider's place (a recorded bad answer). PASS exit 0,
// FAIL exit 1, error exit 2, INCONCLUSIVE exit 3: every read goes through provider-answer.mjs (rpcAnswer, with SIGN_HOST's
// Origin header), each provider's CORS preflight is sent as the page's browser sends it (OPTIONS, POST and content-type
// asked; preflight), a provider that refuses SIGN_HOST's origin or its preflight fails (pageRefuses, preflightRefuses),
// and one that admits it but answers nothing usable (a timeout, a 429 or 5xx, a throttle code, an empty or non-JSON body,
// a redirect) is its no-answer: the pair is then not judged.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, pageRefuses, preflight, preflightRefuses, rpcAnswer, verdictOf } from "./provider-answer.mjs";

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
/** The restore's pair (packages/signpage/src/pool-restore.ts RESTORE_UX_SOLANA) and the mainnet pool's program data
 *  account (contracts/pool-solana/deployments/mainnet.json). */
export const CLUSTERS = Object.freeze({
  mainnet: Object.freeze({ providers: ["https://solana-rpc.publicnode.com", "https://solana.api.pocket.network"], held: "EuoumSLYMugNL6TsEKRby4bYXH4EcEgwASFdWhWNBQxM" }),
});

const N = "[\\w$]+";
const Q = "`";
const esc = (n) => n.replace(/[$]/g, "\\$");
// every marker is counted in the whole bundle and must match exactly once (review P2): a dead same-shaped copy beside a
// broken real one matches twice, or the real one's call site names another function
const once = (re, js) => [...js.matchAll(new RegExp(re.source, "g"))].length === 1;
// step 5's reader of an id, bound to its call site: the U_X reader `R` is the last argument of the scope's
// restoreDepositIds call right after it, and it notes each id NEAR reads as money (`D`) for the held reads below
const UX_READ = new RegExp(
  `,(${N})=async\\((${N}),(${N})\\)=>\\{if\\(\\3===void 0\\)throw Error\\(${Q}no deposit index for its U_X${Q}\\);let (${N})=await ${N}\\(${N},${N},(${N})\\.scope,\\3,\\2\\),` +
    `\\[(${N}),\\[(${N}),(${N})\\]\\]=await Promise\\.all\\(\\[${N}\\(\\2,\\3\\),(${N})\\.balances\\(\\{u:\\4\\}\\)\\]\\);if\\(\\6===${Q}money${Q}&&(${N})\\.set\\(\\3,\\2\\),\\7!==\\8\\)throw Error\\(${Q}its U_X reads [^${Q}]*${Q}\\);` +
    `return \\7===0n\\?\\6:\\((${N})\\.set\\(\\3,\\{[^}]*u:\\4,refund_id:\\2\\}\\),${Q}money${Q}\\)\\},${N}=await ${N}\\(${N},\\5\\.scope,\\{notes:\\[\\.\\.\\.\\5\\.notes\\],\\.\\.\\.${N}\\(\\5\\.notes,\\5\\.scope\\)\\},\\1\\);`,
);
const UX_CARRY = new RegExp(
  `async function (${N})\\((${N}),(${N}),(${N}),(${N})\\)\\{let (${N})=null;for\\(;;\\)\\{let\\[(${N}),(${N})\\]=await \\2\\.balances\\(\\3\\);if\\(\\7!==\\8\\)return${Q}reads [^${Q}]*${Q};` +
    `if\\(\\6!==null&&\\7>=\\6\\)return${Q}holds [^${Q}]*after a deposit from it filled: read again${Q};if\\(\\7<\\2\\.ladder\\.min\\)return null;let (${N})=await \\2\\.costs\\(\\3\\);if\\(\\7<\\9\\.floor\\)return null;` +
    `let (${N})=${N}\\(\\2\\.ladder,\\7,\\9\\.perRung,\\9\\.keep\\);if\\(\\10===0n\\)return null;if\\(!\\4\\)return${Q}holds \\$\\{String\\(\\7\\)\\}, with no deposit note on this device for its index to carry it into the pool${Q};` +
    `\\5\\.throwIfAborted\\(\\);let\\{end:(${N})\\}=await \\2\\.deposit\\(\\3,\\10,\\5\\);` +
    `if\\(\\11!==${Q}filled${Q}&&\\11!==${Q}part_filled${Q}\\)return${Q}holds [^${Q}]*its carry into the pool ended [^${Q}]*${Q};\\6=\\7\\}\\}`,
);
// the carry's call site, bound to the reader's held map (`held`), the scope's U_X reads (`ux`) and the carry's own name:
// `noted(scope)` read once per scope with a U_X held, and the carry handed whether U_{s,i}'s own index is among them
const UX_NOTED = (held, ux, carry) =>
  new RegExp(`=${esc(held)}\\.size===0\\?new Set:await ${N}\\(${N}\\.scope\\);for\\(let (${N}) of\\[\\.\\.\\.${esc(held)}\\.values\\(\\)\\]\\.sort\\(\\([^)]*\\)=>[^)]*\\)\\)\\{${N}\\.throwIfAborted\\(\\);let ${N}=await ${esc(carry)}\\(${esc(ux)},\\1,${N}\\.has\\(\\1\\.i\\),${N}\\)`);
// each id NEAR read as money (`D`), in index order, named by the held rule (`H`) on the both-provider held reader, into
// step 5's own `why` (delta review 2 P3-1: a push into any other list names nothing)
const ID_HELD_LOOP = (d, why) =>
  new RegExp(`for\\(let\\[(${N}),(${N})\\]of\\[\\.\\.\\.${esc(d)}\\]\\.sort\\(\\((${N}),(${N})\\)=>\\3\\[0\\]-\\4\\[0\\]\\)\\)\\{${N}\\.throwIfAborted\\(\\);let (${N})=await (${N})\\((${N}),\\2\\);for\\(let (${N}) of \\5\\)${esc(why)}\\.push\\(${Q}\\$\\{${N}\\.label\\}: deposit index \\$\\{\\1\\}'s id \\$\\{\\2\\} \\$\\{\\8\\}${Q}\\)\\}`);
// the held rule: an asset the two providers read apart, any amount of one that is not a fungible token (the token on its
// own `T`, or a nep141 one), or one above the kept unit (the way out's ID_KEEP, 1n), is named
const ID_HELD_RULE = (h) =>
  new RegExp(`async function ${esc(h)}\\((${N}),(${N})\\)\\{let (${N});try\\{\\3=await \\1\\(\\2\\)\\}catch\\((${N})\\)\\{return\\[${Q}holds money on NEAR whose amount is unread [^${Q}]*${Q}\\]\\}let (${N})=\\[\\];` +
    `for\\(let\\{asset:(${N}),amounts:\\[(${N}),(${N})\\]\\}of \\3\\)\\7===\\8\\?\\6!==(${N})&&!\\6\\.startsWith\\(${Q}nep141:${Q}\\)\\?\\5\\.push\\(${Q}holds \\$\\{String\\(\\7\\)\\} of \\$\\{\\6\\} on NEAR, not a fungible token [^${Q}]*${Q}\\):` +
    `\\7>1n&&\\5\\.push\\(${Q}holds \\$\\{String\\(\\7\\)\\} of \\$\\{\\6\\} on NEAR, above the [^${Q}]*${Q}\\):\\5\\.push\\(${Q}holds \\$\\{String\\(\\7\\)\\} and \\$\\{String\\(\\8\\)\\} of \\$\\{\\6\\} on NEAR's two RPCs: read again${Q}\\);return \\5\\}`);
// `T`: the pool deposit network's release USDC, NEAR_NETWORKS[POOL_DEPOSIT_NETWORK].usdc, the table bound to the bundle's
// NEAR_NETWORKS (its mainnet USDC its first entry; delta review 2 P3-2) and the network `mainnet`
const NEAR_NETS = new RegExp(`[,; ](${N})=\\{mainnet:\\{usdc:${Q}17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1${Q},vault:${Q}vault\\.confidential\\.unrlzd\\.near${Q},`);
const ID_HELD_TOKEN = (t, nets) => new RegExp(`[,; ]${esc(t)}=${esc(nets)}\\[(${N})\\]\\.usdc;`);
// `T` given a value once in the whole bundle, so a dead `T=NEAR_NETWORKS[mainnet].usdc` beside a real one reading
// another network is not the one the rule compares with
const ASSIGNED = (v) => new RegExp(`[^\\w$.]${esc(v)}=(?!=)`);
const MAINNET = (n) => new RegExp(`[,; ]${esc(n)}=${Q}mainnet${Q}[,;]`);
// step 5's head (review P2-2 of 39c5fdd7; on main's keptIdReader since wallet-id-reader-paced): the id reader on the
// restore's kept pass (keptIdReader, which hands back the pair and the pass it reads at) and the held reader `H` opened
// on that very pair and pass, both under the run's signal, so the held loop's reader is this very binding, never a name
// looked up across the bundle; `R` the held reader's builder; named groups: ids, keep, signal, why (readDepositIds'
// sixth parameter), pair, pass, net (the network), H, R
const STEP5_HEAD = new RegExp(
  `async function ${N}\\(${N},${N},(?<ids>${N}),(?<keep>${N}),(?<signal>${N}),(?<why>${N}),${N}\\)\\{let\\{rpcs:(?<pair>${N}),pass:(?<pass>${N}),reader:${N}\\}=await ${N}\\((?<net>${N}),\\k<ids>\\.rpcs,\\k<keep>,\\{\\.\\.\\.\\k<ids>\\.opts,signal:\\k<signal>\\}\\),` +
    `(?<H>${N})=await (?<R>${N})\\(\\k<net>,\\k<pair>,\\k<pass>,\\{\\.\\.\\.\\k<ids>\\.opts,signal:\\k<signal>\\}\\),`,
);
// the held reader: each provider's reader (`readOn`) reads the token (ft_balance_of, once U is registered on it) and adds
// what intents.near holds (`I`), every id read on both providers at once, each asset's two amounts taken one from each
// provider's map, and an asset left out only at 0 on both (delta review 2: P2-A the filter, P3-1 readOn's two reads)
const ID_HELD_BOTH = (f) =>
  new RegExp(`function ${esc(f)}\\((${N}),(${N}),(${N}),(${N})=\\{\\}\\)\\{let\\{token:(${N}),retried:(${N}),blockOf:(${N})\\}=${N}\\(\\1,\\2,\\4\\),(${N})=${N}\\(\\3,\\1,\\2\\),` +
    `(${N})=async\\((${N}),(${N})\\)=>\\{let (${N})=new Map,(${N})=\\(await \\6\\(\\10,${N}\\(\\5,${Q}storage_balance_of${Q},\\{account_id:\\11\\}\\),${Q}storage_balance_of${Q},\\8\\)\\)\\.v;` +
    `if\\(\\13!==null&&!\\(${N}\\(\\13\\)&&typeof \\13\\.total==${Q}string${Q}&&${N}\\.test\\(\\13\\.total\\)\\)\\)throw Error\\(${Q}[^${Q}]*${Q}\\);` +
    `\\13!==null&&\\12\\.set\\(\\5,${N}\\(\\(await \\6\\(\\10,${N}\\(\\5,${Q}ft_balance_of${Q},\\{account_id:\\11\\}\\),${Q}ft_balance_of${Q},\\8\\)\\)\\.v,${Q}[^${Q}]*${Q}\\)\\);` +
    `for\\(let\\[(${N}),(${N})\\]of await (${N})\\(\\6,\\10,\\11,\\8\\)\\)\\12\\.set\\(\\14,\\(\\12\\.get\\(\\14\\)\\?\\?0n\\)\\+\\15\\);return \\12\\};` +
    `return ${N}\\(\\3,\\2,\\7\\)\\.then\\(\\(\\)=>async (${N})=>\\{[^]{0,200}?let\\[(${N}),(${N})\\]=await Promise\\.all\\(\\[\\9\\(\\2\\[0\\],\\17\\),\\9\\(\\2\\[1\\],\\17\\)\\]\\);` +
    `return\\[\\.\\.\\.new Set\\(\\[\\.\\.\\.\\18\\.keys\\(\\),\\.\\.\\.\\19\\.keys\\(\\)\\]\\)\\]\\.sort\\(\\)\\.map\\((${N})=>\\(\\{asset:\\20,amounts:\\[\\18\\.get\\(\\20\\)\\?\\?0n,\\19\\.get\\(\\20\\)\\?\\?0n\\]\\}\\)\\)` +
    `\\.filter\\((${N})=>\\21\\.amounts\\[0\\]!==0n\\|\\|\\21\\.amounts\\[1\\]!==0n\\)\\}\\)\\}`);
// `I`, intentsHeld: intents.near's (`X`) token list for the account, then one balance per token, each token with its own
const INTENTS_HELD = (i) =>
  new RegExp(`async function ${esc(i)}\\((${N}),(${N}),(${N}),(${N})\\)\\{let (${N})=\\(await \\1\\(\\2,(${N})\\((${N}),${Q}mt_tokens_for_owner${Q},\\{account_id:\\3\\}\\),${Q}mt_tokens_for_owner${Q},\\4\\)\\)\\.v;[^]{0,300}?` +
    `if\\(\\5\\.length===0\\)return\\[\\];let (${N})=\\5\\.map\\((${N})=>\\9\\.token_id\\),(${N})=\\(await \\1\\(\\2,\\6\\(\\7,${Q}mt_batch_balance_of${Q},\\{account_id:\\3,token_ids:\\8\\}\\),${Q}mt_batch_balance_of${Q},\\4\\)\\)\\.v;` +
    `if\\(!Array\\.isArray\\(\\10\\)\\|\\|\\10\\.length!==\\8\\.length\\)throw Error\\(${Q}[^${Q}]*${Q}\\);return \\8\\.map\\(\\((${N}),(${N})\\)=>\\[\\11,${N}\\(\\10\\[\\12\\],${Q}[^${Q}]*${Q}\\)\\]\\)\\}`);
const INTENTS = (x) => new RegExp(`[,; ]${esc(x)}=${Q}intents\\.near${Q}[,;]`);
const UX_PAIR = new RegExp(
  `var (${N})=Object\\.freeze\\(\\[${Q}https://solana-rpc\\.publicnode\\.com${Q},${Q}https://solana\\.api\\.pocket\\.network${Q}\\]\\);function (${N})\\(\\)\\{return\\[(${N})\\((${N})\\(\\1\\[0\\]\\)\\),\\3\\(\\4\\(\\1\\[1\\]\\)\\)\\]\\}` +
    `function (${N})\\((${N}),(${N}),(${N}),(${N})=\\2\\)\\{if\\(\\6!==${Q}solana${Q}\\|\\|\\7===null\\|\\|\\8===void 0\\)return null;let (${N})=\\9\\(\\);if\\(\\10===null\\)return null;` +
    `let (${N})=(${N})\\(\\{rpcs:\\10,program:\\8,deposit:\\7\\.deposit\\}\\);return\\{balances:\\11\\.balances,costs:\\11\\.costs,ladder:\\11\\.ladder,deposit:\\7\\.deposit\\}\\}`,
);
// the kit's pacer at its default (keyless) limit: solanaPacedRpc(rpc, limit = SOLANA_KEYLESS_RPC_LIMIT)
const PACED = (p) => new RegExp(`function ${esc(p)}\\((${N}),(${N})=(${N})\\)\\{`);
const KEYLESS = (l) => new RegExp(`[,; ]${esc(l)}=\\{windowMs:1e4,total:100,perMethod:40\\};${N}\\(${esc(l)}\\)`);
// the follow's own reader: the function the follows' deps build solanaPoolFollowDeps with, balances at finalized
const FOLLOW_READER = (f) => new RegExp(`function ${esc(f)}\\((${N})\\)\\{let (${N})=(${N})=>Promise\\.all\\(\\[\\3\\(\\1\\.rpcs\\[0\\]\\),\\3\\(\\1\\.rpcs\\[1\\]\\)\\]\\);return\\{status:[^]{0,200}?balances:(${N})=>\\2\\(async (${N})=>${N}\\(await \\5\\(${Q}getBalance${Q},\\[\\4\\.u,\\{commitment:${Q}finalized${Q}\\}\\]\\)\\)\\)`);
// the restore host's ux, bound to the host itself (its signedIn and written before it, its ended after), so a copy of
// the ux line alone elsewhere is not the restore's
const UX_WIRED = (c) => new RegExp(`written:\\(\\)=>void ${N}\\?\\.proofs\\(\\)\\.catch\\(\\(\\)=>\\{\\}\\),ux:(${N})=>${esc(c)}\\(\\1,(${N})\\(\\{chain:\\1,[^}]*\\},${N}\\),${N}\\?\\.program\\),ended:`);
const UX_ANY = (c) => new RegExp(`ux:(${N})=>${esc(c)}\\(`);
// each marker's own words, once in the whole bundle, so no second copy of it rides beside the real one
const WORDS = Object.freeze({
  ux_read: /throw Error\(`no deposit index for its U_X`\)/,
  ux_carry: /, with no deposit note on this device for its index to carry it into the pool`/,
  id_held: /a move out keeps; a restore does not carry it yet/,
  ux_pair: /`https:\/\/solana\.api\.pocket\.network`/,
});
const FOLLOW_DEPS = (d) => new RegExp(`deps:\\((${N}),(${N})\\)=>${esc(d)}\\(\\1,\\2\\)`);

// the held loop is in step 5's own function: after its head, with no function begun between the two
const inside = (js, head, loop) => loop.index > head.index && !js.slice(head.index + head[0].length, loop.index).includes("function");

/** The bundle's facts, from SIGN_HOST's index.html and /app.js (or this tree's build). */
export function bundleFacts(index, js) {
  const read = once(UX_READ, js) ? UX_READ.exec(js) : null;
  const carry = once(UX_CARRY, js) ? UX_CARRY.exec(js) : null;
  const head = once(STEP5_HEAD, js) ? STEP5_HEAD.exec(js) : null;
  const loop = read && head ? ID_HELD_LOOP(read[10], head.groups.why) : null;
  const held = loop && once(loop, js) ? loop.exec(js) : null;
  const rule = held ? ID_HELD_RULE(held[6]) : null;
  const ruled = rule && once(rule, js) ? rule.exec(js) : null;
  const nets = once(NEAR_NETS, js) ? NEAR_NETS.exec(js) : null;
  const token = ruled && nets && once(ASSIGNED(ruled[9]), js) && once(ID_HELD_TOKEN(ruled[9], nets[1]), js) ? ID_HELD_TOKEN(ruled[9], nets[1]).exec(js) : null;
  const both = head && once(ID_HELD_BOTH(head.groups.R), js) ? ID_HELD_BOTH(head.groups.R).exec(js) : null;
  const intents = both && once(INTENTS_HELD(both[16]), js) ? INTENTS_HELD(both[16]).exec(js) : null;
  const pair = once(UX_PAIR, js) ? UX_PAIR.exec(js) : null;
  const paced = pair ? PACED(pair[3]).exec(js) : null;
  const wired = pair && once(UX_ANY(pair[5]), js) && once(UX_WIRED(pair[5]), js) ? UX_WIRED(pair[5]).exec(js) : null;
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: `sha384-${createHash("sha384").update(js).digest("base64")}`,
    ux_read: !!read && once(WORDS.ux_read, js),
    ux_carry: !!read && !!carry && once(UX_NOTED(read[11], read[9], carry[1]), js) && once(WORDS.ux_carry, js),
    id_held: !!held && !!head && held[7] === head.groups.H && inside(js, head, held) && !!ruled && !!token && once(MAINNET(token[1]), js) && !!both && !!intents && once(INTENTS(intents[7]), js) && once(WORDS.id_held, js),
    ux_pair: !!pair && !!paced && once(KEYLESS(paced[3]), js) && once(FOLLOW_READER(pair[12]), js) && once(WORDS.ux_pair, js),
    ux_wired: !!wired && once(FOLLOW_DEPS(wired[2]), js),
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
  ux_read: "step 5 does not read each id's U_X beside it on the pool's two RPCs and hand that reader to the scope's id read, refusing two balances, keeping a held one for the carry and noting each id NEAR reads as money",
  ux_carry: "a U_X is not carried as the follow carries it (its floor and ask, the page's pool.deposit, read again after a fill, named when it does not fill), or one whose index has no deposit note here is not named",
  id_held: "an id NEAR reads as money is not read on both providers by asset and named while it holds more than the kept unit a move out leaves, or the two read it apart",
  ux_pair: "the restore's U_X pair is not PublicNode and Pocket's Solana gateway, each on its own queue at the kit's keyless limit, through the follow's own reader",
  ux_wired: "the restore's U_X reads are not built from the follows' own deps, keyed by the pool's chain",
};

/** One provider's getBalance at finalized of `u`, asked from `origin` through provider-answer.mjs: its status, its CORS
 *  answer and the balance, or the provider's no-answer (named) or JSON-RPC error. */
async function balanceOf(fetchFn, url, origin, u) {
  const a = await rpcAnswer(url, "getBalance", [u, { commitment: "finalized" }], { fetchFn, headers: { origin }, redirect: "error" });
  const v = a.result?.value;
  return {
    status: a.status ?? null,
    acao: a.acao ?? null,
    value: Number.isSafeInteger(v) && v >= 0 ? v : null,
    ...(a.noAnswer === undefined ? {} : { noAnswer: a.noAnswer }),
    ...(a.error === undefined ? {} : { error: a.error }),
  };
}

export async function read(fetchFn = fetch, origin = SIGN, local = false, second = null) {
  const out = { origin, bundle: await readBundle(fetchFn, local), clusters: {} };
  for (const [name, c] of Object.entries(CLUSTERS)) {
    const providers = [];
    for (const url of second === null ? c.providers : [c.providers[0], second]) providers.push({ url, preflight: await preflight(url, origin, { fetchFn }), held: await balanceOf(fetchFn, url, origin, c.held), empty: await balanceOf(fetchFn, url, origin, EMPTY) });
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

/** The verdict on an answer (read()): PASS, FAIL on any wrong answer, else INCONCLUSIVE when a provider SIGN_HOST's
 *  origin may read gave no answer (provider-answer.mjs). A provider that refuses that origin is what the page gets, so it
 *  fails, whatever its answer's kind (pageRefuses); a lying provider can make this check FAIL or INCONCLUSIVE, never PASS. */
export function judge(a) {
  const lines = [];
  let quiet = false;
  const bad = (m) => lines.push(`BAD ${m}`);
  if (a?.origin !== SIGN) bad(`asked from ${String(a?.origin)}, not SIGN_HOST's origin ${SIGN}`);
  lines.push(...judgeBundle(a?.bundle).lines);
  for (const [name, c] of Object.entries(CLUSTERS)) {
    const got = a?.clusters?.[name];
    if (!got || got.held !== c.held || got.empty !== EMPTY || !Array.isArray(got.providers) || got.providers.length !== 2) {
      bad(`${name}: no read of the pair's two providers for its pool's accounts`);
      continue;
    }
    let all = true;
    got.providers.forEach((p, k) => {
      if (String(p.url).startsWith(HELPER)) bad(`${name}: the restore's U_X reads name our helper relay (${p.url})`);
      if (p.url !== c.providers[k]) bad(`${name}: provider ${k} is ${String(p.url)}, not ${c.providers[k]}`);
      // the preflight the page's browser sends before its POST (review P3-1): refused, the page reads nothing there
      let pre;
      try {
        pre = preflightRefuses(String(p.url), p.preflight, SIGN);
      } catch {
        pre = `${String(p.url)} is not a provider URL`;
      }
      if (pre !== null) {
        bad(`${name} ${p.url} preflight: ${pre}`);
        all = false;
      } else if (p.preflight?.noAnswer !== undefined) {
        lines.push(`NO ANSWER ${name} ${p.url} preflight: ${p.preflight.noAnswer}`);
        quiet = true;
        all = false;
      }
      for (const what of ["held", "empty"]) {
        const x = p[what];
        let refused;
        try {
          refused = pageRefuses(String(p.url), x, SIGN);
        } catch {
          refused = `${String(p.url)} is not a provider URL`;
        }
        if (refused !== null) {
          bad(`${name} ${p.url} ${what}: ${refused}`);
          all = false;
        } else if (x?.noAnswer !== undefined) {
          lines.push(`NO ANSWER ${name} ${p.url} ${what}: ${x.noAnswer}`);
          quiet = true;
          all = false;
        } else {
          if (x?.status !== 200) bad(`${name} ${p.url} ${what}: HTTP ${String(x?.status)}${x?.error ? ` ${JSON.stringify(x.error)}` : ""}`);
          if (!Number.isSafeInteger(x?.value)) bad(`${name} ${p.url} ${what}: no balance in its answer`);
        }
      }
    });
    // the pair's balances are judged once every read of both providers answered
    if (!all) continue;
    const [p, q] = got.providers;
    if (p.held?.value !== q.held?.value) bad(`${name}: the two providers give ${String(p.held?.value)} and ${String(q.held?.value)} for the program data account`);
    if (!(p.held?.value > 0)) bad(`${name}: the program data account reads no balance`);
    if (p.empty?.value !== 0 || q.empty?.value !== 0) bad(`${name}: the account no one holds reads ${String(p.empty?.value)} and ${String(q.empty?.value)}, not 0 on both`);
  }
  const verdict = verdictOf(lines.some((l) => l.startsWith("BAD ")), quiet);
  return { ok: verdict === "PASS", verdict, lines };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const answer = arg("--answer") ? JSON.parse(readFileSync(arg("--answer"), "utf8")) : await read(fetch, SIGN, process.argv.includes("--local"), arg("--with") ?? null);
    if (arg("--record")) writeFileSync(arg("--record"), `${JSON.stringify(answer, null, 1)}\n`);
    const v = judge(answer);
    for (const l of v.lines) console.log(l);
    console.log(`${v.verdict} ${KEY}${answer.bundle?.from === "local build" ? " (local build)" : ""}`);
    process.exit(EXIT[v.verdict]);
  } catch (e) {
    console.error(`ERROR ${KEY}: ${e?.message ?? e}`);
    process.exit(2);
  }
}
