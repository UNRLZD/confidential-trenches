// node packages/wallet/scripts/pool-evm-sell-bans-mutants.mjs (card evm-sell-hook-converge): plants one mutant at a time in the bans store, runs the named test, expects it to fail, puts the source back.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSync } from "../../../scripts/group-run.mjs";
const W = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const B = `${W}/src/pool/evm-sell-bans.ts`, ST = `${W}/src/store/index.ts`;
const T = "test/pool-evm-sell-bans.test.ts";
// [file, find, replace, test file, test name pattern]
const M = [
  // the record: kept per chain and token, each pool once, oldest first, its shape checked on read
  [B, "return `${WALLET_BAN_PREFIX}${chain}/${t}`;", "return `${WALLET_BAN_PREFIX}${t}`;", T, "a ban is kept per chain"],
  [B, "      if (old !== undefined && old.until > now) continue;\n", "", T, "a ban is kept per chain"],
  [B, "      if (old !== undefined && old.until > now) continue;\n", "", T, "a ban lasts an hour"],
  [B, "  const add = [...pools].map((p) => (typeof p === \"string\" ? p.toLowerCase() : \"\"));", "  const add = [...pools].map((p) => (typeof p === \"string\" ? p : \"\"));", T, "a ban is kept per chain"],
  [B, "  const t = typeof token === \"string\" ? token.toLowerCase() : \"\";", "  const t = typeof token === \"string\" ? token : \"\";", T, "a ban is kept per chain"],
  [B, "  if ((rec as { v?: unknown } | undefined)?.v !== 2 || !Array.isArray(pools)) return [];", "  if (!Array.isArray(pools)) return [];", T, "a ban is kept per chain"],
  [B, "typeof id === \"string\" && POOL_ID.test(id) && Number.isSafeInteger(until)", "typeof id === \"string\" && POOL_ID.test(id)", T, "a ban is kept per chain"],
  // a ban expires (review of 919742f5, F2): an hour, doubled on each repeat after it expired, at most seven days
  [B, "(await store.get(\"meta\", evmSellBanKey(chain, token))).filter((b) => b.until > now)", "(await store.get(\"meta\", evmSellBanKey(chain, token)))", T, "a ban lasts an hour"],
  [B, "next.push({ id, until: now + evmSellBanMs(n), n });", "next.push({ id, until: now + EVM_SELL_BAN_FIRST_MS, n });", T, "a ban lasts an hour"],
  [B, "(n >= 9 ? EVM_SELL_BAN_MAX_MS : Math.min(EVM_SELL_BAN_FIRST_MS * 2 ** (n - 1), EVM_SELL_BAN_MAX_MS))", "(EVM_SELL_BAN_FIRST_MS * 2 ** (n - 1))", T, "a ban lasts an hour"],
  [B, "export const EVM_SELL_BAN_FIRST_MS = 60 * 60 * 1000;", "export const EVM_SELL_BAN_FIRST_MS = 60 * 60 * 1000 * 24 * 365;", T, "a ban lasts an hour"],
  // refused before any write
  [B, "  if (add.some((p) => !POOL_ID.test(p))) throw", "  if (false) throw", T, "a ban refuses"],
  [B, "if (typeof chain !== \"string\" || !CHAIN.test(chain) || !TOKEN.test(t)) throw", "if (false) throw", T, "a ban refuses"],
  // one compare-and-set per ban, the newest EVM_SELL_BANS_MAX kept
  [B, "  await store.update(\"meta\", key, (rec) => {", "  const rec0 = await (store as unknown as WalletStore).get(\"meta\", key);\n  await store.update(\"meta\", key, () => {\n    const rec = rec0;", T, "two tabs banning at once"],
  [B, "    after = next.slice(-EVM_SELL_BANS_MAX);", "    after = next.slice(0, EVM_SELL_BANS_MAX);", T, "at most"],
  // the store's own key: no seed move, never the frame's
  [ST, " || e.key.startsWith(WALLET_BAN_PREFIX))));", ")));", T, "a ban's write is no seed move"],
  [ST, " || x.startsWith(WALLET_BAN_PREFIX))));", ")));", T, "a ban's write is no seed move"],
  [ST, "const BAN_KEY = /^evm-bans\\/[^/]{1,40}\\/[^/]{1,200}$/;", "const BAN_KEY = /^evm-bans\\//;", T, "a ban's write is no seed move"],
];
let ok = 0;
for (const [f, find, repl, file, pat] of M) {
  const src = readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { console.log(`NOT ONCE: ${find}`); process.exitCode = 1; continue; }
  writeFileSync(f, src.replace(find, repl));
  // a run past 120 s is killed, its process group with it (scripts/group-run.mjs)
  const r = runSync("node", ["--test", `--test-name-pattern=${pat}`, file], { cwd: W, encoding: "utf8", timeoutMs: 120_000 });
  writeFileSync(f, src);
  const fail = (r.stdout.match(/ℹ fail (\d+)/) ?? [])[1];
  const pass = (r.stdout.match(/ℹ pass (\d+)/) ?? [])[1];
  const killed = r.status !== 0 && Number(fail) > 0;
  if (killed) ok++;
  console.log(`${killed ? "KILLED" : "SURVIVED"} [${pat}] pass ${pass} fail ${fail}: ${f.split("/").pop()}: ${find.slice(0, 70)}`);
}
console.log(`${ok}/${M.length} killed`);
if (ok !== M.length) process.exitCode = 1;
