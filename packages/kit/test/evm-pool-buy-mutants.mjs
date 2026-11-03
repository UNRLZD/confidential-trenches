// Removes each of src/trade/evm/buy.ts's checks, one at a time, and runs the test named for it in
// test/evm-pool-buy.test.ts: each named test passes on the code as it is and fails on every mutant. The file is changed
// in place and put back after each mutant (and checked to be back); exits 1 when a named test passes on its mutant,
// fails on the code as it is, or a mutant's text is not in the file exactly once.
//   node packages/kit/test/evm-pool-buy-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/trade/evm/buy.ts", import.meta.url));
const TEST = fileURLToPath(new URL("./evm-pool-buy.test.ts", import.meta.url));

const ROUTES = "each fork test's route builds";
const HOOKED = "a hooked hop with hook data";
const INFO1 = "INFO-1";
const INFO2 = "INFO-2";
const SHAPE = "a route of the wrong shape";
const BUILD = "the buy takes minOut above 0";
const VECTOR = "W's Buy signature equals the pool's own vector";
const SIGS = "W's signatures are 65 bytes";
const KEY = "only W's own key signs";

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
  ["minOut <= 0n || minOut >= 1n << 256n) return refuse(\"bad_amount\", \"minOut is a uint256 above 0\");\n  const { data, token }", "minOut < 0n || minOut >= 1n << 256n) return refuse(\"bad_amount\", \"minOut is a uint256 above 0\");\n  const { data, token }", BUILD],
  ['if (proof.value === 0n) return refuse("bad_amount", "value is above 0");', "", KEY],
  ["word(proof.context), word(proof.value)", "word(proof.context), word(0n)", VECTOR],
  ["word(proof.nullifier), word(proof.context)", "word(proof.nullifier), word(proof.nullifier)", VECTOR],
  ['keccak_256(new TextEncoder().encode("Blindfill"))', 'keccak_256(new TextEncoder().encode("Blindfil"))', VECTOR],
  ["word(BigInt(chainId)), addressWord(pool)", "word(BigInt(chainId)), addressWord(buy.adapter)", VECTOR],
  ["addressWord(buy.adapter), keccak_256(data)", "addressWord(buy.token), keccak_256(data)", VECTOR],
  ["out[64] = 27 + rec[0]!;", "out[64] = rec[0]!;", SIGS],
  ["{ prehash: false, lowS: true, format: \"recovered\" }", "{ prehash: false, lowS: false, format: \"recovered\" }", SIGS],
  ['if (!isAddress(recipient) || addressOf(secretKey) !== lower(recipient)) return refuse("bad_key", "W\'s key is not the recipient\'s");', "", KEY],
];

// "pass" or "fail" of the test whose name starts with `name`
function run(name) {
  try {
    execFileSync("node", ["--test", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, TEST], { stdio: "pipe" });
    return "pass";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = readFileSync(SRC, "utf8");
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[2]))) {
    if (run(t) !== "pass") {
      console.log(`FAIL "${t}" fails on the code as it is`);
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
