// Removes each of src/trade/evm/buy.ts's checks, one at a time, and runs the test named for it in
// test/evm-pool-buy.test.ts or test/evm-pool-buy-hostile.test.ts: each named test passes on the code as it is and fails
// on every mutant. The file is changed in place and put back after each mutant (and checked to be back); exits 1 when a
// named test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in the file
// exactly once. R1-R14 are the evm-pool-buy-tx review's mutants (R10 moved with the digest's data check, now the hook
// data hex check); K1-K16 are the fold's (merge note M366).
//   node packages/kit/test/evm-pool-buy-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/trade/evm/buy.ts", import.meta.url));
const TESTS = ["./evm-pool-buy.test.ts", "./evm-pool-buy-hostile.test.ts"].map((f) => fileURLToPath(new URL(f, import.meta.url)));

const ROUTES = "each fork test's route builds";
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
  ["!Object.hasOwn(all, chain)", "!(chain in all)", "R7 "],
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
  ["const r = copyRoute(route);\n  const token = checkRoute(chain, r);", "const r = copyRoute(route);\n  const token = checkRoute(chain, copyRoute(route));", "F4 "],
  ['if (typeof h !== "object" || h === null) return refuse("bad_route", "a hop is an object");', "", "F5 "],
  ['if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");', "", "F5 "],
  ["if (!Number.isSafeInteger(n) || n > COPY_MAX)", "if (!Number.isSafeInteger(n))", "R8 "],
  ["const chainId = venueOf(buy.chain).chainId;", "const chainId = 8453;", VECTOR],
  ['if (typeof proof !== "object" || proof === null) return refuse("bad_amount", "the proof\'s values are an object");', "", KEY],
  // the venue list the checks and the signer read is frozen at every level, never a mutable copy (M366 (4))
  ["(venues ??= Object.freeze({", "(venues ??= ({", "V1 "],
  ["    base: Object.freeze({", "    base: ({", "V1 "],
  ["    robinhood: Object.freeze({", "    robinhood: ({", "V1 "],
  ['middles: Object.freeze(["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"])', 'middles: (["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"])', "V1 "],
  ['middles: Object.freeze(["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"])', 'middles: (["0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"])', "V1 "],
  ["Object.freeze({ chain, adapter, data: toHex(data), minOut, token })", "({ chain, adapter, data: toHex(data), minOut, token })", "F2b "],
  ["const p = { nullifier: proof.nullifier, context: proof.context, value: proof.value };", "const p = proof;", "F4b "],
];

// "pass", "fail" or "none" (no test ran) of the tests whose names start with `name`
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, ...TESTS];
  try {
    const out = execFileSync("node", args, { stdio: "pipe", encoding: "utf8" });
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
      console.log(`FAIL mutant ${i + 1}: its text is not in buy.ts exactly once`);
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
    if (readFileSync(SRC, "utf8") !== src) throw new Error(`mutant ${i + 1} left buy.ts changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
