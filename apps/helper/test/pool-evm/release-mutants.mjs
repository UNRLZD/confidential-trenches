// Removes or weakens each of the EVM pool sender's withdraw and buy checks (src/pool/evm.ts, POST /v1/pool/evm/send,
// card helper-evm-sender-2: the strict decode and W's EIP-712 signature), one at a time, and runs the test named for it
// in src/pool/evm-release.test.ts (or evm.test.ts, evm-buy-gas-depth.test.ts): each named test passes on the code as it
// is and fails on every mutant; mutant-sweep.mjs runs the list (each entry's text in its file exactly once, read before
// any test runs; the mutants made in a copy of the helper, never in the tree) and exits 1 on any problem. CI runs it as
// apps/helper's test:mutants, in parts, each one command of ci.yml's test-mutants split (scripts/ci/test-shards.mjs);
// test/pool-evm/mutant-sweep.test.mjs holds the list and the sweep's refusals (card helper-release-sweep-in-ci).
//   node apps/helper/test/pool-evm/release-mutants.mjs [<k>/<n>]   (part k of n only)
//
// Left out, as equivalent (no input tells them apart, each refusal still made by another check, as the pool's own
// ecrecover makes it): the v test (a v but 27 or 28 gives a recovery id below 0 or above 1, which recovers no key or
// another key, never the recipient), the r === 0, r >= n and s === 0 tests (noble's recovery throws on each, so no
// signer), evmReadBuy's selector test (evmReadRelease calls it only on buy's selector), evmReleaseDigest's method/Buy
// agreement throw (both readers always set them alike), and the 65-byte length test in evmReleaseSigner (both readers
// slice exactly 65 bytes).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sweepMain } from "./mutant-sweep.mjs";

const HELPER = fileURLToPath(new URL("../..", import.meta.url));
const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-release.test.ts";
const T2 = "src/pool/evm.test.ts";
const T3 = "src/pool/evm-buy-gas-depth.test.ts";

const EVM_TEXT = readFileSync(join(HELPER, EVM), "utf8");
/** [the text from `line` through `after` in evm.ts, the same with `line` moved to just after `after`]: a check moved later. */
function movedAfter(line, after) {
  const i = EVM_TEXT.indexOf(line);
  const j = EVM_TEXT.indexOf(after, i);
  if (i < 0 || j < 0) throw new Error(`movedAfter: ${JSON.stringify(line.slice(0, 40))} or ${JSON.stringify(after.slice(0, 40))} not in ${EVM}`);
  const find = EVM_TEXT.slice(i, j + after.length);
  return [find, find.slice(line.length) + line];
}
const SIG_CHECK = EVM_TEXT.slice(EVM_TEXT.indexOf("    const signer = evmReleaseSigner(releaseChainId, pool, w);\n"), EVM_TEXT.indexOf("\n", EVM_TEXT.indexOf("    if (signer !== w.recipient) return no(422")) + 1);
const ROUTE_CHECK = EVM_TEXT.slice(EVM_TEXT.indexOf("    if (w.buy !== undefined) {\n      try {\n        evmBuyRouteOf("), EVM_TEXT.indexOf("\n    }\n", EVM_TEXT.indexOf("        evmBuyRouteOf(")) + 7);
const FEE_CAP_LINE = '    if (w.fee > w.feeCap) return no(422, "fee_over_cap", `fee ${w.fee}, cap ${w.feeCap}`);\n';

const DIGEST = "the helper's release digest is the pool's";
const LANDED = "every withdraw and buy that landed";
const GOOD = "a good withdraw and a good buy W signed";
const FORM = "W's signature only in its one form";
const BUY = "buy's calldata is read in its one canonical encoding";
const MAX = "a release's calldata is at most EVM_BODY_DATA_MAX";
const PIN = "the chain id is the kit's pin";
const DIRTY = "a dirty processooor, recipient or feeRecipient high bit";
const ROUTE = "a buy through any adapter but the kit's pinned two";
const HOLD = "a buy's worst gas is held against W, the client and the token";
const RESERVE = "a buy is refused (429) when the sender's lower pending balance";
const RETRY = "a device's retry of its own in-flight buy";
const PROOF = "evmBuyUnpaid: a proven buy whose receipt cost";
const PAYS_OUT = "evmBuyLanded: a buy whose swap failed lands on the pool's Withdrawn";
const SIM_TRUE = "a buy whose own simulation answers false";
const DEPTH_32 = "depth 32: the heaviest route's limit";

// [file, text, replacement, test file, the test whose name starts so, which must fail]
export const MUTANTS = [
  // buy's one canonical encoding
  [EVM, "d.length > EVM_BODY_DATA_MAX || (d.length - 4) % 32", "(d.length - 4) % 32", T, MAX],
  [EVM, " || (d.length - 4) % 32 !== 0 || hex(d.subarray(0, 4)) !== BUY_SELECTOR", " || hex(d.subarray(0, 4)) !== BUY_SELECTOR", T, BUY],
  [EVM, '  if (word(d, 18) !== BigInt(32 * at)) throw new Error("the buy\'s offset");\n', "", T, BUY],
  [EVM, "  if (!isAddressWord(b(0)) || !isAddressWord(b(3))) throw", "  if (!isAddressWord(b(3))) throw", T, BUY],
  [EVM, "  if (!isAddressWord(b(0)) || !isAddressWord(b(3))) throw", "  if (!isAddressWord(b(0))) throw", T, BUY],
  [EVM, '  if (b(1) !== BigInt(32 * 4)) throw new Error("the buy data\'s offset");\n', "", T, BUY],
  [EVM, '  if (len > BigInt(d.length)) throw new Error("the buy data\'s length");\n', "", T, BUY],
  [EVM, '  if ((d.length - 4) / 32 !== sigAt + SIG_WORDS) throw new Error("the buy\'s length");\n', "", T, BUY],
  [EVM, '  if (word(d, 19) !== BigInt(32 * sigAt)) throw new Error("the signature\'s offset");\n', "", T, BUY],
  [EVM, '  if (d.subarray(dataAt + Number(len), dataAt + 32 * padded).some((x) => x !== 0)) throw new Error("the buy data\'s padding");\n', "", T, BUY],
  // the words a withdraw and a buy share
  [EVM, '  if (word(d, 0) !== BigInt(32 * head)) throw new Error("the withdrawal\'s offset");\n', "", T, BUY],
  [EVM, " || word(d, head + 2) !== BigInt(32 * RELAY_WORDS)) throw", ") throw", T, BUY],
  [EVM, "  if (word(d, sigAt) !== 65n || (word(d, sigAt + 3)", "  if ((word(d, sigAt + 3)", T, BUY],
  [EVM, "  if (word(d, sigAt) !== 65n || (word(d, sigAt + 3) & ((1n << 248n) - 1n)) !== 0n) throw", "  if (word(d, sigAt) !== 65n) throw", T, BUY],
  [EVM, "nullifier: word(d, 10).toString(16)", "nullifier: word(d, 9).toString(16)", T, DIGEST],
  [EVM, "value: word(d, 11), context", "value: word(d, 12), context", T, DIGEST],
  [EVM, "context: word(d, 16), signature", "context: word(d, 15), signature", T, DIGEST],
  [EVM, "minOut: b(2), token", "minOut: b(1), token", T, DIGEST],
  [EVM, "  return hex(d.subarray(0, 4)) === BUY_SELECTOR ? evmReadBuy(d) : evmReadWithdraw(d);", "  return evmReadWithdraw(d);", T, GOOD],
  // the pool's digest
  [EVM, 'utf8("Withdraw(uint256 nullifier,uint256 context,uint256 value)")', 'utf8("Withdraw(uint256 nullifier,uint256 context)")', T, DIGEST],
  [EVM, 'utf8("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context,uint256 value)")', 'utf8("Buy(address adapter,bytes data,uint256 minOut,address token,uint256 nullifier,uint256 context)")', T, DIGEST],
  [EVM, "...keccak_256(b.data), ...w32(b.minOut)", "...w32(b.minOut)", T, DIGEST],
  [EVM, "[BigInt(`0x${r.nullifier}`), r.context, r.value].map(w32)", "[BigInt(`0x${r.nullifier}`), r.value, r.context].map(w32)", T, DIGEST],
  [EVM, '...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(pool))]', '...keccak_256(utf8("1")), ...w32(chainId), ...w32(0n)]', T, DIGEST],
  [EVM, '...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(pool))]', '...keccak_256(utf8("1")), ...w32(0n), ...w32(BigInt(pool))]', T, DIGEST],
  [EVM, '...keccak_256(utf8("1")), ...w32(chainId), ...w32(BigInt(pool))]', '...keccak_256(utf8("2")), ...w32(chainId), ...w32(BigInt(pool))]', T, LANDED],
  // W's signature: its one form, its signer, its place
  [EVM, " || ss === 0n || ss > N / 2n) return null;", " || ss === 0n) return null;", T, FORM],
  [EVM, '    if (signer !== w.recipient) return no(422, "bad_signature"', '    if (false) return no(422, "bad_signature"', T, GOOD],
  [EVM, "    const signer = evmReleaseSigner(releaseChainId, pool, w);", "    const signer = evmReleaseSigner(releaseChainId, w.recipient, w);", T, GOOD],
  [EVM, ...movedAfter(SIG_CHECK, FEE_CAP_LINE), T, GOOD],
  // the chain id: the kit's pin, for the signature and the send
  [EVM, "  const releaseChainId = sellVenue === undefined ? undefined : BigInt(sellVenue.chainId);", "  const releaseChainId = sellVenue === undefined ? undefined : 84532n;", T, GOOD],
  [EVM, '    if (releaseChainId === undefined) return no(503, "not_configured"', '    if (false) return no(503, "not_configured"', T, PIN],
  [EVM, '      if (id !== releaseChainId) return no(503, "upstream"', '      if (false) return no(503, "upstream"', T, PIN],
  // review a2ff5521 L1: the relay words and the processooor in their one encoding
  [EVM, "  if (!isAddressWord(processooor) || word(d, head + 1)", "  if (word(d, head + 1)", T, DIRTY],
  [EVM, "  if (!isAddressWord(r(0)) || !isAddressWord(r(1)) ||", "  if (!isAddressWord(r(1)) ||", T, DIRTY],
  [EVM, "  if (!isAddressWord(r(0)) || !isAddressWord(r(1)) ||", "  if (!isAddressWord(r(0)) ||", T, DIRTY],
  [EVM, " || r(3) >> 64n !== 0n || ", " || ", T, DIRTY],
  [EVM, " || (r(5) & ((1n << 128n) - 1n)) !== 0n) throw", ") throw", T, DIRTY],
  // review a2ff5521 H1: a buy only through a pinned adapter's builder route, before any read
  [EVM, "    if (w.buy !== undefined) {\n      try {\n        evmBuyRouteOf(", "    if (false) {\n      try {\n        evmBuyRouteOf(", T, ROUTE],
  [EVM, ...movedAfter(ROUTE_CHECK, FEE_CAP_LINE), T, ROUTE],
  [EVM, "evmBuyRouteOf(sellChain!, { adapter: w.buy.adapter, data: `0x${hex(w.buy.data)}`", "evmBuyRouteOf(sellChain!, { adapter: w.buy.adapter, data: `0x${hex(w.buy.data).slice(0, 640)}`", T, ROUTE],
  // H1: a buy's worst gas held until it lands, by W, client, token and the buys' budget
  [EVM, "    if (keys !== undefined && once.get(w.nullifier) === undefined) {\n      const capped = overCap(keys, 1n);", "    if (false) {\n      const capped = overCap(keys, 1n);", T, HOLD],
  [EVM, "    if (keys !== undefined) {\n      const capped = overCap(keys, worst);", "    if (false) {\n      const capped = overCap(keys, worst);", T, HOLD],
  [EVM, "      const held = charge(keys, worst);", "      const held = { at: now(), wei: worst };", T, HOLD],
  [EVM, '  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1" && evmBuyLanded(r, buy));', "  const ok = true;", T, HOLD],
  [EVM, '  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1" && evmBuyLanded(r, buy));', '  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1");', T, HOLD],
  [EVM, '  const ok = [ra, rb].every((r) => evmRpcHex(r.status) === "0x1" && evmBuyLanded(r, buy));', '  const ok = [ra].every((r) => evmRpcHex(r.status) === "0x1" && evmBuyLanded(r, buy));', T, HOLD],
  [EVM, '["buys", `w:${w}`, `t:${token}`, ...(client', '["buys", `w:${w}`, ...(client', T, HOLD],
  [EVM, '["buys", `w:${w}`, `t:${token}`, ...(client === undefined ? [] : [`c:${client}`])]', '["buys", `w:${w}`, `t:${token}`]', T, HOLD],
  [EVM, '  const budget = k === "all" || k === "buys";', '  const budget = k === "all";', T, HOLD],
  [EVM, "      if (sum > 0n && sum + extra > cap) {", "      if (sum + extra > cap) {", T, GOOD],
  // review of 7d210cb5 M1: the withdraws' reserve
  [EVM, "      if (low < reserve + flying + worst) {", "      if (false) {", T, RESERVE],
  [EVM, "      if (low < reserve + flying + worst) {", "      if (low < reserve + worst) {", T, RESERVE],
  [EVM, "      const low = balA < balB ? balA : balB;", "      const low = balA;", T, RESERVE],
  [EVM, "      buysInFlight.add(held);\n", "", T, RESERVE],
  [EVM, "    buysInFlight.delete(held);\n", "", T, RESERVE],
  // review of 7d210cb5 L1: a repeat of a sent buy gets its hash; a repeat after it ended is held before its new send
  [EVM, "    if (keys !== undefined && once.get(w.nullifier) === undefined) {", "    if (keys !== undefined) {", T, RETRY],
  [EVM, "      if (keys !== undefined) {\n        const capped = overCap(keys, 1n);", "      if (false) {\n        const capped = overCap(keys, 1n);", T, HOLD],
  // review of 7d210cb5 L2 and L3: a proven buy holds its cost less the fee; every field of the Bought proof
  [EVM, "unpaid: ok ? (cost > buy.fee ? cost - buy.fee : 0n) : cost }", "unpaid: ok ? 0n : cost }", T, PROOF],
  [EVM, " || evmRpcHex(address) !== buy.pool || ", " || ", T, PROOF],
  [EVM, "    if (removed === true || evmRpcHex(address) !== buy.pool", "    if (evmRpcHex(address) !== buy.pool", T, PROOF],
  [EVM, " || evmRpcHex(topics[1]) !== `0x${pad(buy.w)}`) return false;", ") return false;", T, PROOF],
  [EVM, "    return at(0) === pad(buy.feeRecipient) && ", "    return ", T, PROOF],
  [EVM, " && BigInt(`0x${at(2)}`) === buy.fee", "", T, PROOF],
  [EVM, " && at(3) === buy.nullifier", "", T, PROOF],
  [EVM, " && (!bought || at(5) === pad(buy.token));", ";", T, PROOF],
  [EVM, "    if (d === null || d.length !== 2 + (bought ? 7 : 5) * 64) return false;", "    if (d === null) return false;", T, PROOF],
  // card pool-evm-buy-pays-revert: a buy whose swap failed lands on the pool's Withdrawn, each field read
  [EVM, "    const bought = evmRpcHex(topics[0]) === BOUGHT_TOPIC;", "    const bought = false;", T, PROOF],
  [EVM, "(!bought && evmRpcHex(topics[0]) !== WITHDRAWN_TOPIC)", "(!bought)", T, PAYS_OUT],
  [EVM, "(bought ? 7 : 5)", "(bought ? 7 : 7)", T, PAYS_OUT],
  // a buy goes out only where its eth_call answers exactly true (review of 68b0930a, M1)
  [EVM, "if (w.buy !== undefined && sim !== BUY_TRUE) return", "if (false) return", T, SIM_TRUE],
  [EVM, "const BUY_TRUE = `0x${\"0\".repeat(63)}1`;", "const BUY_TRUE = `0x${\"0\".repeat(64)}`;", T, SIM_TRUE],
  // card evm-buy-gas-depth (review of f7f4631a, L2): a buy whose limit is exactly the cap G(32) goes out
  [EVM, "    if (gas > gasMax) return no(422", "    if (gas >= gasMax) return no(422", T3, DEPTH_32],
  // review a2ff5521 L2: a revert is held against its method, so the same proof still withdraws in its epoch
  [EVM, "        if (was === epoch && how === w.method) return no(422, \"reverted\");", "        if (was === epoch) return no(422, \"reverted\");", T, HOLD],
  // a withdraw's request read as before (evm.test.ts's signed requests)
  [EVM, '  if (word(d, 18) !== BigInt(32 * (HEAD_WORDS + W_WORDS))) throw new Error("the signature\'s offset");\n', "", T2, "withdraw's signature is read in its one canonical form"],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) sweepMain(MUTANTS, "release-mutants.mjs");
