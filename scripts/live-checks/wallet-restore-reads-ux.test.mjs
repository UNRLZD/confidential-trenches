// node --test scripts/live-checks/wallet-restore-reads-ux.test.mjs: card wallet-restore-reads-ux's live check, replayed.
// wallet-restore-reads-ux.answers.json holds three real runs from the Mac (`--record`), none edited:
// - good: `--local`, this card's build in SIGN_HOST's place, both providers of each Solana pool cluster asked live from
//   SIGN_HOST's origin: one balance for the program data account, 0 for the account no one holds, each readable there;
// - bad_origin: `--local --origin https://evil.example`, the same reads from another origin, which the helper's routes
//   do not let read (no Access-Control-Allow-Origin): FAIL on the providers alone;
// - bad_live_before: the live SIGN_HOST before this card's release, whose step 5 reads no U_X: FAIL on the bundle alone.
// The recorded getBalance answers are also the restore tests' U_X reads (packages/signpage/test/pool-restore.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUNDLE_WHY, CLUSTERS, EMPTY, SIGN, bundleFacts, judge, localBuild } from "./wallet-restore-reads-ux.mjs";

const A = JSON.parse(readFileSync(new URL("./wallet-restore-reads-ux.answers.json", import.meta.url), "utf8"));
const spoil = (f) => {
  const a = structuredClone(A.good);
  f(a);
  return judge(a);
};

test("the recorded good run passes: this card's build reads U_X with the follow's reader, and both providers of each cluster give one balance from SIGN_HOST's origin", () => {
  const v = judge(A.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  for (const name of Object.keys(CLUSTERS)) {
    const [p, q] = A.good.clusters[name].providers;
    assert.ok(p.held.value > 0 && p.held.value === q.held.value);
    assert.equal(A.good.clusters[name].empty, EMPTY);
  }
});

test("this tree's committed build gives the recorded good run's bundle facts", () => {
  const { from: _, ...want } = A.good.bundle;
  const b = localBuild();
  assert.deepEqual(bundleFacts(b.index, b.js), want);
});

test("the recorded bad runs fail: asked from another origin, on the providers alone; the build before the card, on the bundle alone", () => {
  const o = judge(A.bad_origin);
  assert.equal(o.ok, false);
  assert.ok(o.lines.every((l) => l.includes("may not read its answer") || l.includes("not SIGN_HOST's origin")), o.lines.join("\n"));
  const l = judge(A.bad_live_before);
  assert.equal(l.ok, false);
  assert.deepEqual(l.lines, Object.values(BUNDLE_WHY).map((w) => `BAD ${w}`));
});

test("planted: two providers giving two balances, one provider's word, a non-zero empty account, another origin or provider, and each bundle fact gone each fail", () => {
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[1].held.value += 1)).ok, false, "disagree");
  assert.equal(spoil((a) => a.clusters.devnet.providers.pop()).ok, false, "one provider");
  assert.equal(spoil((a) => (a.clusters.devnet.providers[0].empty.value = 5)).ok, false, "empty holds");
  assert.equal(spoil((a) => (a.origin = "https://x.example")).ok, false, "origin");
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[0].url = "https://other.example")).ok, false, "provider");
  assert.equal(spoil((a) => (a.bundle.sha384 = "sha384-x")).ok, false, "another script");
  for (const k of Object.keys(BUNDLE_WHY)) assert.equal(spoil((a) => (a.bundle[k] = false)).ok, false, k);
  assert.equal(spoil(() => {}).ok, true);
  assert.equal(A.good.origin, SIGN);
});

test("the bundle facts hold this build's lines, never a carry or a read with one change", () => {
  const { js } = localBuild();
  const f = (text) => bundleFacts("", text);
  assert.deepEqual({ r: f(js).ux_read, c: f(js).ux_carry, w: f(js).ux_wired }, { r: true, c: true, w: true });
  // the review's likely mutants, each one change to the build's own line (found by shape, so a rebuild's names hold)
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  assert.equal(mut(/if\(([\w$]+)!==([\w$]+)\)throw Error\(`its U_X reads/, "if(!1)throw Error(`its U_X reads").ux_read, false, "two balances taken");
  assert.equal(mut(/return ([\w$]+)===0n\?([\w$]+):\(([\w$]+)\.set/, "return $1<=1n?$2:($3.set").ux_read, false, "a held balance read as none");
  assert.equal(mut(/if\(([\w$]+)<([\w$]+)\.floor\)return null;/, "if($1<$2.keep)return null;").ux_carry, false, "another floor");
  assert.equal(mut(/if\(([\w$]+)!==null&&([\w$]+)>=\1\)return`holds/, "if(!1)return`holds").ux_carry, false, "a filled deposit that moved nothing carried on");
  assert.equal(mut(/if\(([\w$]+)!==`filled`&&\1!==`part_filled`\)return`holds/, "if($1===`failed`)return`holds").ux_carry, false, "a carry that did not fill passed");
  assert.equal(mut(/(ux:[\w$]+=>\{let [\w$]+=)([\w$]+)\(\{chain:/, "$1zz$2({chain:").ux_wired, false, "other deps than the follow's");
  assert.equal(mut(/if\(!([\w$]+)\)return`holds \$\{String\(([\w$]+)\)\}, with no deposit note/, "if(!1)return`holds ${String($2)}, with no deposit note").ux_carry, false, "a U_X with no note here carried");
  assert.equal(mut(/,([\w$]+)\.has\(([\w$]+)\.i\),/, ",!0,").ux_carry, false, "the store's word on the index not asked");
});
