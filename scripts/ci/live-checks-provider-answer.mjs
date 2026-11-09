#!/usr/bin/env node
// Card live-checks-provider-no-answer: a live check reads a chain provider's JSON-RPC answer only through
// scripts/live-checks/provider-answer.mjs, which names a provider's no-answer (an empty body, not JSON, a 429, a rate
// limit, a block or state it does not hold) and leaves it out, never judging it as a wrong answer or a pass. This gate
// refuses a live check that builds a JSON-RPC request itself:
//   node scripts/ci/live-checks-provider-answer.mjs [root]      (exit 1 and one line per refusal)
// It reads every code file under scripts/live-checks/ git lists (tracked, and untracked but not ignored) but the tests and the
// shared module, and refuses one whose code holds a JSON-RPC request or answer ("jsonrpc": "2.0" in any quoting),
// unless NOT_MOVED names it. NOT_MOVED can only shrink: a check it names that builds none is refused too (moved: take
// it off), and a check that imports the shared module may not also build its own. Risk it holds: a check that parses
// a provider's answer itself dies on one provider's bad answer (evm-buy-gas-depth exit 2 on drpc's code 27 "Unknown
// state", helper live run 42556116812, 9 Nov 03:54Z).
// Its scope ends at scripts/: a name it follows is a relative import under scripts/. An import from apps/ or packages/
// (the kit's entry included), a .cjs require() and an import() of a computed path are not followed, and a request
// body with no version field is not seen: those are the hand read's.
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
  // reading a provider through an imported name that calls an rpc (vault-skeleton.mjs query, evm-fee-collector.mjs
  // check, money-gate.mjs readTx, ...)
  "delete-refund-readback.mjs",
  "evm-selldelegate-exact-debit.mjs",
  "helper-evm-sender.mjs",
  "helper-sender-fee-proof.mjs",
  "money-gate-testnet.mjs",
  "pool-deposits.mjs",
  "pool-evm-deploy-mainnet.mjs",
  "pool-evm-testnet-run.mjs",
  "pool-sol-deploy-mainnet.mjs",
  "vault-final-sha.mjs",
  "vault-review-fixes-3.mjs",
  "vault-testnet-t01.mjs",
  "vault-testnet-t04.mjs",
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

// the names a node refers to (an identifier that is not a property's name), and the relative specifiers of its import()s
function refsOf(node) {
  const refs = new Set();
  const dyn = [];
  const walk = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const prop = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isMethodDeclaration(p) && p.name === n));
      if (!prop) refs.add(n.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.startsWith(".")) dyn.push(n.arguments[0].text);
    ts.forEachChild(n, walk);
  };
  walk(node);
  return { refs, dyn };
}

/** A file's code: `builds` (it holds JSON-RPC of its own anywhere); `decls` (each top-level declaration's name to
 *  { own, refs, dyn }: whether it holds JSON-RPC itself, the names it refers to and its import()s); `bindings` (each
 *  name a relative import or re-export brings in, to { spec, name }, name "*" for a namespace or a default); `file`
 *  (the whole file as one declaration: what an import of it all, or the check itself, takes) */
export function readCode(file, src) {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ESNext, true, kindOf(file));
  const decls = new Map();
  const bindings = new Map();
  const decl = (name, node) => decls.set(name, { own: holds(node), ...refsOf(node) });
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) decl(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decl(d.name.text, d);
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteralLike(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
    if (spec === null || !spec.startsWith(".")) continue;
    if (ts.isImportDeclaration(st)) {
      const c = st.importClause;
      if (c === undefined) continue; // a bare import "./x.mjs" brings in no name (net-window.mjs)
      if (c.name) bindings.set(c.name.text, { spec, name: "*" });
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, { spec, name: "*" });
      else if (nb) for (const e of nb.elements) bindings.set(e.name.text, { spec, name: (e.propertyName ?? e.name).text });
    } else {
      const ec = st.exportClause;
      // a re-export: the name it exports refers to the other file's; export * counts the whole file
      if (ec && ts.isNamedExports(ec)) for (const e of ec.elements) bindings.set(e.name.text, { spec, name: (e.propertyName ?? e.name).text });
      else bindings.set(`* ${spec}`, { spec, name: "*" });
    }
  }
  const whole = refsOf(sf);
  return { builds: holds(sf), decls, bindings, file: { own: holds(sf), refs: new Set([...whole.refs, ...[...bindings.keys()].filter((k) => k.startsWith("* "))]), dyn: whole.dyn } };
}

/** True when the code holds a JSON-RPC request or answer of its own */
export function buildsRpc(src, file = "x.mjs") {
  return readCode(file, src).builds;
}

/** The refusals for a set of files under scripts/live-checks/: `read(path)` gives a repo file's text, or null when it is
 *  not there. A check counts as building JSON-RPC when its own code does, or when it refers to a name that does: a
 *  top-level declaration of the same file or a name imported by a relative path under scripts/, which holds JSON-RPC
 *  when its declaration does or refers in turn to a name that does (scripts/ci/rpc-wait.mjs's rpc, vault-skeleton.mjs's
 *  query, which calls it), followed through every file, each name read once (a cycle holds nothing more). A namespace,
 *  a default, an import() or a name a file does not declare takes the whole file; a file under scripts/ that is not
 *  there counts as building. The shared module, its plants and MOCKS never count. */
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
  const held = new Map(); // `${file}\0${name}` to true or false; in progress: false (a cycle adds nothing)
  const target = (f, spec) => posix.normalize(posix.join(posix.dirname(f), spec));
  const outside = (g) => SHARED.has(g) || g in MOCKS || !g.startsWith("scripts/") || !CODE.test(g);
  // the file `g` reached through an import holds JSON-RPC in `name` ("*": the whole file)
  const holdsIn = (g, name) => {
    if (outside(g)) return false;
    const c = code(g);
    if (c === null) return true;
    const key = `${g}\0${name}`;
    if (held.has(key)) return held.get(key);
    held.set(key, false);
    let r;
    if (name === "*") r = declHolds(g, c, c.file);
    else if (c.decls.has(name)) r = declHolds(g, c, c.decls.get(name));
    else if (c.bindings.has(name)) r = holdsIn(target(g, c.bindings.get(name).spec), c.bindings.get(name).name);
    else r = declHolds(g, c, c.file);
    held.set(key, r);
    return r;
  };
  const declHolds = (f, c, d) => {
    if (d.own) return true;
    if (d.dyn.some((spec) => holdsIn(target(f, spec), "*"))) return true;
    for (const n of d.refs) {
      if (c.decls.has(n) && c.decls.get(n) !== d && holdsIn(f, n)) return true;
      const b = c.bindings.get(n);
      if (b && holdsIn(target(f, b.spec), b.name)) return true;
    }
    return false;
  };
  for (const f of files) {
    if (SHARED.has(f) || f in MOCKS || !f.startsWith("scripts/live-checks/") || !CODE.test(f) || TEST.test(f)) continue;
    const c = code(f);
    if (c === null) continue;
    const by = [...new Set([...c.bindings.values()].filter((b) => holdsIn(target(f, b.spec), b.name)).map((b) => target(f, b.spec)))];
    const builds = c.builds || declHolds(f, c, c.file);
    const via = c.builds ? "" : ` (through ${by.length ? by.join(", ") : "an import()"})`;
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
