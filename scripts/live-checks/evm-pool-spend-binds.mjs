#!/usr/bin/env node
// Live check of card evm-pool-spend-binds: on SIGN_HOST (https://confidential.unrealized.trade) a Base or Robinhood
// proof's fee read walks past a provider the browser cannot reach. In the owner's browser publicnode and Pocket never
// connect (Firefox's strict protection, 14 Nov); each such seat of the fee walk was asked again inside the seat (the
// pool read's throttle waits), two of them spent the walk's whole 8 s, and the period's fee was never read, so no proof
// was made: "no two operators answered in 8000 ms (side 1: base-rpc.publicnode.com ...; base.api.pocket.network ...)"
// (the mainnet probe packages/signpage/scripts/evm-pass-reads-mainnet.mjs --owners-case, 15 Nov 01:16Z). What the walk
// does is held by packages/wallet/test/pool-evm.test.ts (card evm-pool-spend-binds); this check holds that SIGN_HOST
// serves that code. It passes only when SIGN_HOST's served /app.js is the one its index.html pins (its sha384), and in
// it, as minified:
//   - seat (packages/wallet/src/pool/evm.ts walkSeat), exactly once: a seat's call whose fault "network" is thrown as
//     the walk's answer at once (`e?.name===\`SolanaRpcTransportError\`&&e.fault===\`network\`?new X(String(e.message),e):e`),
//     the call's signal handed to its provider (card kit-rpc-client-takes-a-signal: the walk's cut ends the request
//     at the provider too, so the seat takes three arguments and passes all three on);
//   - used: that seat wraps both walk reads, the pool's size and the chain fee at the period's first block, exactly
//     twice in all.
// After: sign
// Bundle: read sign
//   node scripts/live-checks/evm-pool-spend-binds.mjs [--local] [--record <file>]
//   PASS exit 0, FAIL 1, error 2. --local judges this tree's SIGN_HOST build (signBuilt) in SIGN_HOST's place; --record
//   writes what the run read, which evm-pool-spend-binds.test.mjs replays. Reads only.
import "../net-window.mjs";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signBuilt } from "../signpage-built.mjs";

export const KEY = "evm-pool-spend-binds";
export const SIGN = "https://confidential.unrealized.trade";

const N = "[\\w$]+";
const sha384 = (s) => `sha384-${createHash("sha384").update(s).digest("base64")}`;
const esc = (s) => s.replace(/[$]/g, "\\$");

/** walkSeat as minified (card kit-rpc-client-takes-a-signal: the call's method, params and signal, all three passed on):
 *  `var Lk=e=>Object.assign(async(t,n,r)=>{try{return await e(t,n,r)}catch(e){throw
 *  e?.name===\`SolanaRpcTransportError\`&&e.fault===\`network\`?new qO(String(e.message),e):e}},{url:e.url})`. A seat
 *  that drops the signal (`e(t,n)`) is no seat here: the walk's cut would end the wait and leave the request open. */
const SEAT = new RegExp(`(${N})=(${N})=>Object\\.assign\\(async\\((${N}),(${N}),(${N})\\)=>\\{try\\{return await \\2\\(\\3,\\4,\\5\\)\\}catch\\((${N})\\)\\{throw \\6\\?\\.name===\`SolanaRpcTransportError\`&&\\6\\.fault===\`network\`\\?new ${N}\\(String\\(\\6\\.message\\),\\6\\):\\6\\}\\},\\{url:\\2\\.url\\}\\)`, "g");

/** What the check keeps of SIGN_HOST's build: its pin and sha384, the seat found once, and its uses. */
export function pageFacts(index, js) {
  const seats = [...js.matchAll(SEAT)];
  const name = seats.length === 1 ? seats[0][1] : null;
  const uses = name === null ? 0 : [...js.matchAll(new RegExp(`[^\\w$]${esc(name)}\\(${N}\\)`, "g"))].length;
  return {
    pin: /src="\/app\.js" integrity="([^"]+)"/.exec(index)?.[1] ?? null,
    sha384: sha384(js),
    seat: seats.length === 1,
    uses,
  };
}

/** SIGN_HOST's index and /app.js through `fetchFn`: { from, page }. */
export async function readBundle(fetchFn = fetch) {
  const get = async (p) => {
    const r = await fetchFn(`${SIGN}${p}`, { redirect: "error" });
    if (r.status !== 200) throw new Error(`SIGN_HOST ${p}: HTTP ${r.status}`);
    return r.text();
  };
  return { from: SIGN, page: pageFacts(await get("/"), await get("/app.js")) };
}

/** The verdict on { page }: { ok, verdict, lines }. */
export function judge(run) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);
  const p = run?.page;
  say(typeof p?.pin === "string" && p.pin === p.sha384, `[SIGN_HOST] the served /app.js is the one index.html pins: ${p?.pin ?? "no pin"}`);
  say(p?.seat === true, "[SIGN_HOST] a fee walk's seat that does not connect is its answer at once (seat)");
  say(p?.uses === 2, `[SIGN_HOST] that seat wraps both fee walk reads, the pool's size and the chain fee (used ${p?.uses ?? 0} times, want 2)`);
  const verdict = lines.some((l) => l.startsWith("BAD")) ? "FAIL" : "PASS";
  return { ok: verdict === "PASS", verdict, lines };
}

/** SIGN_HOST's index and /app.js, or this tree's build with `local`. */
export async function read(fetchFn = fetch, { local = false } = {}) {
  const page = local ? pageFacts(readFileSync(path.join(signBuilt(), "index.html"), "utf8"), readFileSync(path.join(signBuilt(), "public/app.js"), "utf8")) : (await readBundle(fetchFn)).page;
  return { readAt: new Date().toISOString(), from: local ? "local build" : SIGN, page };
}

if (realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2);
  try {
    const run = await read(fetch, { local: a.includes("--local") });
    if (a.includes("--record")) writeFileSync(a[a.indexOf("--record") + 1], `${JSON.stringify(run, null, 1)}\n`);
    const { verdict, lines } = judge(run);
    for (const l of lines) console.log(l);
    console.log(`live-check ${KEY}: ${verdict}`);
    process.exit(verdict === "PASS" ? 0 : 1);
  } catch (e) {
    console.error(`live-check ${KEY}: ERROR: ${e.message}`);
    process.exit(2);
  }
}
