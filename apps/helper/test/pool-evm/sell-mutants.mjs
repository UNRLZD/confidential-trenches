// Removes or weakens each of the EVM pool sender's sell checks (src/pool/evm.ts, POST /v1/pool/evm/sell, card
// helper-evm-sender), one at a time, and runs the test named for it in src/pool/evm-sell.test.ts: each named test
// passes on the code as it is and fails on every mutant. The mutants are made in a copy of the helper's src in a fresh
// temporary folder inside the helper (so the copy resolves the same installed modules, @blindfill/kit included),
// removed at the end; the tree's own files are never changed. Exits 1 when a named test passes on its mutant, fails or
// runs no test on the code as it is, or a mutant's text is not in its file exactly once (the style of
// packages/kit/test/evm-quote-mutants.mjs).
//   node apps/helper/test/pool-evm/sell-mutants.mjs
//
// Left out, as equivalent (no input tells them apart, each refusal still made by another check): the chainId === 0
// test (the venue's id is never 0, so the venue check refuses it), the explicit "no delegate pinned" test (an
// authorization's address never equals undefined), the yParity and v range tests where only the detail differs (a
// recovery id of 2 or more recovers no key), the body's and the decoder's two data size bounds (each holds without the
// other), the % 32 length test (the word count test refuses the same), and either fee_low test without the other
// (fee >= gas x (base + tip) + L1 exactly when (fee - L1) / gas >= base + tip; both are removed together below), and a
// replacement's "a base fee of 0 prices no poster gas" test on Robinhood (without it the poster gas's division by that 0
// throws all the same, failing the tend), and a tend's return at a nonce whose replacement would be over
// EVM_SELL_MAX_FEE_PER_GAS against going on to the next nonce (a send above a nonce left unreplaced is never mined before
// it, so what lands is the same either way, and the lane is tended again at its next read).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

const HELPER = fileURLToPath(new URL("../..", import.meta.url));
const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-sell.test.ts";
const T2 = "src/pool/evm.test.ts";

/** [the text from `line` through `after` in evm.ts, the same with `line` moved to just after `after`]: a check moved later
 *  (card helper-sell-fee-recipient, review Low 1: nothing pinned the fee recipient check's place) */
const EVM_TEXT = readFileSync(join(HELPER, EVM), "utf8");
function movedAfter(line, after) {
  const i = EVM_TEXT.indexOf(line);
  const j = EVM_TEXT.indexOf(after, i);
  if (i < 0 || j < 0) throw new Error(`movedAfter: ${JSON.stringify(line.slice(0, 40))} or ${JSON.stringify(after.slice(0, 40))} not in ${EVM}`);
  const find = EVM_TEXT.slice(i, j + after.length);
  return [find, find.slice(line.length) + line];
}
const FEE_TO_CHECK = '    // the fee goes only to the Sell\'s feeRecipient (SellDelegate.sol, L-1): this release\'s, as a withdraw\'s relay data\n    if (s.feeRecipient !== feeRecipient) return no(422, "fee_recipient", `the Sell pays ${s.feeRecipient}, not ${feeRecipient}`);\n';

// [file, text, replacement, test file, the test whose name starts so, which must fail]
export const MUTANTS = [
  // the body's shape
  [EVM, '|| !sameKeys(body, SELL_KEYS)) return no(400, "bad_shape");', ') return no(400, "bad_shape");', T, "bad_shape:"],
  [EVM, '|| !sameKeys(au, AUTH_KEYS)) return no(400, "bad_shape");', ') return no(400, "bad_shape");', T, "bad_shape:"],
  [EVM, "if (p !== pool || typeof wIn", "if (typeof wIn", T, "bad_shape:"],
  [EVM, '![ar, as].every((x) => typeof x === "string" && WORD32.test(x))) return no(400', '![ar, as].every((x) => typeof x === "string")) return no(400', T, "bad_shape:"],
  [EVM, "![ac, an, ay].every((x) => typeof x === \"string\" && QUANTITY.test(x))", "![ac, an, ay].every((x) => typeof x === \"string\")", T, "bad_shape:"],
  // the calldata's one canonical encoding
  [EVM, "  if ((d.length - 4) / 32 !== sigAt + 4) throw new Error(\"the sell's length\");", "", T, "bad_shape:"],
  [EVM, "  if (word(d, 0) !== BigInt(32 * SELL_HEAD)) throw new Error(\"the sell's offset\");", "", T, "bad_shape:"],
  [EVM, "  if (t(3) !== BigInt(32 * SELL_TUPLE)) throw new Error(\"the swap data's offset\");", "", T, "bad_shape:"],
  [EVM, "  if (![t(0), t(2), t(5), t(8)].every(isAddressWord)) throw new Error(\"an address's padding\");", "", T, "bad_shape:"],
  [EVM, "  if (![t(0), t(2), t(5), t(8)].every(isAddressWord))", "  if (![t(0), t(2), t(5)].every(isAddressWord))", T, "bad_shape:"],
  [EVM, "  if (word(d, 2) !== BigInt(32 * sigAt)) throw new Error(\"the signature's offset\");", "", T, "bad_shape:"],
  [EVM, "  if (word(d, sigAt) !== 65n) throw new Error(\"the signature's length\");", "", T, "bad_shape:"],
  [EVM, "d.subarray(dataAt + Number(len), dataAt + 32 * padded).some((b) => b !== 0) || ", "", T, "bad_shape:"],
  [EVM, " || d.subarray(sigBytes + 65, sigBytes + 96).some((b) => b !== 0)) throw", ") throw", T, "bad_shape:"],
  [EVM, "hex(d.subarray(0, 4)) !== SELL_SELECTOR) throw", "false) throw", T, "bad_shape:"],
  // the Sell's pool and fee
  [EVM, '    if (s.pool !== pool) return no(422, "not_pool");', "", T, "the Sell:"],
  [EVM, '    if (s.fee > s.feeCap) return no(422, "fee_over_cap"', '    if (s.fee > s.feeCap + 1n) return no(422, "fee_over_cap"', T, "the Sell:"],
  [EVM, '    if (s.feeCap >= s.minOut) return no(422, "fee_over_cap"', '    if (s.feeCap > s.minOut) return no(422, "fee_over_cap"', T, "the Sell:"],
  // W's authorization
  [EVM, " || auth.chainId !== BigInt(sellVenue.chainId)) return bad(", ") return bad(", T, "the authorization:"],
  [EVM, "    if (auth.address !== sellDelegate) return bad(", "    if (false) return bad(", T, "the authorization:"],
  [EVM, "    if (auth.yParity > 1n) return bad(", "    if (false) return bad(", T, "the authorization:"],
  [EVM, "auth.r === 0n || auth.r >= N || auth.s === 0n || auth.s > N / 2n) return bad(", "auth.r === 0n || auth.r >= N || auth.s === 0n) return bad(", T, "the authorization:"],
  [EVM, "auth.r === 0n || auth.r >= N || auth.s === 0n || auth.s > N / 2n) return bad(", "auth.s > N / 2n) return bad(", T, "the authorization:"],
  [EVM, "    if (auth.nonce >= (1n << 64n) - 1n) return bad(", "    if (false) return bad(", T, "the authorization:"],
  [EVM, "    if (authority !== w) return bad(", "    if (false) return bad(", T, "the authorization:"],
  [EVM, "keccak_256(Uint8Array.from([5, ...rlp(", "keccak_256(Uint8Array.from([4, ...rlp(", T, "the authorization:"],
  // W's Sell signature
  [EVM, "if ((v !== 27 && v !== 28) || r === 0n", "if (r === 0n", T, "W's Sell signature:"],
  [EVM, " || sv === 0n || sv > N / 2n) return no(422, \"bad_signature\"", " || sv === 0n) return no(422, \"bad_signature\"", T, "W's Sell signature:"],
  [EVM, '    if (signer !== w) return no(422, "bad_signature"', '    if (false) return no(422, "bad_signature"', T, "W's Sell signature:"],
  [EVM, "recoverAddress(evmSellDigest(BigInt(sellVenue.chainId), w, s)", "recoverAddress(evmSellDigest(BigInt(sellVenue.chainId) + 1n, w, s)", T, "a good sell:"],
  [EVM, "...keccak_256(unhex(s.data.slice(2))), ...rest", "...keccak_256(unhex(s.data.slice(4))), ...rest", T, "the helper's sell digest is SellDelegate's"],
  [EVM, "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, BigInt(s.feeRecipient), s.deadline, s.nonce].map(w32);", "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, BigInt(s.feeRecipient), s.nonce, s.deadline].map(w32);", T, "the helper's sell digest is SellDelegate's"],
  // the 11-field Sell (card helper-sell-fee-recipient): feeRecipient after feeCap in the calldata, the type and the hash
  [EVM, "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, BigInt(s.feeRecipient), s.deadline, s.nonce].map(w32);", "const rest = [s.minOut, BigInt(s.pool), s.precommitment, BigInt(s.feeRecipient), s.feeCap, s.deadline, s.nonce].map(w32);", T, "the helper's sell digest is SellDelegate's"],
  [EVM, "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, BigInt(s.feeRecipient), s.deadline, s.nonce].map(w32);", "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, s.deadline, s.nonce].map(w32);", T, "the helper's sell digest is SellDelegate's"],
  [EVM, "uint256 feeCap,address feeRecipient,uint256 deadline,uint256 nonce)\"));", "uint256 feeCap,uint256 deadline,uint256 nonce)\"));", T, "the helper's sell digest is SellDelegate's"],
  [EVM, "feeCap: t(7), feeRecipient: addr(t(8)),", "feeCap: t(8), feeRecipient: addr(t(7)),", T, "the helper reads SellDelegate.sell's 11-field Sell"],
  [EVM, "const SELL_TUPLE = 11;", "const SELL_TUPLE = 10;", T, "the helper reads SellDelegate.sell's 11-field Sell"],
  [EVM, "uint256,uint256,address,uint256,uint256),uint256,bytes)\";", "uint256,uint256,uint256,uint256),uint256,bytes)\";", T, "the helper reads SellDelegate.sell's 11-field Sell"],
  // the fee goes only to this release's fee recipient (SellDelegate.sol, L-1)
  [EVM, '    if (s.feeRecipient !== feeRecipient) return no(422, "fee_recipient"', '    if (false) return no(422, "fee_recipient"', T, "fee_recipient:"],
  [EVM, '    if (s.feeRecipient !== feeRecipient) return no(422, "fee_recipient"', '    if (s.feeRecipient !== sellSender) return no(422, "fee_recipient"', T, "fee_recipient:"],
  [EVM, '    if (s.feeRecipient !== feeRecipient) return no(422, "fee_recipient"', '    if (s.feeRecipient !== sender) return no(422, "fee_recipient"', T, "fee_recipient:"],
  // its place: before the fee cap and before W's signature, so a sell paying another is refused as that whatever else
  [EVM, ...movedAfter(FEE_TO_CHECK, '    if (s.feeCap >= s.minOut) return no(422, "fee_over_cap", `feeCap ${s.feeCap} is not under minOut ${s.minOut}`);\n'), T, "fee_recipient:"],
  [EVM, ...movedAfter(FEE_TO_CHECK, '    if (signer !== w) return no(422, "bad_signature", `signed by ${signer ?? "no key"}, not W`);\n'), T, "fee_recipient:"],
  // the deadline, seconds
  [EVM, "    if (s.deadline * 1000n < t + BigInt(EVM_POOL_SEND_MARGIN_MS)) return", "    if (false) return", T, "the deadline is unix seconds:"],
  [EVM, "    if (s.deadline * 1000n < t + BigInt(EVM_POOL_SEND_MARGIN_MS)) return", "    if (s.deadline * 1000n <= t + BigInt(EVM_POOL_SEND_MARGIN_MS)) return", T, "the deadline is unix seconds:"],
  [EVM, "    if (s.deadline * 1000n > t + BigInt(EVM_POOL_SELL_DEADLINE_MAX_S) * 1000n) return", "    if (false) return", T, "the deadline is unix seconds:"],
  [EVM, "    if (s.deadline * 1000n > t + BigInt(EVM_POOL_SELL_DEADLINE_MAX_S) * 1000n) return", "    if (s.deadline * 1000n >= t + BigInt(EVM_POOL_SELL_DEADLINE_MAX_S) * 1000n) return", T, "the deadline is unix seconds:"],
  // once per (W, Sell nonce), the held limit
  [EVM, "    const key = `${w}:${s.nonce}`;", "    const key = data;", T, "once per (W, Sell nonce):"],
  [EVM, "=> holding(client, () => sellHeld(body, client));", "=> sellHeld(body, client);", T, "a sell is held with the withdraws:"],
  // the RPC checks
  [EVM, '      if (id !== BigInt(venue.chainId)) return no(503, "upstream"', '      if (false) return no(503, "upstream"', T, "the chain:"],
  [EVM, "if (na !== auth.nonce || nb !== auth.nonce) return", "if (na !== auth.nonce) return", T, "auth_nonce:"],
  [EVM, "if (na !== auth.nonce || nb !== auth.nonce) return", "if (nb !== auth.nonce) return", T, "auth_nonce:"],
  [EVM, "      base = x > y ? x : y;", "      base = x;", T, "the base fee and the L1 bound"],
  [EVM, "      l1 = fees[0]! > fees[1]! ? fees[0]! : fees[1]!;", "      l1 = fees[0]!;", T, "the base fee and the L1 bound"],
  [EVM, "      l1 = fees[0]! > fees[1]! ? fees[0]! : fees[1]!;", "      l1 = fees[1]!;", T, "the base fee and the L1 bound"],
  [EVM, "      l1 = fees[0]! > fees[1]! ? fees[0]! : fees[1]!;", "      l1 = 0n;", T, "the fee is bounded:"],
  // the chain fee is the kit's whole rule (pool-fee.ts): the operator fee on Base, the poster fee on Robinhood. Which
  // chain reads which oracle is the kit's (its own tests and mutants); Base itself reading the oracle is held by the
  // test named for it
  [EVM, "        return evmPoolChainFee(kitChain, txBytes, words);", "        return words[0]!;", T, "the operator fee is in the bound"],
  [EVM, "        return evmPoolChainFee(kitChain, txBytes, words);", "        return words[0]!;", T, "Robinhood's L1 poster fee"],
  // the L1 bound read for the transaction's longest form (Base; ArbGasInfo's read takes no length, so on Robinhood the
  // bytes reach only evmPoolChainFee, which the poster fee mutant above holds)
  [EVM, "      const reads = evmPoolChainFeeReads(kitChain, gas, txBytes);", "      const reads = evmPoolChainFeeReads(kitChain, gas, 1n);", T, "a good sell:"],
  [EVM, "      const fees = await Promise.all([a, b].map(async (r) => {", "      const fees = await Promise.all([a, a].map(async (r) => {", T, "the operator fee is in the bound"],
  // the poster's gas inside the limit (Robinhood): the sim runs with what is left, at the lower base fee; none left refuses
  [EVM, 'const POSTER_GAS_CHAINS: ReadonlySet<string> = new Set(["robinhood", "robinhood-testnet"]);', "const POSTER_GAS_CHAINS: ReadonlySet<string> = new Set([]);", T, "Robinhood's L1 poster fee"],
  [EVM, "      baseLow = x < y ? x : y;", "      baseLow = x > y ? x : y;", T, "Robinhood's L1 poster fee"],
  [EVM, "(baseLow > 0n ? (l1 + baseLow - 1n) / baseLow", "(baseLow > 0n ? l1 / baseLow", T, "Robinhood's L1 poster fee"],
  [EVM, '    if (posterGas >= gas - EVM_7702_AUTH_GAS) return no(422, "simulation_failed"', '    if (false) return no(422, "simulation_failed"', T, "Robinhood's L1 poster fee"],
  [EVM, "gas: tag(gas - EVM_7702_AUTH_GAS - posterGas)", "gas: tag(gas - EVM_7702_AUTH_GAS)", T, "Robinhood's L1 poster fee"],
  [EVM, "big(1n), big(U256_MAX), big(U256_MAX)]).length;", "big(1n), big(1n), big(1n)]).length;", T, "a good sell:"],
  // the transaction as sent
  [EVM, "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = cap;", T, "a good sell:"],
  [EVM, "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip;", T, "the fee is bounded:"],
  [EVM, '    if (s.fee < need) return no(422, "fee_low", `fee ${s.fee}, need ${gas} x (${base} + ${tip}) + ${l1} = ${need}`);\n    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;\n    if (maxFeePerGas < base + tip) return no(422, "fee_low", `maxFeePerGas ${maxFeePerGas} under ${base} + ${tip}`);', "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", T, "the fee is bounded:"],
  [EVM, "    const gas = EVM_POOL_SELL_GAS;", "    const gas = EVM_POOL_SELL_GAS + 1n;", T, "a good sell:"],
  [EVM, "    const tip = evmPoolSellTip(kitChain);", "    const tip = 0n;", T, "a good sell:"],
  [EVM, "gas: tag(gas - EVM_7702_AUTH_GAS - posterGas), maxFeePerGas: tag(maxFeePerGas)", "gas: tag(gas - posterGas), maxFeePerGas: tag(maxFeePerGas)", T, "a good sell:"],
  [EVM, ', "pending", { [w]: { code: `0xef0100${delegate.slice(2)}` } }]);', ', "pending"]);', T, "a good sell:"],
  [EVM, "    } catch (e) {\n      return failedInExecution(e) ? no(422, \"simulation_failed\", String((e as Error).message).slice(0, 200)) : unread(e);\n    }\n    const { raw, hash } = signEvmTx4(", "    } catch (e) {\n      void e;\n    }\n    const { raw, hash } = signEvmTx4(", T, "a sim that reverts"],
  [EVM, "  const raw = Uint8Array.from([4, ...rlp([...fields, big(BigInt(sig[0]!)), big(r), big(s)])]);", "  const raw = Uint8Array.from([2, ...rlp([...fields, big(BigInt(sig[0]!)), big(r), big(s)])]);", T, "a good sell:"],
  [EVM, "  const digest = keccak_256(Uint8Array.from([4, ...rlp(fields)]));", "  const digest = keccak_256(Uint8Array.from([2, ...rlp(fields)]));", T, "a good sell:"],
  [EVM, "big(a.nonce), big(a.yParity), big(a.r), big(a.s)]),", "big(a.nonce), big(a.yParity), big(a.r), big(a.r)]),", T, "a good sell:"],
  [EVM, "authorizations: [auth] });", "authorizations: [] });", T, "a good sell:"],
  [EVM, "    if (nonce + 1n > lane.nextNonce) lane.nextNonce = nonce + 1n;", "", T, "once per (W, Sell nonce):"],
  // fold 1, M3 (b): one provider refusing the send still sends, and the next sale takes nonce + 1
  [EVM, "    if (why.length === sent.length) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);\n    const until = Number(s.deadline)", "    if (why.length > 0) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);\n    const until = Number(s.deadline)", T, "one provider refusing the send:"],
  // the fee answer
  [EVM, "fee_recipient: feeRecipient, sell_sender: sellSender, epoch_ms", "fee_recipient: feeRecipient, sell_sender: sender, epoch_ms", T, "the fee answer names"],
  // fold 1, H1: a sale that did not land frees its (W, nonce), on both providers' reads, capped per W
  [EVM, '    if (status.includes("0x0")) return "reverted";', '    if (false) return "reverted";', T, "a sale that reverted or was dropped"],
  [EVM, '    if (status.includes("0x1")) return "waiting";', "", T, "a sale that reverted or was dropped"],
  [EVM, "    if (Math.floor(now()) <= deadlineMs + EVM_SELL_DROP_MARGIN_MS) return \"waiting\";", "", T, "a sale that reverted or was dropped"],
  // the drop margin: a clock up to 60 s ahead of the chain's never frees (W, nonce) while the first sale can land
  [EVM, "    if (Math.floor(now()) <= deadlineMs + EVM_SELL_DROP_MARGIN_MS) return \"waiting\";", "    if (Math.floor(now()) <= deadlineMs) return \"waiting\";", T, "a dropped sale with our clock 59 s ahead"],
  [EVM, "    if (Math.floor(now()) <= deadlineMs + EVM_SELL_DROP_MARGIN_MS) return \"waiting\";", "    if (Math.floor(now()) < deadlineMs + EVM_SELL_DROP_MARGIN_MS) return \"waiting\";", T, "a dropped sale is freed at 61 s past"],
  [EVM, "export const EVM_SELL_DROP_MARGIN_MS = 60_000;", "export const EVM_SELL_DROP_MARGIN_MS = 58_000;", T, "a dropped sale with our clock 59 s ahead"],
  [EVM, '    return tx.every((x) => x.status === "fulfilled" && x.value === null) ? "dropped" : "waiting";', '    return tx.some((x) => x.status === "fulfilled" && x.value === null) ? "dropped" : "waiting";', T, "a sale that reverted or was dropped"],
  [EVM, '    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);\n    const status', '    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash])]);\n    const status', T, "a sale that reverted or was dropped"],
  // fold 1, H2.1: only a route the kit's sell builder makes (the kit's own checks: packages/kit/test/evm-sell-route-of.test.ts)
  [EVM, "      evmSellRouteOf(sellChain, { w, token: s.token, amount: s.amount, minOut: s.minOut, target: s.target, data: s.data });", "      void { w, token: s.token, amount: s.amount, minOut: s.minOut, target: s.target, data: s.data };", T, "bad_route:"],
  // fold 1, H2.2: the unpaid-gas caps
  [EVM, "    const capped = overCap(keys, worst);\n    if (capped !== null) return capped;", "", T, "unpaid sell gas:"],
  [EVM, "    held.wei = ok ? (cost > fee ? cost - fee : 0n) : cost;", "    held.wei = cost;", T, "unpaid sell gas:"],
  [EVM, "    held.wei = ok ? (cost > fee ? cost - fee : 0n) : cost;", "    held.wei = 0n;", T, "unpaid sell gas:"],
  [EVM, '["all", `w:${w}`, `t:${token}`, ...(client === undefined ? [] : [`c:${client}`])]', '["all", `w:${w}`, `t:${token}`]', T, "unpaid sell gas:"],
  [EVM, '["all", `w:${w}`, `t:${token}`, ...(client', '["all", `w:${w}`, ...(client', T, "unpaid sell gas:"],
  [EVM, '["all", `w:${w}`, `t:${token}`, ...(client', '["all", `t:${token}`, ...(client', T, "unpaid sell gas:"],
  [EVM, '["all", `w:${w}`, `t:${token}`, ...(client', '[`w:${w}`, `t:${token}`, ...(client', T, "withdraws still go while sales answer 429:"],
  [EVM, 'const cap = k === "all" ? EVM_SELL_UNPAID_BUDGET_WEI : EVM_SELL_UNPAID_CAP_WEI;', "const cap = EVM_SELL_UNPAID_CAP_WEI;", T, "withdraws still go while sales answer 429:"],
  // fold 1, H2.3: the sell sender's own key
  [EVM, '    if (cfg.sellKey === undefined || sellSender === null) return no(503, "not_configured"', '    if (false) return no(503, "not_configured"', T, "the sell sender:"],
  [EVM, "  if (sellSender === sender) throw", "  if (false) throw", T, "the sell sender:"],
  [EVM, 'a("eth_getTransactionCount", [from, "pending"])', 'a("eth_getTransactionCount", [sender, "pending"])', T, "the sell sender:"],
  [EVM, "    const { raw, hash } = signEvmTx4(txAt(maxFeePerGas), key);", "    const { raw, hash } = signEvmTx4(txAt(maxFeePerGas), cfg.senderKey);", T, "a good sell:"],
  [EVM, '      await a("eth_call", [{ from, to: w, data, gas:', '      await a("eth_call", [{ from: sender, to: w, data, gas:', T, "a good sell:"],
  [EVM, "pin.toLowerCase() !== s.sellSender)", "pin.toLowerCase() !== s.sender)", T2, "the EVM pool sell sender's address"],
  [EVM, '    if (sellKey !== "" && sellKey === key) throw', "    if (false) throw", T2, "the EVM pool sell sender's address"],
  // fold 1, L1: the deadline again after the queue's wait, the sale's and the withdraw's
  [EVM, "    if (s.deadline * 1000n < BigInt(Math.floor(now())) + BigInt(EVM_POOL_SEND_MARGIN_MS)) return", "    if (false) return", T, "the deadline again after the queue's wait:"],
  [EVM, "    if (Number(w.deadlineMs) < now() + EVM_POOL_SEND_MARGIN_MS) return", "    if (false) return", T2, "the withdraw's deadline again after the queue's wait:"],
  // fold 2 and 4, H-N2 and H2: neither lane leaves a nonce no tx holds, and no one provider moves a lane (a lane goes at
  // the lower pending count, fills a hole only below both, mined only past both latest counts)
  [EVM, "    if (nonce + 1n > lane.nextNonce) lane.nextNonce = nonce + 1n;", "    lane.nextNonce = nonce + 1n;", T, "a nonce hole on the sell lane (N2)"],
  [EVM, "    const lo = lower(pa, pb);", "    const lo = higher(pa, pb);", T, "one provider's count never moves a lane (Q2-A)"],
  [EVM, "    if (lo >= lane.nextNonce) return lo;", "", T, "a good sell:"],
  [EVM, "    const n = higher(pa, pb);", "    const n = lower(pa, pb);", T, "the sell sender's pending count is read on both providers"],
  [EVM, "    if (n >= lane.nextNonce) return null;", "", T, "one provider's count never moves a lane (Q2-A)"],
  [EVM, "    if (now() - x.at <= EVM_SELL_DROP_MARGIN_MS) return null;", "    if (now() - x.at < EVM_SELL_DROP_MARGIN_MS) return null;", T, "a nonce hole on the sell lane (N2)"],
  [EVM, "    if (now() - x.at <= EVM_SELL_DROP_MARGIN_MS) return null;", "", T, "a nonce hole on the sell lane (N2)"],
  [EVM, "    const nonce = await nonceFor(withdrawLane, pa, pb);", "    const nonce = pa > withdrawLane.nextNonce ? pa : withdrawLane.nextNonce;", T, "a nonce hole on the withdraw lane"],
  [EVM, "the authorization's ${auth.nonce}`);\n      [pa, pb] = [qty(n), qty(m)];", "the authorization's ${auth.nonce}`);\n      [pa, pb] = [qty(n), qty(n)];", T, "the sell sender's pending count is read on both providers"],
  [EVM, "      tip = qty(t);\n      [pa, pb] = [qty(n), qty(m)];", "      tip = qty(t);\n      [pa, pb] = [qty(n), qty(n)];", T, "the sell sender's pending count is read on both providers"],
  [EVM, "    prune(lane, lower(la, lb));", "    prune(lane, higher(la, lb));", T, "one provider's count never moves a lane (Q2-A)"],
  [EVM, "    for (const n of [...lane.sent.keys()]) if (n < mined) lane.sent.delete(n);", "", T, "a stuck sale on the sell lane"],
  // fold 4, M1: a hole only where neither provider returns the lane's send by hash
  [EVM, "    return seen.every((y) => y.status === \"fulfilled\" && y.value === null) ? n : null;", "    return n;", T, "a hole is only where neither provider returns the lane's send by hash (Q1)"],
  // fold 4, H2 (2): a send unmined past its deadline plus the margin is replaced once at its nonce, whatever its price;
  // fold 3's pricing (2 x the base fee now + tip, a tenth over, never over the ceiling)
  [EVM, "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.stuckAfter || now() > x.bound)", "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.bound)", T, "a stuck sale on the sell lane"],
  [EVM, "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.stuckAfter || now() > x.bound)", "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.bound)", T, "a stuck withdraw on the withdraw lane"],
  [EVM, "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.stuckAfter || now() > x.bound)", "const todo: [bigint, Sent | undefined, boolean][] = [...lane.sent].filter(([, x]) => now() > x.stuckAfter)", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", "        const covers = old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", T, "a sale one provider's stale pool still counts (Q5)"],
  [EVM, "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", "        const covers = old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", T, "a stuck sale that covers 2 x base + tip"],
  [EVM, "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", "        const covers = old!.replacement && old!.maxFee > 2n * base + tipNow && old!.tip >= tipNow;", T, "at a steady base fee, a stuck sale"],
  [EVM, "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow;", T, "a stuck replacement whose maxFeePerGas still covers"],
  [EVM, "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip >= tipNow;", "        const covers = old!.replacement && old!.maxFee >= 2n * base + tipNow && old!.tip > tipNow;", T, "a stuck replacement whose maxFeePerGas still covers"],
  [EVM, "        if (covers && !gone) continue;", "", T, "at a steady base fee, a stuck sale"],
  [EVM, "        if (covers && !gone) continue;", "        if (covers) continue;", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "        again = covers && old!.raw !== undefined;", "        again = false;", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "    const raise = (v: bigint) => (v * 11n) / 10n + 1n;", "    const raise = (v: bigint) => v;", T, "a stuck sale on the sell lane"],
  [EVM, "    const maxFee = higher(2n * base + tip, old === undefined ? 0n : raise(old.maxFee));", "    const maxFee = old === undefined ? 2n * base + tip : raise(old.maxFee);", T, "a stuck sale on the sell lane"],
  [EVM, "    if (maxFee > EVM_SELL_MAX_FEE_PER_GAS) {", "    if (false) {", T, "a base fee whose 2 x base + tip is over"],
  [EVM, "    if (maxFee > EVM_SELL_MAX_FEE_PER_GAS) {", "    if (maxFee >= EVM_SELL_MAX_FEE_PER_GAS) {", T, "at exactly EVM_SELL_MAX_FEE_PER_GAS"],
  [EVM, "      if (!lane.ceilingSaid) log(", "      log(", T, "a base fee whose 2 x base + tip is over"],
  [EVM, "maxFeePerGas: maxFee, gas, to: lane.from, data: new Uint8Array() }, key);", "maxFeePerGas: maxFee, gas, to: pool, data: new Uint8Array() }, key);", T, "a stuck sale on the sell lane"],
  [EVM, "    watch(withdrawLane, nonce, hash, until);", "", T, "a stuck withdraw on the withdraw lane"],
  // fold 4, L1: a replacement's gas, 21,000, and on Robinhood the L1 poster's gas from the kit's ArbGasInfo read
  [EVM, "    let gas = EVM_SELF_TRANSFER_GAS;", "    let gas = EVM_POOL_SELL_GAS;", T, "a stuck sale on the sell lane"],
  [EVM, "    if (POSTER_GAS_CHAINS.has(cfg.network)) {", "    if (false) {", T, "the replacement's gas on Robinhood"],
  [EVM, "[a, b].map(async (r) => evmPoolChainFee(net, txBytes", "[a, a].map(async (r) => evmPoolChainFee(net, txBytes", T, "the replacement's gas on Robinhood"],
  [EVM, "      gas += poster + (poster + 4n) / 5n;", "      gas += poster;", T, "the replacement's gas on Robinhood"],
  // fold 4, L1: a failing tend logs once and is never recorded as sent
  [EVM, "    if (sent.every((x) => x.status === \"rejected\")) throw new Error(`both providers refused the replacement at nonce ${n}:", "    if (false) throw new Error(`both providers refused the replacement at nonce ${n}:", T, "a tend that fails logs once"],
  [EVM, "        if (!lane.failSaid) log(", "        log(", T, "a tend that fails logs once"],
  [EVM, "        lane.failSaid = false;", "", T, "a tend that fails logs once"],
  // fold 4, H2 (3): every watch ends (a receipt, the lane's replacement, or its bound with one log line); a lane whose
  // lowest unmined send is past its bound answers 503 with Retry-After
  [EVM, "      if (mine === undefined || lane.sent.get(nonce) !== mine) return;", "      if (mine === undefined) return;", T, "at a steady base fee, a stuck sale"],
  [EVM, "      if (now() > bound) {", "      if (false) {", T, "a lane's watch ends at its bound"],
  [EVM, "      if (now() - sent > EVM_SELL_DROP_MARGIN_MS) tend(lane);", "", T, "an idle hole on the sell lane"],
  [EVM, "      if (now() - sent > EVM_SELL_DROP_MARGIN_MS) tend(lane);", "", T, "a stuck sale on the sell lane"],
  [EVM, "      const stuck = await laneHeld(sellLane);", "      const stuck = null;", T, "a lane's watch ends at its bound"],
  [EVM, "      if (low === undefined || now() <= low[1].bound) return undefined;", "      return undefined;", T, "a lane's watch ends at its bound"],
  // fold 5: a held lane recovers (a held answer tends at most once per EVM_LANE_RETRY_S and reads again; a send with a
  // receipt on either provider is mined; a nonce's bound is kept by its resends; one provider's count never releases it)
  [EVM, "    if (low !== undefined && lane.key !== undefined && now() - lane.heldTendAt >= EVM_LANE_RETRY_S * 1000) {", "    if (false) {", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "    if (low !== undefined && lane.key !== undefined && now() - lane.heldTendAt >= EVM_LANE_RETRY_S * 1000) {", "    if (low !== undefined && lane.key !== undefined) {", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "      r = read();", "      r = { at: r.at, low: Promise.resolve(low) };", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "      if (!(await usedAt(low[1]))) return low;", "      return low;", T, "a lane held while the chain halts"],
  [EVM, "    return rc.some((y) => y.status === \"fulfilled\" && y.value !== null && typeof y.value === \"object\");", "    return rc.every((y) => y.status === \"fulfilled\" && y.value !== null && typeof y.value === \"object\");", T, "a lane held while the chain halts"],
  [EVM, "    prune(lane, lower(c.la, c.lb));", "    prune(lane, higher(c.la, c.lb));", T, "a lane's watch ends at its bound"],
  [EVM, "bound: bound ?? stuckAfter + EVM_LANE_WATCH_MS,", "bound: stuckAfter + EVM_LANE_WATCH_MS,", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "    const bound = mine?.bound ?? until + EVM_LANE_WATCH_MS;", "    const bound = until + EVM_LANE_WATCH_MS;", T, "a lane held behind a nonce the chain dropped"],
  [EVM, "        if (sent <= bound) log(", "        log(", T, "a lane's watch ends at its bound"],
  // fold 5, MEDIUM: one provider's "not found" never cancels a live send; the poster's gas on the lower base fee
  [EVM, "    return seen.every((y) => y.status === \"fulfilled\" && y.value === null) ? n : null;", "    return seen.some((y) => y.status === \"fulfilled\" && y.value === null) ? n : null;", T, "a hole is only where neither provider returns the lane's send by hash (Q1)"],
  [EVM, "        const baseLow = lower(xa, xb);", "        const baseLow = higher(xa, xb);", T, "the replacement's gas on Robinhood"],
  // fold 4, M2: a withdraw repeat frees its nullifier when its first send was dropped or the lane's replacement took it
  [EVM, "      if (end === \"waiting\") return first;", "      return first;", T, "a withdraw repeat after its first send was dropped"],
  [EVM, "    if (superseded.has(hash)) return \"dropped\";", "", T, "a withdraw repeat whose first send the lane's replacement took"],
  [EVM, "      superseded.add(old.hash);", "", T, "a withdraw repeat whose first send the lane's replacement took"],
  // fold 4, H1: the budget holds every sale; a paid landing (in the window, paid its cost) frees only the token's cap
  [EVM, "      if (known && k.startsWith(\"t:\")) continue;", "      if (known) continue;", T, "the sender's whole budget holds every sale (H1)"],
  [EVM, "      if (known && k.startsWith(\"t:\")) continue;", "", T, "a paid landing frees its caller of the token's cap only"],
  [EVM, "(k.startsWith(\"w:\") || k.startsWith(\"c:\")) && (paid.get(k) ?? -Infinity) > t - EVM_SELL_UNPAID_WINDOW_MS", "(k.startsWith(\"w:\") || k.startsWith(\"c:\")) && paid.has(k)", T, "a paid landing is one in the window that paid its cost"],
  [EVM, "(k.startsWith(\"w:\") || k.startsWith(\"c:\")) && (paid.get(k)", "k.startsWith(\"w:\") && (paid.get(k)", T, "a paid landing frees its caller of the token's cap only"],
  [EVM, "    if (!ok || cost > fee) return;", "    if (!ok) return;", T, "a paid landing is one in the window that paid its cost"],
  [EVM, "    if (!ok || cost > fee) return;", "    return;", T, "a paid landing frees its caller of the token's cap only"],
  // fold 2, L-poll: the receipt watch backs off
  [EVM, "      every = Math.min(every * 2, first * EVM_RECEIPT_POLL_BACKOFF);", "", T, "the receipt watch backs off"],
  // fold 2, L-pin: a chain with no pin starts with sales off
  [EVM, '    const sells = sellKey !== "" && pin !== undefined;', '    const sells = sellKey !== "";', T2, "the EVM pool sell sender's address"],
  // fold 6, M1: a nonce is used once either provider returns a receipt for any send the lane made at it
  [EVM, "    const rc = await Promise.allSettled([x.hash, ...x.prior].flatMap(", "    const rc = await Promise.allSettled([x.hash].flatMap(", T, "a replaced sale that mined is counted"],
  [EVM, "    const prior = old === undefined ? [] : [...old.prior, ...(old.hash === hash ? [] : [old.hash])].slice(-EVM_LANE_PRIOR_MAX);", "    const prior: string[] = [];", T, "a replaced sale that mined is counted"],
  [EVM, "    const prior = old === undefined ? [] : [...old.prior, ...(old.hash === hash ? [] : [old.hash])]", "    const prior = old === undefined ? [] : [...old.prior]", T, "a replaced sale that mined is counted"],
  [EVM, "        if (await usedAt(old!)) {", "        if (false) {", T, "a stuck replacement whose earlier send mined"],
  [EVM, "        lane.sent.delete(nonce); // a receipt for any send at the nonce: it is used", "        if (lane.sent.get(nonce) === mine) lane.sent.delete(nonce);", T, "a sale that mines as its replacement goes"],
  // fold 6, M2: a held answer whose tend sent something waits one block
  [EVM, "    const wait = sent > 0 ? EVM_LANE_SENT_RETRY_S : Math.max(", "    const wait = sent > 0 ? EVM_LANE_RETRY_S : Math.max(", T, "a held answer whose tend sent something"],
  [EVM, "    const wait = sent > 0 ? EVM_LANE_SENT_RETRY_S : Math.max(1, Math.ceil((Math.min(nextTend, mined) - now()) / 1000));", "    const wait = sent > 0 ? EVM_LANE_SENT_RETRY_S : EVM_LANE_RETRY_S;", T, "callers obeying Retry-After through a heal"],
  [EVM, "      sent = await tendOnce(lane);", "      await tendOnce(lane);", T, "a held answer whose tend sent something"],
  [EVM, "        made.n++;\n        const until = now() + EVM_SELL_DROP_MARGIN_MS;\n        sentAt(lane, n, until, old!.maxFee", "        const until = now() + EVM_SELL_DROP_MARGIN_MS;\n        sentAt(lane, n, until, old!.maxFee", T, "a held answer whose tend sent something"],
  [EVM, "      made.n++;\n      lane.ceilingSaid = false;", "      lane.ceilingSaid = false;", T, "a lane's watch ends at its bound"],
  // fold 6, M3: the rebroadcast, the busy lane and the hold's reads
  [EVM, "        if (sent.every((x) => x.status === \"rejected\")) throw new Error(`both providers refused the replacement at nonce ${n} again:", "        if (false) throw new Error(`both providers refused the replacement at nonce ${n} again:", T, "a held answer whose tend sent something"],
  [EVM, "        watch(lane, n, old!.hash, until);", "", T, "a dropped replacement within its nonce's bound"],
  [EVM, "        const until = now() + EVM_SELL_DROP_MARGIN_MS;\n        sentAt(lane, n, until, old!.maxFee", "        const until = old!.stuckAfter;\n        sentAt(lane, n, until, old!.maxFee", T, "a rebroadcast's watch starts its margin again"],
  [EVM, "      if (low === undefined || now() <= low[1].bound) return undefined;", "      if (low === undefined) return undefined;", T, "a busy lane is held only"],
  [EVM, "    if (![...lane.sent.values()].some((x) => now() > x.bound)) return null;", "", T, "a lane with no send past its bound reads no counts"],
  // fold 6, L1: a stuck send's reads at most once per margin
  [EVM, "        if (now() - old!.checkedAt < EVM_SELL_DROP_MARGIN_MS) continue;", "", T, "a halt's stuck sends are each read"],
  [EVM, "        old!.checkedAt = now();", "", T, "a halt's stuck sends are each read"],
  // fold 6, L2: a provider whose latest count stays below a sent nonce is logged once
  [EVM, "      if (x !== null && !x.said && now() - x.since >= EVM_LANE_WATCH_MS) {", "      if (x !== null && !x.said) {", T, "a provider whose latest count stays below"],
  [EVM, "        x.said = true;", "", T, "a provider whose latest count stays below"],
  [EVM, "      if (x !== null && l > x.nonce) x = null;", "", T, "a provider whose latest count stays below"],
  [EVM, "      if (x !== null && l > x.nonce) x = null;", "      if (x !== null && l >= x.nonce) x = null;", T, "a provider whose latest count stays below"],
  [EVM, "      if (x === null && l < lane.nextNonce) x = {", "      if (x === null) x = {", T, "a provider whose latest count stays below"],
  [EVM, "    behindOf(sellLane, qty(ln), qty(lm));", "", T, "a provider whose latest count stays below"],
  [EVM, "    behindOf(withdrawLane, qty(ln), qty(lm));", "", T, "a provider whose latest count stays below"],
  [EVM, "    behindOf(lane, la!, lb!);", "", T, "a held answer whose tend sent something"],
  // fold 7: a held answer's wait, one hold read per block, the prior hashes kept, a provider ahead
  [EVM, "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;", "    const mined = Infinity;", T, "callers obeying Retry-After through a heal"],
  [EVM, "      if (sent > 0) lane.heldSentAt = now();", "", T, "callers obeying Retry-After through a heal"],
  [EVM, "    let r = lane.heldRead !== null && now() - lane.heldRead.at < block ? lane.heldRead : read();", "    let r = read();", T, "held answers share one hold read per block"],
  [EVM, "        lane.failSaid = true;\n        return made.n;", "        lane.failSaid = true;\n        return 0;", T, "a held answer whose tend sent something before it failed"],
  [EVM, "    const prior = old === undefined ? [] : [...old.prior, ...(old.hash === hash ? [] : [old.hash])]", "    const prior = old === undefined ? [] : [...old.prior, old.hash]", T, "more sends of the same replacement than EVM_LANE_PRIOR_MAX"],
  [EVM, ".slice(-EVM_LANE_PRIOR_MAX);", ".slice(0, EVM_LANE_PRIOR_MAX);", T, "a nonce's record keeps its newest EVM_LANE_PRIOR_MAX"],
  [EVM, "      if (x === null && l < lane.nextNonce) x = {", "      if (x === null && l <= lane.nextNonce) x = {", T, "an idle lane is never named behind"],
  [EVM, "      if (lane.nextNonce >= 0n && l > lane.nextNonce && !lane.ahead[i]) {", "      if (false) {", T, "a provider whose latest count is past"],
  [EVM, "        lane.ahead[i] = true;", "", T, "a provider whose latest count is past"],
  // fold 8: a held send's window of one-block retries, the wait's rounding, a failed hold read shared for its block
  [EVM, "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;", "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS - 2_000 > now() ? now() + block : Infinity;", T, "callers obeying Retry-After go within one retry"],
  [EVM, "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;", "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS + 2_000 > now() ? now() + block : Infinity;", T, "a held answer's Retry-After"],
  [EVM, "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;", "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS >= now() ? now() + block : Infinity;", T, "a held answer's Retry-After"],
  [EVM, "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? now() + block : Infinity;", "    const mined = lane.heldSentAt + EVM_LANE_SENT_WINDOW_MS > now() ? lane.heldSentAt + block : Infinity;", T, "a held answer's Retry-After"],
  [EVM, "Math.max(1, Math.ceil((Math.min(nextTend, mined) - now()) / 1000))", "Math.max(1, Math.floor((Math.min(nextTend, mined) - now()) / 1000))", T, "a held answer's Retry-After"],
  [EVM, "      r.low.catch(() => {}); // a failed read is shared too: its whole block answers from it", "      r.low.catch(() => {\n        if (lane.heldRead === r) lane.heldRead = null;\n      });", T, "a hold read that fails"],
  [EVM, "      return { ...u, retryAfterS: Math.max(u.retryAfterS ?? 0, Math.max(1, Math.ceil((r.at + block - now()) / 1000))) };", "      return u;", T, "a hold read that fails"],
  [EVM, "Math.max(1, Math.ceil((r.at + block - now()) / 1000))", "Math.max(1, Math.floor((r.at + block - now()) / 1000))", T, "a hold read that fails"],
];

// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`; a
// run past 120 s is killed, its process group with it (scripts/group-run.mjs), and counts as a fail
let lastFail = "";
function run(dir, file, name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, file];
  const r = runSync("node", args, { cwd: dir, stdio: "pipe", encoding: "utf8", timeoutMs: 120_000 });
  if (r.status !== 0) {
    lastFail = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 4).join("\n");
    return "fail";
  }
  return /^# pass ([1-9]\d*)$/m.test(r.stdout) ? "pass" : "none";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = mkdtempSync(join(HELPER, ".sell-mutants-"));
  let bad = 0;
  try {
    for (const p of ["src", "package.json"]) cpSync(join(HELPER, p), join(dir, p), { recursive: true });
    const src = new Map([EVM].map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    for (const [file, t] of [...new Set(MUTANTS.map((m) => `${m[3]}\u0000${m[4]}`))].map((k) => k.split("\u0000"))) {
      const r = run(dir, file, t);
      if (r !== "pass") {
        console.log(`FAIL "${t}" in ${file} ${r === "none" ? "names no test" : `fails on the code as it is:\n${lastFail}`}`);
        bad++;
      }
    }
    if (bad === 0) {
      MUTANTS.forEach(([file, find, repl, tf, t], i) => {
        const s = src.get(file);
        if (s.split(find).length !== 2) {
          console.log(`FAIL mutant ${i + 1}: its text is not in ${file} exactly once`);
          bad++;
          return;
        }
        writeFileSync(join(dir, file), s.replace(find, repl));
        const r = run(dir, tf, t);
        writeFileSync(join(dir, file), s);
        console.log(`${r === "fail" ? "ok  " : "FAIL"} mutant ${i + 1}: ${find.split("\n")[0].trim().slice(0, 70)} -> "${t}" ${r === "fail" ? "fails" : "PASSES"}`);
        if (r !== "fail") bad++;
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad === 0 ? `every one of ${MUTANTS.length} mutants fails its named test` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
