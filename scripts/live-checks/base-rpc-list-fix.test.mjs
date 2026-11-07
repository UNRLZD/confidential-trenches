// Replays card base-rpc-list-fix's live check: each of its three checks on its own recorded answers (base-rpc-list-fix.mjs
// runs them in turn). Good: evm-quote-warm-round's good run (re-recorded on card evm-spare-list-green's list, with bloXroute's Base POST
// answering no allow-origin added as run 42114981904 read it), evm-rpc-spare-list's (this card's kit, this Mac, 2026-11-06 01:06Z: Base's four scan
// providers) and evm-quote-lag-held's (each case in a process of its own, 00:57Z) pass on the kit's list. Bad: the
// spare-list run at 66d7b60 (each scan list stops at two) and lag-held at main 2e7ec335, every case in one process
// (base-blastapi-50's lagger asked 0 times), fail; so does warm-round's good run on main's list, which held bloXroute.
//   node --test scripts/live-checks/base-rpc-list-fix.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECKS } from "./base-rpc-list-fix.mjs";
import { check as warm } from "./evm-quote-warm-round.mjs";
import { check as spare } from "./evm-rpc-spare-list.mjs";
import { check as lag } from "./evm-quote-lag-held.mjs";
import { evmPoolVenues } from "../../packages/kit/src/index.ts";

const answers = (k) => JSON.parse(readFileSync(new URL(`./${k}.answers.json`, import.meta.url), "utf8"));
const W = answers("evm-quote-warm-round");
const S = answers("evm-rpc-spare-list");
const L = answers("evm-quote-lag-held");
const BLX = "https://base.rpc.blxrbdn.com";
// warm-round's good run with bloXroute's answer on GitHub's runner (run 42114981904): preflight 204, POST no allow-origin
const withBlx = () => {
  const run = structuredClone(W.good);
  run.preflight[BLX] = { status: 204, allow: "*", headers: "Content-Type, Authorization, User-Agent", post: null };
  return run;
};

test("the entry runs the card's three checks", () => {
  assert.deepEqual(CHECKS, ["evm-quote-warm-round", "evm-rpc-spare-list", "evm-quote-lag-held"]);
});

test("the good answers pass: no Base provider whose POST names no origin, four Base scan providers, every lagger asked in its own cold quote", () => {
  for (const [name, r] of [["warm-round", warm(withBlx())], ["spare-list", spare(S.good)], ["lag-held", lag(L.good)]]) assert.equal(r.ok, true, `${name}:\n${r.lines.join("\n")}`);
});

test("the bad answers fail: bloXroute listed, a scan list of two, a lagger never asked", () => {
  const v = evmPoolVenues();
  const mainList = { ...v, base: { ...v.base, providers: [...v.base.providers.slice(0, 2), BLX, ...v.base.providers.slice(2)] } };
  const w = warm(withBlx(), mainList);
  assert.equal(w.ok, false);
  assert.ok(w.lines.some((l) => /^FAIL base base\.rpc\.blxrbdn\.com preflight .*POST allow-origin none$/.test(l)), w.lines.join("\n"));
  assert.equal(spare(S.bad).ok, false);
  const l = lag(L.bad_shared);
  assert.equal(l.ok, false);
  assert.ok(l.lines.some((x) => /^FAIL base-blastapi-50: .* asked for its head 0 times in the cold quote$/.test(x)), l.lines.join("\n"));
});
