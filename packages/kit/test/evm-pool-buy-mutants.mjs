// Removes each of src/trade/evm/buy-unpinned.ts's checks, one at a time, and runs the test named for it in
// test/evm-pool-buy.test.ts, test/evm-pool-buy-hostile.test.ts or test/evm-venues-pin.test.ts: each named test passes on the code as it is and fails
// on every mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs), never the kit's own, and put back after each mutant (and checked to be back); exits 1 when a
// named test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in the file
// exactly once. R1-R14 are the evm-pool-buy-tx review's mutants (R10 moved with the digest's data check, now the hook
// data hex check); K1-K16 are the fold's (merge note M366).
//   node packages/kit/test/evm-pool-buy-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIT, kitCopy } from "./mutant-copy.mjs";

// the sweep runs in a copy of the kit; imported (for its MUTANTS), the paths are the kit's own
const BASE = process.argv[1] === fileURLToPath(import.meta.url) ? kitCopy() : KIT;
const at = (rel) => path.join(BASE, rel);

const SRC = at("src/trade/evm/buy-unpinned.ts");
const TESTS = ["./evm-pool-buy.test.ts", "./evm-pool-buy-hostile.test.ts", "./evm-venues-pin.test.ts"].map((f) => at(`test/${f.slice(2)}`));

const ROUTES = "each fork test's route builds";
const PINS = "the testnet chains' pins are";
const BUYPIN = "a buy builds only through";
const SELLPIN = "a sell pays only into";
const HOOKED = "a hooked hop with hook data";
const INFO1 = "INFO-1";
const INFO2 = "INFO-2";
const SHAPE = "a route of the wrong shape";
const BUILD = "the buy takes minOut above 0";
const VECTOR = "W's Buy signature equals cast's EIP-712 signature";
const SIGS = "W's signatures are 65 bytes";
const KEY = "only a 32-byte key signs";
const P1 = "P1 ";

// [text, replacement, the test that must fail]
export const MUTANTS = [
  // INFO-1 and INFO-2
  ['if (tokens.slice(1).some((t) => lower(t) === weth)) return refuse("weth_after_first", "WETH may only start a route");', "", INFO1],
  ["tokens.slice(1).some((t) => lower(t) === weth)", "tokens.slice(2).some((t) => lower(t) === weth)", INFO1],
  ['for (const t of tokens.slice(1, -1)) if (!listed.has(lower(t))) refuse("middle_not_listed", `${t} is not on the venue list`);', "", INFO2],
  ["for (const t of tokens.slice(1, -1))", "for (const t of tokens.slice(1, -2))", INFO2],
  // the route's shape
  ["fees.length < 1 || fees.length > EVM_POOL_MAX_HOPS ||", "fees.length < 1 ||", SHAPE],
  ["|| t.length !== fees.length + 1)", ")", SHAPE],
  ['for (const f of fees) if (!Number.isInteger(f) || f < 0 || f > U24) refuse("bad_route", "a v3 fee is a u24");', "", SHAPE],
  ['if (lower(tokens[0]!) !== lower(venue.weth)) return refuse("bad_route", "a v3 route starts at the chain\'s WETH");', "", SHAPE],
  ["hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS", "hops.length < 1", SHAPE],
  ["(lower(currencyIn) !== NATIVE && lower(currencyIn) !== lower(venue.weth))", "false", SHAPE],
  ["if (!Number.isInteger(h.fee) || h.fee < 0 || h.fee > U24)", "if (false)", SHAPE],
  ["h.tickSpacing < 1 ||", "", SHAPE],
  ["|| h.tickSpacing > MAX_TICK_SPACING", "", SHAPE],
  ["if (hexBytes(h.hookData).length > EVM_POOL_MAX_HOOK_DATA)", "if (false)", SHAPE],
  // card evm-buy-hookdata-fee: a quoted buy's hook data is the device's own, none; an unquoted route (not signed by the
  // index) still encodes any
  ['if (quoted && h.hookData !== "0x") refuse(', "if (false) refuse(", "HD2 "],
  ['if (quoted && h.hookData !== "0x") refuse(', 'if (h.hookData !== "0x") refuse(', HOOKED],
  ["if (!isAddress(h.currency) || !isAddress(h.hooks))", "if (false)", SHAPE],
  ['if (lower(out) === NATIVE || lower(out) === lower(tokens[tokens.length - 2]!)) return refuse("bad_route", "the route buys no token");', "", SHAPE],
  // the encodings
  ["Uint8Array.of(f >> 16, (f >> 8) & 0xff, f & 0xff)", "Uint8Array.of(f & 0xff, (f >> 8) & 0xff, f >> 16)", ROUTES],
  ["word(0xa0n)", "word(0x80n)", ROUTES],
  ["const padded = new Uint8Array(Math.ceil(d.length / 32) * 32);", "const padded = new Uint8Array(d.length);", HOOKED],
  ["let at = 32 * elems.length;", "let at = 0;", ROUTES],
  // the buy and W's signature
  ["minOut <= 0n || minOut >= 1n << 256n) return refuse(\"bad_amount\", \"minOut is a uint256 above 0\");\n  const { data, token: buys }", "minOut < 0n || minOut >= 1n << 256n) return refuse(\"bad_amount\", \"minOut is a uint256 above 0\");\n  const { data, token: buys }", BUILD],
  ['if (p.value === 0n) return refuse("bad_amount", "value is above 0");', "", KEY],
  ["word(p.context), word(p.value)", "word(p.context), word(0n)", VECTOR],
  ["word(p.nullifier), word(p.context)", "word(p.nullifier), word(p.nullifier)", VECTOR],
  ['keccak_256(new TextEncoder().encode("Blindfill"))', 'keccak_256(new TextEncoder().encode("Blindfil"))', VECTOR],
  ["word(BigInt(chainId)), addressWord(pool)", "word(BigInt(chainId)), addressWord(buy.adapter)", VECTOR],
  ["addressWord(buy.adapter), keccak_256(hexBytes(buy.data))", "addressWord(buy.token), keccak_256(hexBytes(buy.data))", VECTOR],
  ["out[64] = 27 + rec[0]!;", "out[64] = rec[0]!;", SIGS],
  ["{ prehash: false, lowS: true, format: \"recovered\" }", "{ prehash: false, lowS: false, format: \"recovered\" }", SIGS],
  // the review's mutants (evm-pool-buy-tx, ee348ad)
  ['if (!tokens.every(isAddress)) return refuse("bad_route", "a token is not an address");', "", "R1 "],
  ["if (!isAddress(adapter) || lower(adapter) === NATIVE)", "if (lower(adapter) === NATIVE)", "R2 "],
  ["if (!isAddress(pool) || lower(pool) === NATIVE)", "if (lower(pool) === NATIVE)", "R3 "],
  ['v < 0n || v >= FIELD_P) refuse("bad_amount"', 'v < 0n) refuse("bad_amount"', "R4 "],
  ["/^0x[0-9a-fA-F]{40}$/", "/^0x[0-9a-fA-F]{40}/", "R5 "],
  ["(at += e.length)", "(at += 192)", P1],
  ['if (!Array.isArray(a)) return refuse("bad_route", "a route\'s tokens, fees and hops are lists");', "", "R8 "],
  ["word(BigInt(d.length)), padded", "word(BigInt(padded.length)), padded", HOOKED],
  ['!/^0x([0-9a-fA-F]{2})*$/.test(h)) return refuse("bad_route", "hook data is not 0x hex")', '!h.startsWith("0x")) return refuse("bad_route", "hook data is not 0x hex")', P1],
  ["const U24 = 0xffffff;", "const U24 = 0x7fffff;", P1],
  ["if (hexBytes(h.hookData).length > EVM_POOL_MAX_HOOK_DATA)", "if (hexBytes(h.hookData).length >= EVM_POOL_MAX_HOOK_DATA)", SHAPE],
  ["out.set(rec.slice(1, 65), 0);", "out.set(rec.slice(0, 64), 0);", SIGS],
  ["Uint8Array.of(f >> 16, (f >> 8) & 0xff, f & 0xff)", "Uint8Array.of((f >> 16) & 0x7f, (f >> 8) & 0xff, f & 0xff)", P1],
  // the fold's (M366): the user's token, only built buys for their chain, one frozen copy, refusals not TypeErrors
  ['if (lower(buys) !== lower(token)) return refuse("token_mismatch", `the route buys ${buys}, not ${token}`);', "", "F1 "],
  ["if (!BUILT.has(built) || built.chain !== chain)", "if (built.chain !== chain)", "F2b "],
  ["if (!BUILT.has(built) || built.chain !== chain)", "if (!BUILT.has(built))", "F3 "],
  ["const r = copyRoute(route);\n  const token = checkRoute(chain, r, quoted);", "const r = copyRoute(route);\n  const token = checkRoute(chain, copyRoute(route), quoted);", "F4 "],
  ['if (typeof h !== "object" || h === null) return refuse("bad_route", "a hop is an object");', "", "F5 "],
  ['if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");', "", "F5 "],
  ["if (!Number.isSafeInteger(n) || n > COPY_MAX)", "if (!Number.isSafeInteger(n))", "R8 "],
  ["const chainId = venueOf(buy.chain).chainId;", "const chainId = 8453;", VECTOR],
  ['if (typeof proof !== "object" || proof === null) return refuse("bad_amount", "the proof\'s values are an object");', "", KEY],
  // the venue list the checks and the signer read is frozen at every level, never a mutable copy (M366 (4))
  ["(venues ??= bare({", "(venues ??= ({", "V1 "],
  ["    base: bare({", "    base: ({", "V1 "],
  ["    robinhood: bare({", "    robinhood: ({", "V1 "],
  ['middles: Object.freeze(["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"])', 'middles: (["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"])', "V1 "],
  ['middles: Object.freeze(["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"])', 'middles: (["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"])', "V1 "],
  ["Object.freeze({ chain, adapter, data: toHex(data), minOut, token })", "({ chain, adapter, data: toHex(data), minOut, token })", "F2b "],
  ["const p = { nullifier: proof.nullifier, context: proof.context, value: proof.value };", "const p = proof;", "F4b "],
  // the pins (M370): the chain's adapter for the route's venue, the chain's pool, a buy through a pinned adapter
  ['if (pin === undefined) return refuse("not_deployed", `${chain} has no pinned ${r.venue} adapter yet`);', "", "M370 a pinned build"],
  ['if (!samePin(adapter, pin)) return refuse("not_pinned", `the adapter is not ${chain}\'s pinned ${r.venue} adapter`);', "", "M370 a pinned build"],
  ['const pin = r.venue === "uniswap-v3" ? v.v3 : v.v4;', 'const pin = r.venue === "uniswap-v3" ? v.v4 : v.v3;', "M370 a pinned build"],
  // the quoted pinned build (buy.ts evmPoolBuildQuoted) admits a v4 route through a middle that is not listed
  ["return pinnedBuild(venues, chain, adapter, route, minOut, token, true);", "return pinnedBuild(venues, chain, adapter, route, minOut, token, false);", "Q1 "],
  ["return evmPoolBuildUnpinned(chain, adapter, r, minOut, token, quoted);", "return evmPoolBuildUnpinned(chain, adapter, r, minOut, token);", "Q1 "],
  ["return evmPoolBuildUnpinned(chain, adapter, r, minOut, token, quoted);", "return evmPoolBuildUnpinned(chain, adapter, route, minOut, token, quoted);", "M370 a pinned build"],
  ['if (v.pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool yet`);', "", "M370 a pinned signature"],
  ['if (!samePin(pool, v.pool)) return refuse("not_pinned", `the pool is not ${chain}\'s pinned pool`);', "", "M370 a pinned signature"],
  ["if (BUILT.has(built) && !((v.v3 !== undefined && samePin(built.adapter, v.v3)) || (v.v4 !== undefined && samePin(built.adapter, v.v4)))) {", "if (false) {", "M370 a pinned signature"],
  // no read of a pin reaches Object.prototype (the review of 8d8675d): the list has no prototype at any level, and a pin
  // is an own key only
  ["(venues ??= bare({", "(venues ??= Object.freeze({", "M370 a polluted Object.prototype names no adapter"],
  ["    base: bare({", "    base: Object.freeze({", "M370 a polluted Object.prototype names no adapter"],
  ["    robinhood: bare({", "    robinhood: Object.freeze({", "M370 a polluted Object.prototype names no adapter"],
  ["Object.freeze(Object.assign(Object.create(null) as T, o))", "Object.freeze(Object.assign({} as T, o))", "M370 a polluted Object.prototype names no adapter"],
  ['if (typeof o !== "object" || o === null || !Object.hasOwn(o, k)) return undefined;', 'if (typeof o !== "object" || o === null) return undefined;', "M370 a polluted Object.prototype names no adapter"],
  ['Object.hasOwn(v, "adapters") ? v.adapters : undefined', '"adapters" in v ? v.adapters : undefined', "M370 a polluted Object.prototype names no adapter"],
  ['pool: ownPin(v, "pool")', "pool: (v as { pool?: string }).pool", "M370 a polluted Object.prototype names no adapter"],
  ['v3: ownPin(adapters, "v3")', "v3: (adapters as { v3?: string } | undefined)?.v3", "M370 a polluted Object.prototype names no adapter"],
  ['v4: ownPin(adapters, "v4")', "v4: (adapters as { v4?: string } | undefined)?.v4", "M370 a polluted Object.prototype names no adapter"],
  ['if (typeof chain !== "string" || !Object.hasOwn(venues, chain)) return refuse("bad_route", "no such chain");', "", "M370 a pinned build"],
  // the testnet pins (card evm-venues-pin): each one changed is refused by the kit's own build or signature
  ['pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe5"', 'pool: "0xb239a38af69b68e6c5c305df64985f283b5d5fe6"', BUYPIN],
  ['v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645"', 'v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5646"', BUYPIN],
  ['v4: "0x706b3f75e80be70494d1414b85788462bfeb7eb1"', 'v4: "0x706b3f75e80be70494d1414b85788462bfeb7eb2"', BUYPIN],
  ['sellDelegate: "0xfa1442419b6984b8e3aa8933c690f80f063b6adf"', 'sellDelegate: "0xfa1442419b6984b8e3aa8933c690f80f063b6ade"', SELLPIN],
  ['pool: "0xe5e948414a89c23e73d76cd740dacdd9364c25d5"', 'pool: "0xe5e948414a89c23e73d76cd740dacdd9364c25d6"', BUYPIN],
  ['adapters: bare({ v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797" })', 'adapters: bare({ v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669798" })', BUYPIN],
  ['adapters: bare({ v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797" })', 'adapters: bare({ v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645", v4: "0x6c43a39fcb2ea65f47625ef5ce5fea98fc669797" })', BUYPIN],
  ['sellDelegate: "0xaafb86fed9b651933773a0750d5dba22ca8b8a02"', 'sellDelegate: "0xaafb86fed9b651933773a0750d5dba22ca8b8a03"', SELLPIN],
  ["chainId: 84532,", "chainId: 8453,", PINS],
  ["chainId: 46630,", "chainId: 4663,", PINS],
  ['routers: Object.freeze(["0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4"])', 'routers: Object.freeze(["0x94cc0aac535ccdb3c01d6787d6413c739ae12bc5"])', PINS],
  ["routers: Object.freeze([]),", 'routers: Object.freeze(["0x94cc0aac535ccdb3c01d6787d6413c739ae12bc4"]),', SELLPIN],
  ['    "base-sepolia": bare({', '    "base-sepolia": ({', PINS],
  ['adapters: bare({ v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645"', 'adapters: ({ v3: "0xee89916bc4bdeee46dbcaf8fad2b7604724b5645"', PINS],
  // the testnet WETH and middles (the review of c473b3d, F2)
  ['chainId: 84532,\n      weth: "0x4200000000000000000000000000000000000006",\n      middles: Object.freeze([]),', 'chainId: 84532,\n      weth: "0x4200000000000000000000000000000000000006",\n      middles: Object.freeze(["0x036CbD53842c5426634e7929541eC2318f3dCF7e"]),', PINS],
  ['weth: "0x7943e237c7f95da44e0301572d358911207852fa",', 'weth: "0x7943e237c7f95da44e0301572d358911207852fb",', PINS],
  ['middles: Object.freeze([]),\n      // no Uniswap v3 on Robinhood testnet', 'middles: Object.freeze(["0x036CbD53842c5426634e7929541eC2318f3dCF7e"]),\n      // no Uniswap v3 on Robinhood testnet', PINS],
];

// a child test run must not inherit this process's own node --test context (when the sweep runs as a test, the child
// would report to the parent's runner and print no summary of its own)
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
// "pass", "fail" or "none" (no test ran) of the tests whose names start with `name`
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, ...TESTS];
  try {
    const out = execFileSync("node", args, { stdio: "pipe", encoding: "utf8", env: CHILD_ENV });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = readFileSync(SRC, "utf8");
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[2]))) {
    const r = run(t);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([find, repl, t], i) => {
    if (src.split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in buy-unpinned.ts exactly once`);
      bad++;
      return;
    }
    writeFileSync(SRC, src.replace(find, repl));
    let r;
    try {
      r = run(t);
    } finally {
      writeFileSync(SRC, src);
    }
    if (readFileSync(SRC, "utf8") !== src) throw new Error(`mutant ${i + 1} left buy-unpinned.ts changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
