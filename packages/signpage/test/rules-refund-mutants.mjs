// Removes or weakens each of src/rules/refund.ts's checks, one at a time, and runs the test named for it in
// test/rules-refund.test.ts: each named test passes on the code as it is and fails on every mutant. A mutant is written
// to a copy beside refund.ts (src/rules/.refund-mutant-<pid>.ts) and run by a copy of the test file that imports it, all
// removed after: refund.ts itself is never changed, so a test run at the same time never reads a mutant. Exits 1 when a
// named test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in refund.ts
// exactly once. test/rules-refund-mutants.test.mjs runs it in the package's test:mutants.
//   node packages/signpage/test/rules-refund-mutants.mjs
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";

const SRC = fileURLToPath(new URL("../src/rules/refund.ts", import.meta.url));
const TEST = fileURLToPath(new URL("./rules-refund.test.ts", import.meta.url));
const MUTANT_SRC = fileURLToPath(new URL(`../src/rules/.refund-mutant-${process.pid}.ts`, import.meta.url));
const MUTANT_TEST = fileURLToPath(new URL(`./.rules-refund-mutant-${process.pid}.test.ts`, import.meta.url));
const IMPORT = 'await import("../src/rules/refund.ts");';

const GOOD = "refund move: a good quote and its one transfer intent sign as the id";
const RQ = "refund move quote: each bad request field is refused";
const KIT = "refund move quote: the answer goes through the kit's check, its output into the vault";
const TR = "id intent: each bad field of the transfer is refused";
const DL = "id intent: the deadline is the lower final-block time + 120 s";
const ONLY = "id intent: only a quote a check returned, for this id";
const WD = "withdraw from an id to another chain: a good quote and transfer sign";
const WQ = "withdraw from an id to another chain: each bad quote field is refused";
const FT = "ft_withdraw out of intents.near: to a typed account, signed; each bad field refused";
const SOLOK = "return on Solana: a good quote and W's one transfer";
const RETQ = "return quote: each bad field is refused";
const SOL = "return on Solana: each bad field of W's send is refused";
const EVMOK = "return on Base: W's one plain send";
const EVM = "return on EVM: each bad field of W's send is refused";
const RHOK = "return on Robinhood: W's one plain send at the two RPCs' gas estimate signs as W";
const RH = "return on Robinhood: each bad gas or fee field is refused";
const DEPADDR = "return quote: the signed deposit address is an address of the chain and never W";
const QDL = "id intent: it dies before the quote's deposit address does";
const NET = "id intents: mainnet only";
const SLIP = "quotes: the slippage is at most the device's own 100 bps";
const VAULT = "never the vault: an injected vault id is refused";
const FTA = "ft_withdraw out of intents.near: every USDC the deposit path takes, each to its own pinned code hash";
const ONCE = "one ask, one signature";

// [text in refund.ts, its replacement, the test that must fail]
export const MUTANTS = [
  // the quotes
  ['  if (req.dry !== false) return refuse("dry");\n', "", RQ],
  ['  if (req.swapType !== "EXACT_INPUT") return refuse("swapType");\n', "", RQ],
  ['if (Object.keys(req).some((k) => !QUOTE_KEYS.has(k))) return refuse("request");', "", RQ],
  ['  if (s.role === "R") return refuse("signer"); // a return\'s refund goes to W on its own chain, never under R\n', "", RQ],
  ['  if (req.recipient !== s.id) return refuse("recipient");\n  if (req.recipientType !== "DESTINATION_CHAIN") return refuse("recipientType");\n  if (req.refundTo !== s.id) return refuse("refundTo");\n  if (req.refundType !== "INTENTS") return refuse("refundType");\n  const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });\n  return passQuote(checked, { kind: "refund"', '  const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });\n  return passQuote(checked, { kind: "refund"', RQ],
  ['const checked = checkOneClickQuote(req, answer, { ...ctx.check, intoVault: true });\n  return passQuote(checked, { kind: "refund"', 'const checked = checkOneClickQuote(req, answer, { intoVault: true, ...ctx.check });\n  return passQuote(checked, { kind: "refund"', KIT],
  ['  if (req.destinationAsset === DEPOSIT_DESTINATION_ASSET) return refuse("destinationAsset");\n', "", WQ],
  ['typed === s.id || typed === INTENTS || typed === net.usdc ||', "typed === s.id ||", WQ],
  ['  if (req.recipient !== typed) return refuse("recipient");\n', "", WQ],
  ["typed === s.id || typed === INTENTS", "typed === INTENTS", WQ],
  ['  if (ctx.ownArm !== true) return refuse("own_arm");\n', "", RETQ],
  ['  if (req.refundTo !== w) return refuse("refundTo");\n', "", RETQ],
  ['  if (req.refundType !== "ORIGIN_CHAIN") return refuse("refundType");\n', "", RETQ],
  ['  if (req.originAsset !== RETURN_NATIVE[chain]) return refuse("originAsset");\n', "", RETQ],
  ['  if (r.role !== "R") return refuse("recipient");\n', "", RETQ],
  // the intent's frame
  ['if (!isObj(p) || JSON.stringify(p) !== payload || !keysExactly(', "if (!isObj(p) || !keysExactly(", TR],
  ['  if (p.signer_id !== s.id) return refuse("signer_id");\n', "", TR],
  ['  if (p.verifying_contract !== INTENTS) return refuse("verifying_contract");\n', "", TR],
  ['const held = agreed([reads[0].held, reads[1].held], isU, "held");', "const held = reads[0].held;", TR],
  ["if (deadlineMs !== lowMs + ID_INTENT_WINDOW_MS || deadlineMs <= highMs)", "if (deadlineMs > lowMs + ID_INTENT_WINDOW_MS || deadlineMs <= highMs)", DL],
  ["|| deadlineMs <= highMs) return refuse", ") return refuse", DL],
  ['if (Number.isNaN(prior) || !(lowMs > prior)) return refuse("prior_deadline");', 'if (Number.isNaN(prior) || !(highMs > prior)) return refuse("prior_deadline");', DL],
  ['|| VERSIONED_NONCE_V1.some((b, k) => n[k] !== b)) return refuse("nonce");', ') return refuse("nonce");', DL],
  ['  if (new DataView(n.buffer, n.byteOffset).getBigUint64(9, true) !== BigInt(deadlineMs) * 1_000_000n) return refuse("nonce");\n', "", DL],
  ['if (!Array.isArray(p.intents) || p.intents.length !== 1 ||', "if (!Array.isArray(p.intents) ||", TR],
  ['if (k[0] === "other" || k[0] !== k[1]) return refuse("keys");', 'if (k[0] === "other") return refuse("keys");', WD],
  ['if (k[0] === "other" || k[0] !== k[1]) return refuse("keys");', 'if (k[0] !== k[1]) return refuse("keys");', WD],
  // the transfer
  ['  if (r.signer !== s.id) return refuse("signer_id");\n', "", ONLY],
  ['if (it.intent !== "transfer" || !keysExactly(it, ["intent", "receiver_id", "tokens"])) return refuse("intent");', 'if (it.intent !== "transfer") return refuse("intent");', TR],
  ['if (typeof to !== "string" || to !== r.depositAddress) return refuse("receiver_id");', 'if (typeof to !== "string") return refuse("receiver_id");', TR],
  ["Object.keys(tokens).length !== 1 ||", "", TR],
  ['  if (BigInt(amount) !== r.amountIn) return refuse("amount");\n', "", TR],
  ["(withdraw ? held - 1n : held)", "held", WD],
  ['  if (BigInt(amount) > (withdraw ? held - 1n : held)) return refuse("held");\n', "", TR],
  // the ft_withdraw
  ['if (it.intent !== "ft_withdraw" || !keysExactly(it, ["intent", "token", "receiver_id", "amount"])) return refuse("intent");', 'if (it.intent !== "ft_withdraw") return refuse("intent");', FT],
  ['!Object.hasOwn(FT_WITHDRAW_TOKENS, token) || ', "", FTA],
  [" || ft.asset !== `nep141:${token}`) return refuse(\"token\");", ') return refuse("token");', FTA],
  ['!== FT_WITHDRAW_TOKENS[token]) return refuse("code_hash");', '=== "") return refuse("code_hash");', FT],
  ['!== FT_WITHDRAW_TOKENS[token]) return refuse("code_hash");', '!== VAULT_TOKEN_CODE_HASH) return refuse("code_hash");', FTA],
  ['if (agreed(ft.codeHash, (x) => typeof x === "string") !== FT_WITHDRAW_TOKENS[token]) return refuse("code_hash");', 'if (!Object.values(FT_WITHDRAW_TOKENS).includes(agreed(ft.codeHash, (x) => typeof x === "string"))) return refuse("code_hash");', FTA],
  ['"Ba6uZKxsuRPW5X7XVQrSnYEYScEjFLJLMqMWvZ1aS3tC"', '"11111111111111111111111111111111"', FTA],
  ['"2VUeqHTx9sk2AjDrs88HazLqS6LUgVQorjWcacotNCDP"', '"11111111111111111111111111111111"', FTA],
  ['if (typed === INTENTS || Object.hasOwn(FT_WITHDRAW_TOKENS, typed) ||', "if (typed === INTENTS || typed === NEAR_NETWORKS.mainnet.usdc ||", FTA],
  ['if (form === null || form.account !== typed || it.receiver_id !== typed) return refuse("receiver_id");', 'if (form === null) return refuse("receiver_id");', FT],
  ['  if (typed === INTENTS || Object.hasOwn(FT_WITHDRAW_TOKENS, typed) || (net.vault !== null && typed === net.vault)) return refuse("receiver_id");\n', "", FT],
  ['  if (form.kind === "named" && agreed(ft.receiverExists, (x) => typeof x === "boolean", "receiver") !== true) return refuse("receiver");\n', "", FT],
  ['  agreed(ft.receiverRegistered, (x) => typeof x === "boolean", "registration");\n', "", FT],
  ['  if (BigInt(amount) > held - 1n) return refuse("held");\n', "", FT],
  // the intent's signer
  ['  if (!read) return refuse("unchecked");\n  let pub: Uint8Array;\n  try {\n    pub = ed25519.getPublicKey(secretKey);\n  } catch {\n    return refuse("key");\n  }\n  if (hexOf(pub) !== read.signer.id)', '  let pub: Uint8Array;\n  try {\n    pub = ed25519.getPublicKey(secretKey);\n  } catch {\n    return refuse("key");\n  }\n  if (hexOf(pub) !== read.signer.id)', ONLY],
  ['  if (hexOf(pub) !== read.signer.id) return refuse("key");\n', "", ONLY],
  // the Solana send
  ['  if (m.lookups.length !== 0) return refuse("lookups");\n', "", SOL],
  ['if (typeof reads?.blockhash !== "string" || m.blockhash !== reads.blockhash) return refuse("blockhash");', "", SOL],
  ['if (signers.length !== 1 || signers[0]!.key !== q.signer) return refuse("signers");', 'if (signers.length < 1) return refuse("signers");', SOL],
  ['  if (m.instructions.length !== 1) return refuse("instructions");\n', "", SOL],
  ['|| d[0] !== 2 || d[1] !== 0', "|| d[1] !== 0", SOL],
  ["to.key !== q.depositAddress ||", "", SOL],
  ['  if (amount !== q.amountIn) return refuse("transfer_amount");\n', "", SOL],
  ['  if (amount + fee > balance) return refuse("balance");\n', "", SOL],
  ["if (!read || read.bytes.length !== wire.length || read.bytes.some((b, i) => b !== wire[i])) return refuse(\"unchecked\");", "if (!read) return refuse(\"unchecked\");", SOLOK],
  ['  if (base58.encode(pub) !== read.wallet) return refuse("key");\n', "", SOLOK],
  // the EVM send
  ['  if (t.chainId !== EVM_CHAIN_IDS[q.chain]) return refuse("chain_id");\n', "", EVM],
  ['  if (lower(t.to) !== q.depositAddress.toLowerCase()) return refuse("transfer_to");\n', "", EVM],
  ['  if (hasCode) return refuse("to_code");\n', "", EVM],
  ['  if (t.nonce !== nonce) return refuse("nonce");\n', "", EVM],
  ['  if (t.data !== "0x") return refuse("data");\n', "", EVM],
  ['  if (t.accessList.length !== 0) return refuse("access_list");\n  if (nitro)', "  if (nitro)", EVM],
  ['} else if (t.gasLimit !== RETURN_EVM_GAS) return refuse("gas_limit");', "}", EVM],
  ['if (t.maxPriorityFeePerGas > reads.priorityCap || t.maxPriorityFeePerGas > t.maxFeePerGas) return refuse("priority_fee");', "", EVM],
  ['if (t.maxFeePerGas > 2n * baseFee + reads.priorityCap || t.maxFeePerGas < baseFee) return refuse("max_fee");', "", EVM],
  ['  if (t.value !== q.amountIn) return refuse("value");\n', "", EVM],
  ["if (t.value + t.gasLimit * t.maxFeePerGas + l1Fee > balance)", "if (t.value + t.gasLimit * t.maxFeePerGas > balance + l1Fee)", EVM],
  ['if (!isObj(tx) || Object.keys(tx).sort().join() !== SEND_KEYS || tx.type !== 2) return refuse("type");', 'if (!isObj(tx)) return refuse("type");', EVM],
  ['  if (!isU(reads.priorityCap)) return refuse("reads");\n', "", EVM],
  // the Robinhood return (Nitro)
  [" || t.gasLimit > RETURN_EVM_GAS_MAX) return refuse(\"gas_limit\");", ') return refuse("gas_limit");', RH],
  ["t.gasLimit > RETURN_EVM_GAS_MAX", "t.gasLimit >= RETURN_EVM_GAS_MAX", RH],
  ['    if (l1Fee !== 0n) return refuse("l1_fee");\n', "", RH],
  ["agreed(reads.estimate ?? undefined, isU)", "(reads.estimate?.[0] ?? t.gasLimit)", RH],
  ['const nitro = q.chain === "robinhood";', "const nitro = false;", RHOK],
  // the return's deposit address
  ['  if (chain === "solana" ? !SOL_KEY(addr) || addr === w : !EVM_ADDRESS.test(addr) || lower(addr) === lower(w)) return refuse("deposit_address");\n', "", DEPADDR],
  ["!SOL_KEY(addr) || addr === w :", "!SOL_KEY(addr) :", DEPADDR],
  ["!EVM_ADDRESS.test(addr) || lower(addr) === lower(w))", "lower(addr) === lower(w))", DEPADDR],
  ["!EVM_ADDRESS.test(addr) || lower(addr) === lower(w))", "!EVM_ADDRESS.test(addr))", DEPADDR],
  // the intent's deadline within the quote's
  ['  if (deadlineMs > r.deadlineMs) return refuse("deadline");\n', "", QDL],
  ["if (deadlineMs > r.deadlineMs)", "if (deadlineMs >= r.deadlineMs)", QDL],
  // mainnet only
  ['  if (!Object.hasOwn(NEAR_NETWORKS, ctx.network) || ctx.network !== "mainnet") return refuse("network");\n  if (typeof payload', "  if (typeof payload", NET],
  ['ctx.network !== "mainnet") return refuse("network");\n  const req', 'false) return refuse("network");\n  const req', NET],
  ['ctx.network !== "mainnet") return refuse("network");\n  const net', 'false) return refuse("network");\n  const net', NET],
  // the slippage
  ['  if (!Number.isInteger(req.slippageTolerance) || req.slippageTolerance < 0 || req.slippageTolerance > DEPOSIT_QUOTE_SLIPPAGE_BPS) return refuse("slippage");\n', "", SLIP],
  ["req.slippageTolerance > DEPOSIT_QUOTE_SLIPPAGE_BPS", "req.slippageTolerance > 10_000", SLIP],
  ["req.slippageTolerance > DEPOSIT_QUOTE_SLIPPAGE_BPS", "req.slippageTolerance >= DEPOSIT_QUOTE_SLIPPAGE_BPS", SLIP],
  ["!Number.isInteger(req.slippageTolerance) || ", "", SLIP],
  ["req.slippageTolerance < 0 || ", "", SLIP],
  // never the vault (the test's own mainnet vault id)
  [' || (net.vault !== null && typed === net.vault)) return refuse("typed");', ') return refuse("typed");', VAULT],
  ['  if (to === INTENTS || to === net.usdc || to === s.id || (net.vault !== null && to === net.vault)) return refuse("receiver_id");\n', "", VAULT],
  [" || (net.vault !== null && to === net.vault)", "", VAULT],
  [' || (net.vault !== null && typed === net.vault)) return refuse("receiver_id");', ') return refuse("receiver_id");', VAULT],
  // one ask, one signature
  ['  QUOTES.delete(quote);\n  return passIntent(', "  return passIntent(", ONCE],
  ["  INTENTS_CHECKED.delete(intent);\n", "", ONCE],
  ["if (ctx.priorDeadline !== null)", "if (ctx.priorDeadline != null)", ONCE],
  ["  QUOTES.delete(quote);\n  SOLANA_RETURN_CHECKED.set(", "  SOLANA_RETURN_CHECKED.set(", ONCE],
  ["  QUOTES.delete(quote);\n  EVM_RETURN_CHECKED.set(", "  EVM_RETURN_CHECKED.set(", ONCE],
  ["  SOLANA_RETURN_CHECKED.delete(wire);\n", "", ONCE],
  ["  EVM_RETURN_CHECKED.delete(tx);\n", "", ONCE],
  ['if (fields.some((k) => now[k] !== read[k]) || now.accessList.length !== 0) return refuse("unchecked");', "", EVMOK],
  ['  if (address !== read.wallet) return refuse("key");\n', "", EVMOK],
];

// a child test run must not inherit this process's own node --test context
const CHILD_ENV = { ...process.env, NODE_TEST_CONTEXT: undefined };
// a run past 5 min is killed, its process group with it, and counts as a fail (scripts/group-run.mjs)
const RUN_MS = 300_000;
const run = (name, file) => {
  const r = runSync(process.execPath, ["--test", "--test-timeout=120000", "--test-name-pattern", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: CHILD_ENV, timeoutMs: RUN_MS });
  if (r.status !== 0) return { ok: false, ran: true, out: String(r.stdout ?? "") };
  return { ok: true, ran: /ℹ pass [1-9]/.test(r.stdout) };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = readFileSync(SRC, "utf8");
  const test = readFileSync(TEST, "utf8");
  process.on("exit", () => { rmSync(MUTANT_TEST, { force: true }); rmSync(MUTANT_SRC, { force: true }); });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));
  if (test.split(IMPORT).length !== 2) { console.log("BAD  rules-refund.test.ts imports refund.ts not once"); process.exit(1); }
  writeFileSync(MUTANT_TEST, test.replace(IMPORT, `await import("../src/rules/.refund-mutant-${process.pid}.ts");`));
  let bad = 0;
  for (const name of new Set(MUTANTS.map((m) => m[2]))) {
    const r = run(name, TEST);
    if (!r.ok || !r.ran) { console.log(`BAD  "${name}" does not pass on the code as it is`); bad++; }
  }
  for (const [text, repl, name] of MUTANTS) {
    const n = original.split(text).length - 1;
    if (n !== 1) { console.log(`BAD  mutant text ${n} times in refund.ts, not once: ${text.slice(0, 80)}`); bad++; continue; }
    writeFileSync(MUTANT_SRC, original.replace(text, () => repl));
    try {
      const r = run(name, MUTANT_TEST);
      if (r.ok) { console.log(`LIVE "${name}" passes with: ${text.slice(0, 90).replace(/\n/g, " ")}`); bad++; }
      else console.log(`killed  ${text.slice(0, 90).replace(/\n/g, " ")}`);
    } finally {
      rmSync(MUTANT_SRC, { force: true });
    }
  }
  console.log(bad === 0 ? `all ${MUTANTS.length} mutants killed` : `${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
