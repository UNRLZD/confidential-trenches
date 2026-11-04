// Removes each of src/trade/evm/sell-unpinned.ts's checks (and the router list in buy-unpinned.ts's venue list, its
// PathKey[] encoding and the testnet PoolManager pins), one at a time, and runs
// the test named for it in test/evm-pool-sell.test.ts: each named test passes on the code as it is and fails on every
// mutant. The file is changed in a copy of the kit (test/mutant-copy.mjs), never the kit's own, and put back after each mutant (and checked to be back); exits 1 when a named
// test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly
// once.
//   node packages/kit/test/evm-pool-sell-mutants.mjs     (a heavy job: run it on a machine with spare cores)
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KIT, kitCopy } from "./mutant-copy.mjs";

// the sweep runs in a copy of the kit; imported (for its MUTANTS), the paths are the kit's own
const BASE = process.argv[1] === fileURLToPath(import.meta.url) ? kitCopy() : KIT;
const at = (rel) => path.join(BASE, rel);

const SELL = at("src/trade/evm/sell-unpinned.ts");
const BUY = at("src/trade/evm/buy-unpinned.ts");
const TEST = at("test/evm-pool-sell.test.ts");

const CAST = "the swap data equals cast calldata";
const AUTH = "W's EIP-7702 authorization equals cast";
const SWAP = "the swap data is W's swap";
const TARGET = "the target must be on";
const ROUTE = "the route sells the token";
const DEADLINE = "the deadline is unix seconds";
const FEE = "the fee cap is above 0";
const RANGE = "amount, minOut, precommitment and nonce";
const SIGNER = "W signs only a sell the builder returned";
const SIGS = "W's Sell signatures are 65 bytes";
const AUTHIN = "W's authorization takes a delegate";
const ONCE = "the request and its route are read once";
const FROZEN = "the router lists are frozen";
const REVIEW = "checks the review's mutants passed";
const FIXTURE = "the fork fixture is the kit's own output";
const PINPOOL = "M370 a pinned sell";
const PINAUTH = "M370 W's authorization";
const V4CAST = "a v4 sell's data is SellDelegate's PathKey[]";
const V4 = "planted: a v4 sell";

// [file, text, replacement, the test that must fail]
export const MUTANTS = [
  // the router list
  [SELL, "if (!venue.routers.some((r) => lower(r) === lower(target))) return refuse(", "if (false) return refuse(", TARGET],
  [SELL, 'if (!isAddress(target)) return refuse("bad_target", `${target} is not an address`);', "", TARGET],
  [BUY, 'routers: Object.freeze(["0x2626664c2603336E57B271c5C0b26F421741e481"])', 'routers: (["0x2626664c2603336E57B271c5C0b26F421741e481"])', FROZEN],
  [BUY, 'routers: Object.freeze(["0xCaf681a66D020601342297493863E78C959E5cb2"])', 'routers: (["0xCaf681a66D020601342297493863E78C959E5cb2"])', FROZEN],
  [BUY, 'routers: Object.freeze(["0x2626664c2603336E57B271c5C0b26F421741e481"])', 'routers: Object.freeze(["0x2626664c2603336E57B271c5C0b26F421741e481", "0x2222222222222222222222222222222222222222"])', TARGET],
  // the swap data: W's swap of the amount, the router's minimum minOut
  [SELL, "addressWord(w), word(amount), word(minOut)", "addressWord(target), word(amount), word(minOut)", SWAP],
  [SELL, "addressWord(w), word(amount), word(minOut)", "addressWord(w), word(amount - 1n), word(minOut)", SWAP],
  [SELL, "addressWord(w), word(amount), word(minOut)", "addressWord(w), word(amount), word(1n)", SWAP],
  [SELL, 'utf8("exactInput((bytes,address,uint256,uint256))")', 'utf8("exactInput((bytes,address,uint256,uint256,uint256))")', CAST],
  [SELL, "word(0x20n), word(0x80n)", "word(0x20n), word(0xa0n)", CAST],
  [SELL, "const padded = new Uint8Array(Math.ceil(p.length / 32) * 32);", "const padded = new Uint8Array(p.length);", CAST],
  [SELL, "Uint8Array.of(x >> 16, (x >> 8) & 0xff, x & 0xff)", "Uint8Array.of(x & 0xff, (x >> 8) & 0xff, x >> 16)", CAST],
  // the route
  [SELL, 'if (kind !== "uniswap-v3") return refuse("bad_route", "a sell runs on Uniswap v3\'s SwapRouter02 or v4\'s PoolManager");', "", ROUTE],
  [SELL, "fees.length < 1 || fees.length > EVM_POOL_MAX_HOPS ||", "fees.length < 1 ||", ROUTE],
  [SELL, "|| tokens.length !== fees.length + 1)", ")", ROUTE],
  [SELL, 'for (const x of fees) if (!Number.isInteger(x) || (x as number) < 0 || (x as number) > U24) refuse("bad_route", "a fee is a u24");', "", ROUTE],
  [SELL, 'if (!tokens.every(isAddress)) return refuse("bad_route", "a token is not an address");', "", ROUTE],
  [SELL, 'if (lower(path[0]!) !== lower(token)) return refuse("token_mismatch", `the route sells ${path[0]}, not ${token}`);', "", ROUTE],
  [SELL, 'if (lower(path[path.length - 1]!) !== weth) return refuse("bad_route", "a sell ends at the chain\'s WETH");', "", ROUTE],
  [SELL, 'if (path.slice(0, -1).some((x) => lower(x) === weth)) return refuse("bad_route", "WETH may only end a sell");', "", ROUTE],
  [SELL, 'for (const x of path.slice(1, -1)) if (!listed.has(lower(x))) refuse("middle_not_listed", `${x} is not on the venue list`);', "", ROUTE],
  [SELL, 'for (let i = 1; i < path.length; i++) if (lower(path[i]!) === lower(path[i - 1]!)) refuse("bad_route", "a hop buys what it spends");', "", ROUTE],
  [SELL, 'if (typeof route !== "object" || route === null) return refuse("bad_route", "a route is an object");', "", ROUTE],
  [SELL, 'if (!Array.isArray(a)) return refuse("bad_route", "a route\'s tokens and fees are lists");', "", ROUTE],
  [SELL, 'if (!isWallet(token) || lower(token) === lower(venue.weth))', "if (!isWallet(token))", ROUTE],
  // the deadline
  [SELL, "deadline < BigInt(t + EVM_POOL_SELL_DEADLINE_MIN_S) ||", "", DEADLINE],
  [SELL, "|| deadline > BigInt(t + EVM_POOL_SELL_DEADLINE_MAX_S)) {", ") {", DEADLINE],
  [SELL, 'if (typeof deadline !== "bigint" ||', "if (", DEADLINE],
  [SELL, "export const EVM_POOL_SELL_DEADLINE_MAX_S = 600;", "export const EVM_POOL_SELL_DEADLINE_MAX_S = 3600;", DEADLINE],
  [SELL, "const t = Math.floor(Date.now() / 1000);", "const t = Date.now();", DEADLINE],
  // the fee cap, the amounts, the addresses, the chain
  [SELL, "feeCap === 0n || feeCap >= minOut", "feeCap >= minOut", FEE],
  [SELL, "feeCap === 0n || feeCap >= minOut", "feeCap === 0n || feeCap > minOut", FEE],
  [SELL, 'if (!isUint(amount, U256) || amount === 0n)', "if (!isUint(amount, U256))", RANGE],
  [SELL, 'if (!isUint(minOut, U256) || minOut === 0n)', "if (!isUint(minOut, U256))", RANGE],
  [SELL, "if (!isUint(precommitment, FIELD_P))", "if (!isUint(precommitment, U256))", RANGE],
  [SELL, 'if (!isUint(nonce, U256)) return refuse("bad_amount", "the nonce is a uint256");', "", RANGE],
  [SELL, 'if (!isWallet(w)) return refuse("bad_route", "W is not an address");', "", RANGE],
  [SELL, 'if (!isWallet(pool)) return refuse("bad_route", "the pool is not an address");', "", RANGE],
  [SELL, 'if (typeof req !== "object" || req === null) return refuse("bad_route", "a sell request is an object");', "", RANGE],
  // W's Sell signature
  [SELL, "if (!BUILT.has(built) || built.chain !== chain)", "if (built.chain !== chain)", SIGNER],
  [SELL, "if (!BUILT.has(built) || built.chain !== chain)", "if (!BUILT.has(built))", SIGNER],
  [SELL, "Object.freeze({ chain, w, token, amount, target, data, minOut, pool, precommitment, feeCap, deadline, nonce })", "({ chain, w, token, amount, target, data, minOut, pool, precommitment, feeCap, deadline, nonce })", SIGNER],
  [SELL, 'if (addressOf(secretKey) !== lower(built.w)) return refuse("bad_key", "the key is not W\'s");', "", SIGNER],
  [SELL, "      word(BigInt(chainId)),\n      addressWord(built.w),", "      word(BigInt(chainId)),\n      addressWord(built.pool),", CAST],
  [SELL, "const chainId = venueOf(built.chain).chainId;", "const chainId = 8453;", CAST],
  [SELL, 'uint256 feeCap,uint256 deadline,uint256 nonce)"),', 'uint256 feeCap,uint256 nonce,uint256 deadline)"),', CAST],
  [SELL, "      word(built.deadline),\n      word(built.nonce),", "      word(built.nonce),\n      word(built.deadline),", CAST],
  [SELL, "keccak_256(fromHex(built.data))", "keccak_256(utf8(built.data))", CAST],
  [SELL, "out[64] = 27 + rec[0]!;", "out[64] = rec[0]!;", SIGS],
  [SELL, '{ prehash: false, lowS: true, format: "recovered" });\n  // noble', '{ prehash: false, lowS: false, format: "recovered" });\n  // noble', SIGS],
  [SELL, "const { w, token, amount, target, route, minOut, pool, precommitment, feeCap, deadline, nonce } = req;", "const { w, token, amount, route, minOut, pool, precommitment, feeCap, deadline, nonce } = req;\n  const target = req.target;\n  void req.target;", ONCE],
  // W's authorization
  [SELL, "const items = concat(rlpUint(BigInt(chainId)),", "const items = concat(rlpUint(0n),", AUTH],
  [SELL, "keccak_256(concat(Uint8Array.of(0x05, 0xc0 + items.length), items))", "keccak_256(concat(Uint8Array.of(0x04, 0xc0 + items.length), items))", AUTH],
  [SELL, "return b.length === 1 && b[0]! < 0x80 ? Uint8Array.of(b[0]!)", "return false ? Uint8Array.of(b[0]!)", AUTH],
  [SELL, "if (v === 0n) return Uint8Array.of(0x80);", "if (v === 0n) return Uint8Array.of(0x00);", AUTH],
  [SELL, "if (!isUint(nonce, U64 - 1n))", "if (!isUint(nonce, U64))", AUTHIN],
  [SELL, 'if (!isWallet(delegate)) return refuse("bad_route", "the delegate is not an address");', "", AUTHIN],
  [SELL, 'const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" });', 'const rec = secp256k1.sign(digest, secretKey, { prehash: false, lowS: false, format: "recovered" });', AUTHIN],
  // the review's (8fd535f): checks its mutants passed
  [SELL, "|| (x as number) < 0 ||", "||", REVIEW],
  [SELL, "if (!Number.isSafeInteger(n) || n > COPY_MAX)", "if (!Number.isSafeInteger(n))", REVIEW],
  [SELL, 'if (typeof chain !== "string" || !Object.hasOwn(all, chain))', "if (!Object.hasOwn(all, chain))", REVIEW],
  [SELL, "if (!isWallet(token) || lower(token)", "if (!isAddress(token) || lower(token)", REVIEW],
  [SELL, "for (let i = 1; i < path.length; i++)", "for (let i = 2; i < path.length; i++)", REVIEW],
  // the pins (M370): the chain's pool for a sell, its sell delegate for W's authorization
  [SELL, 'if (pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool yet`);', "", PINPOOL],
  [SELL, "return evmPoolBuildSellUnpinned(chain, { ...req, pool });", "return evmPoolBuildSellUnpinned(chain, { pool, ...req });", PINPOOL],
  [SELL, 'if (pool === undefined) return refuse("not_deployed", `${chain} has no pinned pool to sign a sell into yet`);', "", PINPOOL],
  [SELL, 'if (BUILT.has(built) && lower(built.pool) !== lower(pool)) return refuse("not_pinned", `the sell\'s pool is not ${chain}\'s pinned pool`);', "", PINPOOL],
  [SELL, 'if (delegate === undefined) return refuse("not_deployed", `${chain} has no pinned sell delegate yet`);', "", PINAUTH],
  [SELL, 'if (typeof chain !== "string" || !Object.hasOwn(venues, chain)) return refuse("bad_route", "no such chain");', "", PINPOOL],
  // no read of a pin reaches Object.prototype (the review of 8d8675d): the list has no prototype, a pin is an own key
  [BUY, "(venues ??= bare({", "(venues ??= Object.freeze({", "M370 a polluted Object.prototype names no pool"],
  [BUY, "    base: bare({", "    base: Object.freeze({", "M370 a polluted Object.prototype names no pool"],
  [BUY, "    robinhood: bare({", "    robinhood: Object.freeze({", "M370 a polluted Object.prototype names no pool"],
  [BUY, 'pool: ownPin(v, "pool")', "pool: (v as { pool?: string }).pool", "M370 a polluted Object.prototype names no pool"],
  [BUY, 'sellDelegate: ownPin(v, "sellDelegate")', "sellDelegate: (v as { sellDelegate?: string }).sellDelegate", "M370 a polluted Object.prototype names no pool"],
  [BUY, 'if (typeof o !== "object" || o === null || !Object.hasOwn(o, k)) return undefined;', 'if (typeof o !== "object" || o === null) return undefined;', "M370 a polluted Object.prototype names no pool"],
  // a v4 sell (card evm-sell-v4-kit): only to the pinned PoolManager, a checked PathKey[] ending at native or WETH
  [SELL, "if (pm === undefined || lower(target) !== pm)", "if (pm === undefined)", V4],
  [SELL, 'const pm = Object.hasOwn(venue, "poolManager") && isAddress(venue.poolManager) ? lower(venue.poolManager) : undefined;', "const pm = lower(target);", V4],
  [SELL, "if (hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS)", "if (hops.length > EVM_POOL_MAX_HOPS)", V4],
  [SELL, "if (hops.length < 1 || hops.length > EVM_POOL_MAX_HOPS)", "if (hops.length < 1)", V4],
  [SELL, "if (!isAddress(currency) || !isAddress(hooks))", "if (!isAddress(currency))", V4],
  [SELL, "if (!isAddress(currency) || !isAddress(hooks))", "if (!isAddress(hooks))", V4],
  [SELL, 'if (!Number.isInteger(fee) || (fee as number) < 0 || (fee as number) > U24) refuse("bad_route", "a v4 fee is a u24");', "", V4],
  [SELL, "(tickSpacing as number) < 1 ||", "(tickSpacing as number) < 0 ||", V4],
  [SELL, "const MAX_TICK_SPACING = 32767;", "const MAX_TICK_SPACING = 32768;", V4],
  [SELL, 'if (to === from) refuse("bad_route", "a hop buys what it spends");', "", V4],
  [SELL, "if (last ? to !== NATIVE && to !== weth : to === NATIVE || to === weth)", "if (last ? to !== NATIVE && to !== weth : false)", V4],
  [SELL, "if (last ? to !== NATIVE && to !== weth : to === NATIVE || to === weth)", "if (last ? false : to === NATIVE || to === weth)", V4],
  // the review of a22060d: hook data is the device's own, empty (item 5); a listed hook only in its launchpad's own
  // shape, on any hop (item 2 as card evm-route-parity narrowed it: evmHookListed, the one rule the quotes use too)
  [SELL, 'if (hookData !== "0x") refuse("bad_route", "a sell\'s hook data is the device\'s own: empty");', "", V4],
  [SELL, 'if (hookData !== "0x") refuse(', 'if (hookData !== "0x" && lower(hooks as string) === NATIVE) refuse(', V4],
  [SELL, "if (lower(hooks as string) !== NATIVE) {", "if (false) {", V4],
  [SELL, "lower(p.hooks) === lower(hooks) && ", "", V4],
  [SELL, "lower(p.hooks) === lower(hooks) && ", "", V4CAST],
  // the shape check dropped: the listed hook at any fee or tick spacing (card evm-route-parity)
  [SELL, " && p.fee === fee && p.tickSpacing === tickSpacing);", ");", V4],
  [SELL, " && p.fee === fee && p.tickSpacing === tickSpacing);", ");", V4CAST],
  [SELL, "p.fee === fee && ", "", V4],
  [SELL, " && p.tickSpacing === tickSpacing", "", V4],
  [SELL, "if (!evmHookListed(chain, hooks as string, fee as number, tickSpacing as number)) refuse(", "if (false) refuse(", V4],
  [SELL, "return toHex(concat(word(0x20n), pathKeysAbi(hops as EvmV4Hop[])));", "return toHex(pathKeysAbi(hops as EvmV4Hop[]));", V4CAST],
  [BUY, "let at = 32 * elems.length;", "let at = 0;", V4CAST],
  [BUY, "concat(addressWord(h.currency), word(BigInt(h.fee)), word(BigInt(h.tickSpacing))", "concat(addressWord(h.currency), word(BigInt(h.tickSpacing)), word(BigInt(h.fee))", V4CAST],
  [BUY, "return concat(word(BigInt(elems.length)), ...offsets, ...elems);", "return concat(...offsets, ...elems);", V4CAST],
  // the testnet PoolManager pins: another one is refused, and a v4 sell is built to the pinned one
  [BUY, 'poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03408"', 'poolManager: "0x05e73354cfdd6745c338b50bcfdfa3aa6fa03409"', V4],
  [BUY, 'poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",\n      // Uniswap\'s V4Quoter at mainnet\'s address', 'poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40952",\n      // Uniswap\'s V4Quoter at mainnet\'s address', V4],
  // the fork fixture is the kit's output
  [SELL, "return Object.freeze({ chainId, address: delegate, nonce, yParity: rec[0] as 0 | 1, r: toHex(rec.slice(1, 33)), s: toHex(rec.slice(33, 65)) });", "return Object.freeze({ chainId, address: delegate, nonce, yParity: rec[0] as 0 | 1, r: toHex(rec.slice(1, 33)), s: toHex(rec.slice(33, 65)).replace(/.$/, \"0\") });", FIXTURE],
];

// a child test run must not inherit this process's own node --test context (when the sweep runs as a test, the child
// would report to the parent's runner and print no summary of its own)
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
// "pass", "fail" or "none" (no test ran) of the tests whose names start with `name`
function run(name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, TEST];
  try {
    const out = execFileSync("node", args, { stdio: "pipe", encoding: "utf8", env: CHILD_ENV });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch {
    return "fail";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = { [SELL]: readFileSync(SELL, "utf8"), [BUY]: readFileSync(BUY, "utf8") };
  let bad = 0;
  for (const t of new Set(MUTANTS.map((m) => m[3]))) {
    const r = run(t);
    if (r !== "pass") {
      console.log(`FAIL "${t}" ${r === "none" ? "names no test" : "fails on the code as it is"}`);
      bad++;
    }
  }
  if (bad > 0) process.exit(1);
  MUTANTS.forEach(([file, find, repl, t], i) => {
    if (src[file].split(find).length !== 2) {
      console.log(`FAIL mutant ${i + 1}: its text is not in ${file.split("/").pop()} exactly once`);
      bad++;
      return;
    }
    writeFileSync(file, src[file].replace(find, repl));
    let r;
    try {
      r = run(t);
    } finally {
      writeFileSync(file, src[file]);
    }
    if (readFileSync(file, "utf8") !== src[file]) throw new Error(`mutant ${i + 1} left ${file} changed`);
    console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
    if (r !== "fail") bad++;
  });
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
