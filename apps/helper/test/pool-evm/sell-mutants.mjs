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
// (fee >= gas x (base + tip) + L1 exactly when (fee - L1) / gas >= base + tip; both are removed together below).
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = fileURLToPath(new URL("../..", import.meta.url));
const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-sell.test.ts";
const T2 = "src/pool/evm.test.ts";

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
  [EVM, "  if (![t(0), t(2), t(5)].every(isAddressWord)) throw new Error(\"an address's padding\");", "", T, "bad_shape:"],
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
  [EVM, "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, s.deadline, s.nonce].map(w32);", "const rest = [s.minOut, BigInt(s.pool), s.precommitment, s.feeCap, s.nonce, s.deadline].map(w32);", T, "the helper's sell digest is SellDelegate's"],
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
  [EVM, "        l1 = words[0]! > words[1]! ? words[0]! : words[1]!;", "        l1 = words[0]!;", T, "the base fee and the L1 bound"],
  [EVM, "        l1 = words[0]! > words[1]! ? words[0]! : words[1]!;", "        l1 = words[1]!;", T, "the base fee and the L1 bound"],
  [EVM, "        l1 = words[0]! > words[1]! ? words[0]! : words[1]!;", "        l1 = 0n;", T, "the fee is bounded:"],
  [EVM, 'const L1_FEE_CHAINS: ReadonlySet<string> = new Set(["base", "base-sepolia"]);', 'const L1_FEE_CHAINS: ReadonlySet<string> = new Set(["base", "base-sepolia", "robinhood-testnet"]);', T, "the fee is bounded:"],
  // fold 1, M3 (a): Base itself reads the L1 oracle (a delegate pinned on base through cfg.venues)
  [EVM, 'const L1_FEE_CHAINS: ReadonlySet<string> = new Set(["base", "base-sepolia"]);', 'const L1_FEE_CHAINS: ReadonlySet<string> = new Set(["base-sepolia"]);', T, "on Base, a pinned delegate's sale reads the L1 oracle"],
  [EVM, "big(1n), big(U256_MAX), big(U256_MAX)]).length;", "big(1n), big(1n), big(1n)]).length;", T, "a good sell:"],
  // the transaction as sent
  [EVM, "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = cap;", T, "a good sell:"],
  [EVM, "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip;", T, "the fee is bounded:"],
  [EVM, '    if (s.fee < need) return no(422, "fee_low", `fee ${s.fee}, need ${gas} x (${base} + ${tip}) + ${l1} = ${need}`);\n    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;\n    if (maxFeePerGas < base + tip) return no(422, "fee_low", `maxFeePerGas ${maxFeePerGas} under ${base} + ${tip}`);', "    const cap = (s.fee - l1) / gas;\n    const maxFeePerGas = 2n * base + tip < cap ? 2n * base + tip : cap;", T, "the fee is bounded:"],
  [EVM, "    const gas = EVM_POOL_SELL_GAS;", "    const gas = EVM_POOL_SELL_GAS + 1n;", T, "a good sell:"],
  [EVM, "    const tip = evmPoolSellTip(kitChain);", "    const tip = 0n;", T, "a good sell:"],
  [EVM, "gas: tag(gas - EVM_7702_AUTH_GAS), maxFeePerGas: tag(maxFeePerGas)", "gas: tag(gas), maxFeePerGas: tag(maxFeePerGas)", T, "a good sell:"],
  [EVM, ', "pending", { [w]: { code: `0xef0100${delegate.slice(2)}` } }]);', ', "pending"]);', T, "a good sell:"],
  [EVM, "    } catch (e) {\n      return failedInExecution(e) ? no(422, \"simulation_failed\", String((e as Error).message).slice(0, 200)) : unread(e);\n    }\n    const { raw, hash } = signEvmTx4(", "    } catch (e) {\n      void e;\n    }\n    const { raw, hash } = signEvmTx4(", T, "a sim that reverts"],
  [EVM, "  const raw = Uint8Array.from([4, ...rlp([...fields, big(BigInt(sig[0]!)), big(r), big(s)])]);", "  const raw = Uint8Array.from([2, ...rlp([...fields, big(BigInt(sig[0]!)), big(r), big(s)])]);", T, "a good sell:"],
  [EVM, "  const digest = keccak_256(Uint8Array.from([4, ...rlp(fields)]));", "  const digest = keccak_256(Uint8Array.from([2, ...rlp(fields)]));", T, "a good sell:"],
  [EVM, "big(a.nonce), big(a.yParity), big(a.r), big(a.s)]),", "big(a.nonce), big(a.yParity), big(a.r), big(a.r)]),", T, "a good sell:"],
  [EVM, "authorizations: [auth] });", "authorizations: [] });", T, "a good sell:"],
  [EVM, "    sellLane.nextNonce = nonce + 1n;\n", "", T, "once per (W, Sell nonce):"],
  // fold 1, M3 (b): one provider refusing the send still sends, and the next sale takes nonce + 1
  [EVM, "    if (why.length === sent.length) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);\n    sellLane.nextNonce", "    if (why.length > 0) return unread(why.find((e) => throttleOf(e, true) > 0) ?? why[0]);\n    sellLane.nextNonce", T, "one provider refusing the send:"],
  // the fee answer
  [EVM, "fee_recipient: feeRecipient, sell_sender: sellSender, epoch_ms", "fee_recipient: feeRecipient, sell_sender: sender, epoch_ms", T, "the fee answer names"],
  // fold 1, H1: a sale that did not land frees its (W, nonce), on both providers' reads, capped per W
  [EVM, '    if (status.includes("0x0")) return true;', "    if (false) return true;", T, "a sale that reverted or was dropped"],
  [EVM, '    if (status.includes("0x1")) return false;', "", T, "a sale that reverted or was dropped"],
  [EVM, "    if (BigInt(Math.floor(now())) <= deadlineS * 1000n) return false;", "", T, "a sale that reverted or was dropped"],
  [EVM, '    return tx.every((x) => x.status === "fulfilled" && x.value === null);', '    return tx.some((x) => x.status === "fulfilled" && x.value === null);', T, "a sale that reverted or was dropped"],
  [EVM, '    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash]), b("eth_getTransactionReceipt", [hash])]);\n    const status', '    const rc = await Promise.allSettled([a("eth_getTransactionReceipt", [hash])]);\n    const status', T, "a sale that reverted or was dropped"],
  [EVM, "        if (recent.length >= EVM_SELL_FREES_MAX) return", "        if (false) return", T, "a sale that reverted or was dropped"],
  // fold 1, H2.1: only a route the kit's sell builder makes (the kit's own checks: packages/kit/test/evm-sell-route-of.test.ts)
  [EVM, "      evmSellRouteOf(sellChain, { w, token: s.token, amount: s.amount, minOut: s.minOut, target: s.target, data: s.data });", "      void { w, token: s.token, amount: s.amount, minOut: s.minOut, target: s.target, data: s.data };", T, "bad_route:"],
  // fold 1, H2.2: the unpaid-gas caps
  [EVM, "    const capped = overCap(keys, worst);\n    if (capped !== null) return capped;", "", T, "unpaid sell gas:"],
  [EVM, '        held.wei = evmRpcHex(r.status) === "0x1" ? (cost > fee ? cost - fee : 0n) : cost;', "        held.wei = cost;", T, "unpaid sell gas:"],
  [EVM, '        held.wei = evmRpcHex(r.status) === "0x1" ? (cost > fee ? cost - fee : 0n) : cost;', "        held.wei = 0n;", T, "unpaid sell gas:"],
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
];

// "pass", "fail" or "none" (no test ran) of the tests in `file` whose names start with `name`, in the copy `dir`; a
// run past 120 s is killed and counts as a fail
let lastFail = "";
function run(dir, file, name) {
  const args = ["--test", "--test-reporter=tap", "--test-name-pattern", `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, file];
  try {
    const out = execFileSync("node", args, { cwd: dir, stdio: "pipe", encoding: "utf8", timeout: 120_000 });
    return /^# pass ([1-9]\d*)$/m.test(out) ? "pass" : "none";
  } catch (e) {
    lastFail = `${e.stdout ?? ""}${e.stderr ?? ""}`.split("\n").filter((l) => /error|Error|not ok/.test(l)).slice(0, 4).join("\n");
    return "fail";
  }
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
