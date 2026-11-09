#!/usr/bin/env node
// Card live-checks-provider-no-answer: a live check reads a chain provider's JSON-RPC answer only through
// scripts/live-checks/provider-answer.mjs, which names a provider's no-answer (an empty body, not JSON, a 429, a rate
// limit, a block or state it does not hold) and leaves it out, never judging it as a wrong answer or a pass. This gate
// refuses a live check that builds a JSON-RPC request itself:
//   node scripts/ci/live-checks-provider-answer.mjs [root]      (exit 1 and one line per refusal)
// It reads every scripts/live-checks/*.mjs git lists (tracked, and untracked but not ignored) but the tests and the
// shared module, and refuses one whose code holds a JSON-RPC request or answer ("jsonrpc": "2.0" in any quoting),
// unless NOT_MOVED names it. NOT_MOVED can only shrink: a check it names that builds none is refused too (moved: take
// it off), and a check that imports the shared module may not also build its own. Risk it holds: a check that parses
// a provider's answer itself dies on one provider's bad answer (evm-buy-gas-depth exit 2 on drpc's code 27 "Unknown
// state", helper live run 42556116812, 9 Nov 03:54Z).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const SHARED = new Set(["scripts/live-checks/provider-answer.mjs", "scripts/live-checks/provider-answer.plants.mjs"]);
// Files that answer a page's JSON-RPC with planted answers and read no provider, and why: neither they nor a check that
// imports from them counts as building JSON-RPC
export const MOCKS = Object.freeze({
  "scripts/live-checks/app-in-shell.mjs": "harnessRoute answers the page's RPC calls from recorded answers (route.fulfill); it reads no provider",
});
const IMPORTS_SHARED = /from\s+["']\.\/provider-answer\.mjs["']/;

// The checks that still build a JSON-RPC request themselves, each to move onto the shared module (card
// live-checks-provider-no-answer's follow-ups); the list only shrinks.
export const NOT_MOVED = Object.freeze([
  "app-footer-bar.mjs",
  "base-200ms-blocks.mjs",
  "delete-refund-readback.sweep.mjs",
  "evm-buy-gas-floor.mjs",
  "evm-pool-index.mjs",
  "evm-quote-lag-held.mjs",
  "evm-quote-warm-round.mjs",
  "evm-rpc-spare-list.mjs",
  "evm-scan-second-provider.mjs",
  "evm-sell-hook-intrablock.mjs",
  "held-move-forgotten-tx.mjs",
  "helper-create-u.mjs",
  "helper-evm-abi-tie.mjs",
  "helper-launchpad-origin.mjs",
  "helper-mainnet-vault-env.mjs",
  "helper-pool-senders.mjs",
  "helper-rpc-proxy.mjs",
  "helper-rpc-sell-methods.mjs",
  "helper-tape-4337-trader.mjs",
  "helper-usdc-event-watch.mjs",
  "helper-usdc-pending-pause.mjs",
  "helper-v4-hook-liquidity.mjs",
  "index-evm-swaps.mjs",
  "index-sol-trades.mjs",
  "intents-u-registered-first-run.mjs",
  "near-rpc-operators.mjs",
  "notes-per-pool-evm.mjs",
  "pool-buy-send-fast.mjs",
  "pool-evm-deploy.mjs",
  "pool-sol-deploy.mjs",
  "relayer-cost-guards.mjs",
  "relayer-withdraw-fee.mjs",
  "rh-cold-quote.mjs",
  "robinhood-mainnet-rpcs.mjs",
  "signpage-solana-trade.mjs",
  "solana-quote-under-1s.mjs",
  "vault-mainnet-money.mjs",
  "vault-review-fixes-1.mjs",
  "vault-review-fixes-kit.mjs",
  "vault-testnet-t02.mjs",
  "vault-testnet-usdc.mjs",
  "wallet-mainnet-relayer-pins.mjs",
  "wallet-refund-move.mjs",
  "wallet-restore-id-reader.mjs",
  "wallet-rpc-hex-case.mjs",
  // reading a provider through an imported rpc (scripts/ci/rpc-wait.mjs, pool-evm-deploy.mjs, pool-sol-deploy.mjs)
  "evm-fee-collector.mjs",
  "evm-mainnet-senders.mjs",
  "evm-sell-v4.mjs",
  "evm-testnet-delegate-review3.mjs",
  "evm-venues-pin.mjs",
  "pool-evm-buy-pays-revert.mjs",
  "pool-evm-deploy-resume-safe.mjs",
  "pool-sol-deploy-after-run.mjs",
  "pool-sol-deploy-sweep.mjs",
  "precommit-taken-recover.mjs",
  "signpage-pool-flow.mjs",
  "signpage-pool-notes.mjs",
  "signpage-pool-withdraw-form.mjs",
  "vault-kit-settle.mjs",
  "vault-mainnet.mjs",
  "vault-skeleton.mjs",
].map((f) => `scripts/live-checks/${f}`));

const CODE = /\.(mjs|cjs|js|mts|cts|ts)$/;
const TEST = /\.test\.(mjs|cjs|js|mts|cts|ts)$/;
const kindOf = (f) => (/\.(mts|cts|ts)$/.test(f) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
// a string's text, or a + of strings' (["json" + "rpc"]), else null
const strOf = (n) => (ts.isStringLiteralLike(n) ? n.text : ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken ? ((l, r) => (l === null || r === null ? null : l + r))(strOf(n.left), strOf(n.right)) : ts.isParenthesizedExpression(n) ? strOf(n.expression) : null);

/** Whether a node holds JSON-RPC of its own, read by the TypeScript parser (a comment is never code, a "//" in a string
 *  never a comment): an object with a `jsonrpc` key with any value (jsonrpc: V, { jsonrpc }, "jsonrpc": ...,
 *  ["json" + "rpc"]: ...), an element set or read by the key "jsonrpc", or a string holding a JSON "jsonrpc" key */
function holds(node) {
  let found = false;
  const name = (n) => (ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : ts.isComputedPropertyName(n) ? strOf(n.expression) : null);
  const walk = (n) => {
    if (found) return;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && name(n.name) === "jsonrpc") found = true;
    else if (ts.isElementAccessExpression(n) && strOf(n.argumentExpression) === "jsonrpc") found = true;
    else if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /\\?"jsonrpc\\?"\s*:/.test(n.text)) found = true;
    else ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** A file's code: `builds` (it holds JSON-RPC anywhere), `names` (each top-level declaration's name to whether it holds
 *  JSON-RPC: what an import of that name takes), and `imports` (each relative import or re-export: its specifier and the
 *  names it takes, "*" for a namespace, a default or an import()) */
export function readCode(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, kindOf(file));
  const names = new Map();
  const imports = [];
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.set(st.name.text, holds(st));
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.set(d.name.text, holds(d));
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
    if (spec === null || !spec.startsWith(".")) continue;
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      const nb = c?.namedBindings;
      if (c === undefined) continue; // a bare import "./x.mjs" takes no name (net-window.mjs)
      imports.push({ spec, names: c.name || (nb && ts.isNamespaceImport(nb)) ? "*" : nb ? nb.elements.map((e) => (e.propertyName ?? e.name).text) : [] });
    } else {
      const ec = st.exportClause;
      imports.push({ spec, names: ec && ts.isNamedExports(ec) ? ec.elements.map((e) => (e.propertyName ?? e.name).text) : "*" });
    }
  }
  const dyn = (n) => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.startsWith(".")) imports.push({ spec: n.arguments[0].text, names: "*" });
    ts.forEachChild(n, dyn);
  };
  dyn(sf);
  return { builds: holds(sf), names, imports };
}

/** True when the code holds a JSON-RPC request or answer of its own */
export function buildsRpc(src, file = "x.mjs") {
  return readCode(file, src).builds;
}

/** The refusals for a set of files under scripts/live-checks/: `read(path)` gives a repo file's text, or null when it is
 *  not there. A check counts as building JSON-RPC when its own code does, or when it imports, by a relative path, a
 *  name whose declaration does (scripts/ci/rpc-wait.mjs's rpc, pool-evm-deploy.mjs's rpc) or a whole file that does
 *  (a namespace, a default, an import()); the shared module and its plants never count. */
export function refusalsOf(files, read, notMoved = NOT_MOVED) {
  const out = [];
  const listed = new Set(notMoved);
  const memo = new Map();
  const code = (f) => {
    if (!memo.has(f)) {
      const src = CODE.test(f) && f.startsWith("scripts/") ? read(f) : null;
      memo.set(f, src === null ? null : { src, ...readCode(f, src) });
    }
    return memo.get(f);
  };
  const through = (f, c) =>
    c.imports.flatMap(({ spec, names }) => {
      const g = posix.normalize(posix.join(posix.dirname(f), spec));
      if (SHARED.has(g) || g in MOCKS || !g.startsWith("scripts/") || !CODE.test(g)) return [];
      const t = code(g);
      // a file under scripts/ it imports that is not there cannot be read, so it is refused as building
      if (t === null) return [`${g} (not there)`];
      // a name it does not declare (a re-export, a name it lacks) is read as the whole file
      return (names === "*" ? t.builds : names.some((n) => (t.names.has(n) ? t.names.get(n) : t.builds))) ? [g] : [];
    });
  for (const f of files) {
    if (SHARED.has(f) || f in MOCKS || !f.startsWith("scripts/live-checks/") || !CODE.test(f) || TEST.test(f)) continue;
    const c = code(f);
    if (c === null) continue;
    const by = through(f, c);
    const builds = c.builds || by.length > 0;
    const via = c.builds ? "" : ` (through ${by.join(", ")})`;
    if (c.builds && IMPORTS_SHARED.test(c.src)) out.push(`${f}: imports provider-answer.mjs and builds a JSON-RPC request itself too: read every provider through rpcAnswer`);
    else if (builds && !listed.has(f)) out.push(`${f}: builds a JSON-RPC request outside provider-answer.mjs${via}: read it through rpcAnswer, which names a provider's no-answer`);
    else if (!builds && listed.has(f)) out.push(`${f}: NOT_MOVED names it but it builds no JSON-RPC request: take it off the list`);
  }
  const seen = new Set(files);
  for (const f of listed) if (!seen.has(f)) out.push(`${f}: NOT_MOVED names a file that is not there: take it off the list`);
  return out;
}

export function liveChecksProviderAnswer(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", "scripts/live-checks"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const all = [...new Set(files)];
  const read = (f) => (existsSync(`${root}/${f}`) ? readFileSync(`${root}/${f}`, "utf8") : null);
  return { refusals: refusalsOf(all, read), read: all.filter((f) => CODE.test(f) && !TEST.test(f)).length };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = liveChecksProviderAnswer(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`live-checks-provider-answer: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`live-checks-provider-answer: OK (${r.read} live-check files read, ${NOT_MOVED.length} not yet moved)`);
}
