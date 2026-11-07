// Removes or weakens each of the EVM pool sender's withdraw and buy checks (src/pool/evm.ts, POST /v1/pool/evm/send,
// card helper-evm-sender-2: the strict decode and W's EIP-712 signature), one at a time, and runs the test named for it
// in src/pool/evm-release.test.ts (or evm.test.ts): each named test passes on the code as it is and fails on every
// mutant. The mutants are made in a copy of the helper's src in a fresh temporary folder inside the helper (so the copy
// resolves the same installed modules), removed at the end; the tree's own files are never changed. Exits 1 when a named
// test passes on its mutant, fails or runs no test on the code as it is, or a mutant's text is not in its file exactly
// once (the style of sell-mutants.mjs).
//   node apps/helper/test/pool-evm/release-mutants.mjs   (a long run: 34 test runs, one per mutant)
//
// Left out, as equivalent (no input tells them apart, each refusal still made by another check, as the pool's own
// ecrecover makes it): the v test (a v but 27 or 28 gives a recovery id below 0 or above 1, which recovers no key or
// another key, never the recipient), the r === 0, r >= n and s === 0 tests (noble's recovery throws on each, so no
// signer), evmReadBuy's selector test (evmReadRelease calls it only on buy's selector), evmReleaseDigest's method/Buy
// agreement throw (both readers always set them alike), and the 65-byte length test in evmReleaseSigner (both readers
// slice exactly 65 bytes).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../../scripts/group-run.mjs";

const HELPER = fileURLToPath(new URL("../..", import.meta.url));
const EVM = "src/pool/evm.ts";
const T = "src/pool/evm-release.test.ts";
const T2 = "src/pool/evm.test.ts";

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
const FEE_CAP_LINE = '    if (w.fee > w.feeCap) return no(422, "fee_over_cap", `fee ${w.fee}, cap ${w.feeCap}`);\n';

const DIGEST = "the helper's release digest is the pool's";
const LANDED = "every withdraw and buy that landed";
const GOOD = "a good withdraw and a good buy W signed";
const FORM = "W's signature only in its one form";
const BUY = "buy's calldata is read in its one canonical encoding";
const MAX = "a release's calldata is at most EVM_BODY_DATA_MAX";
const PIN = "the chain id is the kit's pin";

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
  // a withdraw's request read as before (evm.test.ts's signed requests)
  [EVM, '  if (word(d, 18) !== BigInt(32 * (HEAD_WORDS + W_WORDS))) throw new Error("the signature\'s offset");\n', "", T2, "withdraw's signature is read in its one canonical form"],
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
  const dir = mkdtempSync(join(HELPER, ".release-mutants-"));
  let bad = 0;
  try {
    for (const p of ["src", "test", "package.json"]) cpSync(join(HELPER, p), join(dir, p), { recursive: true });
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
          console.log(`FAIL mutant ${i + 1}: its text is in ${file} ${s.split(find).length - 1} times, not once: ${find.slice(0, 70)}`);
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
