// node --test scripts/live-checks/wallet-restore-reads-ux.test.mjs: card wallet-restore-reads-ux's live check, replayed.
// wallet-restore-reads-ux.answers.json holds four real runs from the Mac (`--record`, 9 Nov 05:03Z), none edited, and
// the review's two plants read by this check's own bundleFacts:
// - good: `--local`, this card's build in SIGN_HOST's place, both of the restore's public operators (PublicNode and
//   Pocket's Solana gateway) asked live with SIGN_HOST's Origin header: one balance for the program data account, 0 for
//   the account no one holds, each readable there;
// - bad_helper: `--local --with https://ct-api.unrealized.trade/v1/rpc/solana`, our helper relay in the second
//   provider's place (the pair before the CO's fold of 04:33Z): FAIL on the provider alone;
// - bad_refuses_page: `--local --with https://api.mainnet-beta.solana.com`, the fold's first pick, which answers a
//   request with an Origin header 403: FAIL;
// - bad_live_before: the live SIGN_HOST before this card's release, whose step 5 reads no U_X: FAIL on the bundle alone;
// - bad_one_provider and bad_dead_held_binding: the delta review's P2-2 plants on this card's build (the held reader's two
//   amounts from one provider's map; step 5's held reader returning nothing beside a dead live-looking copy of the head);
// - bad_dead_copy and bad_reader_not_handed: review P2's plant-ux.mjs (the real reader broken, a dead same-shaped copy
//   beside it) and plant-ux2.mjs (restoreDepositIds handed the NEAR-only reader) on this card's build: FAIL on the bundle;
// - bad_filter_one_amount and bad_filter_both_nonzero: delta review 2's P2-A plants A5 and A6 (the held reader drops an
//   asset one provider reads at 0, so 0 there and 5 USDC on the other ends done): FAIL on the bundle alone.
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

test("the recorded bad runs fail: our helper relay among the restore's providers, on the provider alone; the build before the card, on the bundle alone", () => {
  const o = judge(A.bad_helper);
  assert.equal(o.ok, false);
  assert.ok(o.lines.some((l) => l.includes("name our helper relay")), o.lines.join("\n"));
  assert.ok(o.lines.every((l) => l.includes("helper") || l.includes("provider 1 is")), o.lines.join("\n"));
  const l = judge(A.bad_live_before);
  assert.equal(l.ok, false);
  assert.deepEqual(l.lines, Object.values(BUNDLE_WHY).map((w) => `BAD ${w}`));
});

test("planted: two providers giving two balances, one provider's word, a non-zero empty account, another origin or provider, and each bundle fact gone each fail", () => {
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[1].held.value += 1)).ok, false, "disagree");
  assert.equal(spoil((a) => a.clusters.mainnet.providers.pop()).ok, false, "one provider");
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[0].empty.value = 5)).ok, false, "empty holds");
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[1].url = "https://ct-api.unrealized.trade/v1/rpc/solana")).ok, false, "our helper");
  assert.equal(spoil((a) => (a.origin = "https://x.example")).ok, false, "origin");
  assert.equal(spoil((a) => (a.clusters.mainnet.providers[0].url = "https://other.example")).ok, false, "provider");
  assert.equal(spoil((a) => (a.bundle.sha384 = "sha384-x")).ok, false, "another script");
  for (const k of Object.keys(BUNDLE_WHY)) assert.equal(spoil((a) => (a.bundle[k] = false)).ok, false, k);
  assert.equal(spoil(() => {}).ok, true);
  assert.equal(A.good.origin, SIGN);
});

test("the bundle facts hold this build's lines, never a carry, a read or a held rule with one change", () => {
  const { js } = localBuild();
  const f = (text) => bundleFacts("", text);
  const all = (x) => ({ r: x.ux_read, c: x.ux_carry, h: x.id_held, p: x.ux_pair, w: x.ux_wired });
  assert.deepEqual(all(f(js)), { r: true, c: true, h: true, p: true, w: true });
  // the review's likely mutants, each one change to the build's own line (found by shape, so a rebuild's names hold)
  const mut = (from, to) => {
    assert.equal([...js.matchAll(new RegExp(from.source, "g"))].length, 1, String(from));
    return f(js.replace(from, to));
  };
  assert.equal(mut(/,([\w$]+)!==([\w$]+)\)throw Error\(`its U_X reads/, ",!1)throw Error(`its U_X reads").ux_read, false, "two balances taken");
  assert.equal(mut(/,([\w$]+)!==([\w$]+)\)throw Error\(`its U_X reads/, ",$1!==$1)throw Error(`its U_X reads").ux_read, false, "the two balances compared to themselves");
  assert.equal(mut(/return ([\w$]+)===0n\?([\w$]+):\(([\w$]+)\.set/, "return $1<=1n?$2:($3.set").ux_read, false, "a held balance read as none");
  assert.equal(mut(/if\(([\w$]+)<([\w$]+)\.floor\)return null;/, "if($1<$2.keep)return null;").ux_carry, false, "another floor");
  assert.equal(mut(/if\(([\w$]+)!==null&&([\w$]+)>=\1\)return`holds/, "if(!1)return`holds").ux_carry, false, "a filled deposit that moved nothing carried on");
  assert.equal(mut(/if\(([\w$]+)!==`filled`&&\1!==`part_filled`\)return`holds/, "if($1===`failed`)return`holds").ux_carry, false, "a carry that did not fill passed");
  assert.equal(mut(/(ux:[\w$]+=>[\w$]+\([\w$]+,)([\w$]+)\(\{chain:/, "$1zz$2({chain:").ux_wired, false, "other deps than the follow's");
  assert.equal(mut(/`https:\/\/solana\.api\.pocket\.network`\]\);function/, "`https://ct-api.unrealized.trade`]);function").ux_pair, false, "our helper as the second");
  assert.equal(mut(/`https:\/\/solana\.api\.pocket\.network`\]\);function/, "`https://api.mainnet-beta.solana.com`]);function").ux_pair, false, "the operator that refuses a page as the second");
  assert.equal(mut(/return\[([\w$]+)\(([\w$]+)\(([\w$]+)\[0\]\)\),\1\(\2\(\3\[1\]\)\)\]\}/, "return[$1($2($3[0])),$2($3[1])]}").ux_pair, false, "the second unpaced");
  assert.equal(mut(/\[([\w$]+),\[([\w$]+),([\w$]+)\]\]=await Promise\.all\(\[([\w$]+)\(([\w$]+),([\w$]+)\),([\w$]+)\.balances/, "[$1,[$2,$3]]=await Promise.all([$4($5,$6),$7.balancez").ux_read, false, "the U_X not read");
  assert.equal(mut(/if\(!([\w$]+)\)return`holds \$\{String\(([\w$]+)\)\}, with no deposit note/, "if(!1)return`holds ${String($2)}, with no deposit note").ux_carry, false, "a U_X with no note here carried");
  assert.equal(mut(/,([\w$]+)\.has\(([\w$]+)\.i\),/, ",!0,").ux_carry, false, "the store's word on the index not asked");
  // review P1: the held rule
  assert.equal(mut(/if\(([\w$]+)===`money`&&([\w$]+)\.set\(/, "if($1===`used`&&$2.set(").ux_read, false, "an id NEAR reads as money not noted");
  assert.equal(mut(/:([\w$]+)>1n&&([\w$]+)\.push\(`holds/, ":$1>2n&&$2.push(`holds").id_held, false, "the kept unit read as 2");
  assert.equal(mut(/:([\w$]+)>1n&&([\w$]+)\.push\(`holds/, ":!1&&$2.push(`holds").id_held, false, "money above the kept unit not named");
  assert.equal(mut(/&&!([\w$]+)\.startsWith\(`nep141:`\)\?/, "&&!1?").id_held, false, "an NFT or multi-token read as moved-out dust (review P3-4)");
  assert.equal(mut(/amounts:\[([\w$]+)\.get\(([\w$]+)\)\?\?0n,([\w$]+)\.get\(\2\)\?\?0n\]/, "amounts:[$1.get($2)??0n,$1.get($2)??0n]").id_held, false, "one provider's map gives both amounts (review P2-2)");
  assert.equal(mut(/,([\w$]+)=await ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\.opts\?\?\{\}\),([\w$]+),([\w$]+)=async\(/, ",$1=async e=>[],$7,$8=async(").id_held, false, "step 5's held reader returns nothing (review P2-2)");
  assert.equal(mut(/(for\(let\{asset:([\w$]+),amounts:\[([\w$]+),([\w$]+)\]\}of [\w$]+\))\3===\4\?/, "$1!0?").id_held, false, "two providers read apart taken");
  assert.equal(mut(/let\[([\w$]+),([\w$]+)\]=await Promise\.all\(\[([\w$]+)\(([\w$]+)\[0\],([\w$]+)\),\3\(\4\[1\],\5\)\]\);return\[\.\.\.new Set/, "let[$1,$2]=await Promise.all([$3($4[0],$5),$3($4[0],$5)]);return[...new Set").id_held, false, "one provider read twice");
  // delta review 2: the held reader's filter (P2-A plants A5, A6), readOn's intents.near and token reads and step 5's
  // `why` (P3-1 plants A9, B9), and the token's table and its one binding (P3-2)
  const filter = /\.filter\(([\w$]+)=>\1\.amounts\[0\]!==0n\|\|\1\.amounts\[1\]!==0n\)/;
  assert.equal(mut(filter, ".filter($1=>$1.amounts[0]!==0n)").id_held, false, "A5: an asset kept only when provider 0 reads it");
  assert.equal(mut(filter, ".filter($1=>$1.amounts[0]!==0n&&$1.amounts[1]!==0n)").id_held, false, "A6: an asset kept only when both read it");
  assert.equal(mut(filter, ".filter($1=>$1.amounts[1]!==0n)").id_held, false, "an asset kept only when provider 1 reads it");
  assert.equal(mut(/;for\(let\[([\w$]+),([\w$]+)\]of await ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\)([\w$]+)\.set\(\1,\(\8\.get\(\1\)\?\?0n\)\+\2\);return \8\}/, ";return $8}").id_held, false, "A9: intents.near not read");
  assert.equal(mut(/if\(([\w$]+)\.length===0\)return\[\];let ([\w$]+)=\1\.map/, "if(!0)return[];let $2=$1.map").id_held, false, "intents.near's list read as empty");
  assert.equal(mut(/([\w$]+)!==null&&([\w$]+)\.set\(([\w$]+),([\w$]+)\(\(await ([\w$]+)\(([\w$]+),([\w$]+)\(\3,`ft_balance_of`/, "!1&&$2.set($3,$4((await $5($6,$7($3,`ft_balance_of`").id_held, false, "the token's own balance not read");
  assert.equal(mut(/for\(let ([\w$]+) of ([\w$]+)\)([\w$]+)\.push\(`\$\{([\w$]+)\.label\}: deposit index \$\{([\w$]+)\}'s id/, "for(let $1 of $2)__junk.push(`${$4.label}: deposit index ${$5}'s id").id_held, false, "B9: the held names pushed to another list");
  const tok = / ([\w$]+)=([\w$]+)\[([\w$]+)\]\.usdc;async function/;
  assert.equal(f(`${js.replace(tok, " $1=__nets[$3].usdc;async function")};var __nets=0;`).id_held, false, "the token read from another table");
  assert.equal(f(`${js};var __dead=0,${tok.exec(js)[1]}=0;`).id_held, false, "the token given a second value");
  // review P2: a dead same-shaped copy beside a broken real one, and the U_X reader not handed to the id read
  const read = /,([\w$]+)=async\(([\w$]+),([\w$]+)\)=>\{if\(\3===void 0\)throw Error\(`no deposit index for its U_X`\);[^]*?`money`\)\}/.exec(js)[0];
  const carry = /async function ([\w$]+)\(([\w$]+),([\w$]+),([\w$]+),([\w$]+)\)\{let ([\w$]+)=null;for\(;;\)\{[^]*?\6=[\w$]+\}\}/.exec(js)[0];
  const held = /async function ([\w$]+)\(([\w$]+),([\w$]+)\)\{let ([\w$]+);try\{\4=await \2\(\3\)\}[^]*?return [\w$]+\}/.exec(js)[0];
  const wired = /written:\(\)=>void [\w$]+\?\.proofs\(\)\.catch\(\(\)=>\{\}\),ux:[^]*?\),ended:/.exec(js)[0];
  const broken = (from, to) => {
    const t = js.replace(from, to);
    assert.notEqual(t, js, String(from));
    return t;
  };
  const dead = (text, copy) => f(`${text};var __dead=0${copy};`);
  assert.equal(dead(broken(/,([\w$]+)!==([\w$]+)\)throw Error\(`its U_X reads/, ",!1)throw Error(`its U_X reads"), read).ux_read, false, "dead copy: read (real guard dropped)");
  assert.equal(dead(broken(/if\(([\w$]+)<([\w$]+)\.floor\)return null;/, ""), `;${carry.replace(/^async function ([\w$]+)/, "async function __dead_c")}`).ux_carry, false, "dead copy: carry (real floor dropped)");
  assert.equal(dead(broken(/:([\w$]+)>1n&&/, ":!1&&"), `;${held.replace(/^async function ([\w$]+)/, "async function __dead_h")}`).id_held, false, "dead copy: held rule (real one names nothing)");
  assert.equal(dead(broken(/(ux:[\w$]+=>[\w$]+\([\w$]+,)([\w$]+)\(\{chain:/, "$1(()=>null)({chain:"), `;var __dead_w={signedIn:0,${wired}0}`).ux_wired, false, "dead copy: wired (real deps swapped)");
  assert.equal(dead(js, read).ux_read, false, "a second copy of the reader beside the real one");
  const handed = /(`money`\)\},[\w$]+=await [\w$]+\([\w$]+,([\w$]+)\.scope,\{notes:\[\.\.\.\2\.notes\],\.\.\.[\w$]+\(\2\.notes,\2\.scope\)\},)([\w$]+)\)/;
  assert.equal(mut(handed, "$1l)").ux_read, false, "the U_X reader not handed to restoreDepositIds");
});

test("the review's two plants, recorded as bad answers, fail on the bundle alone", () => {
  for (const k of ["bad_dead_copy", "bad_reader_not_handed", "bad_one_provider", "bad_dead_held_binding", "bad_filter_one_amount", "bad_filter_both_nonzero"]) {
    const v = judge(A[k]);
    assert.equal(v.ok, false, k);
    assert.ok(v.lines.length > 0 && v.lines.every((l) => Object.values(BUNDLE_WHY).some((w) => l === `BAD ${w}`) || l.includes("index.html pins")), `${k}: ${v.lines.join("\n")}`);
  }
});

test("the restore that refuses a page: mainnet-beta's 403 to SIGN_HOST's origin, recorded, fails", () => {
  const v = judge(A.bad_refuses_page);
  assert.equal(v.ok, false);
  assert.ok(v.lines.some((l) => l.includes("api.mainnet-beta.solana.com") && l.includes("HTTP 403")), v.lines.join("\n"));
});
