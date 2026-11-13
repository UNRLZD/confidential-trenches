// node --test scripts/live-checks/solana-buy-preview-complete-screens.test.mjs: the live check replays its recorded
// answers (solana-buy-preview-complete-screens.answers.json). good: this card's APP_HOST build: PASS. liveBefore:
// APP_HOST as served at release 129, before this card: FAIL, every mark named. Planted on the good one: another script,
// no pin, each mark taken away: each FAIL; and each mark's minified line as this card's build spells it, changed so its
// rule no longer holds: each FAIL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { facts, judge, KIT, SAYS } from "./solana-buy-preview-complete-screens.mjs";
import { SIGNPAGE_KIT_VERSION } from "../../packages/kit/src/index.ts";

const ANSWERS = JSON.parse(readFileSync(new URL("./solana-buy-preview-complete-screens.answers.json", import.meta.url), "utf8"));
const ALL = Object.values(SAYS).map((s) => `BAD ${s}`);

test("recorded good answer: this card's APP_HOST build: PASS", () => {
  const v = judge(ANSWERS.good);
  assert.equal(v.ok, true, v.lines.join("\n"));
  assert.deepEqual(v.lines, []);
});

test("recorded answer liveBefore (release 129's APP_HOST): FAIL, every mark named", () => {
  const v = judge(ANSWERS.liveBefore);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lines, ALL);
});

test("planted on the good answer: each fact taken away FAILs", () => {
  const g = ANSWERS.good;
  assert.deepEqual(judge({ ...g, sha384: "sha384-other" }).lines, ["BAD APP_HOST's served script is not the one index.html pins"]);
  assert.deepEqual(judge({ ...g, index: "<html></html>" }).lines, ["BAD APP_HOST's index.html pins no script"]);
  for (const [i, k] of Object.keys(SAYS).entries()) assert.deepEqual(judge({ ...g, [k]: false }).lines, [ALL[i]], k);
  assert.equal(judge(null).ok, false);
});

// The minified lines as this card's build spells them (pnpm --filter terminal build), each changed so its rule no
// longer holds.
const JS = [
  "if(e.ok)return void(e.result.cost!==void 0&&me({key:ae,cost:e.result.cost,...e.result.out===void 0?{}:{out:e.result.out},...M===null?{}:{amount:M}}));",
  "function kh(e,t,n){return e===null||t===null||e.key!==t||e.out===void 0||n===null||n<=0n?null:{out:e.out,pending:e.amount!==n}}",
  ";let he=de?Ah(F,ae,M,fe):null,ge=de?kh(F,ae,M):null,_e=qv(l);return{preview:C,receive:ge,sell:k}",
  ",N=j?.p??null,ae=e.receive,oe=ae===null?M===null&&N!==null:ae.pending,se=ae===null?M??N?`≈ ${oS((M??N).out)} ${t}`:`—`:`≈ ${oS(ae.out)} ${t}`,ce=s.now();",
  "(0,U.jsx)(`span`,{\"data-pending\":oe||void 0,\"data-testid\":`trade-receive`,children:se})",
  `;m=\`${KIT}\`;post({v:1,type:\`hello\`,kit:m})`,
].join("");
const INDEX = (js) => `<script type="module" crossorigin src="/assets/index.js" integrity="${facts("", js).sha384}"></script>`;

test("the minified lines this card's build spells: PASS; each one changed so its rule no longer holds: FAIL, that mark named", () => {
  assert.deepEqual(judge(facts(INDEX(JS), JS)).lines, []);
  const cuts = [
    // the out not kept, or kept with no amount it was asked for (a stale out would draw undimmed)
    ["ask", JS.replace(",...e.result.out===void 0?{}:{out:e.result.out}", "")],
    ["ask", JS.replace(",...M===null?{}:{amount:M}", "")],
    // another coin's out drawn, or never dimmed while another amount is typed
    ["shown", JS.replace("||e.key!==t", "")],
    ["shown", JS.replace("pending:e.amount!==n", "pending:!1")],
    // the rule's value never reaches the state's receive
    ["wired", JS.replace("receive:ge", "receive:null")],
    // You receive drawn from the set preview alone, or the pending mark from it alone
    ["drawn", JS.replace(":`≈ ${oS(ae.out)} ${t}`", ":`—`")],
    ["drawn", JS.replace("\"data-pending\":oe||void 0", "\"data-pending\":void 0")],
    ["hello", JS.replace(`m=\`${KIT}\``, "m=`1.13`")],
    // an app built on a kit one level older than this commit's (747's kit 1.15 bump: a 1.14 app is read at 1.14)
    ["hello", JS.replace(`m=\`${KIT}\``, `m=\`${KIT.replace(/\d+$/, (n) => String(Number(n) - 1))}\``)],
    // another version's dot read as any character
    ["hello", JS.replace(`m=\`${KIT}\``, `m=\`${KIT.replace(".", "x")}\``)],
  ];
  for (const [mark, js] of cuts) {
    assert.notEqual(js, JS, `${mark}: the cut changed nothing`);
    // the state is read through the rule the mark found: no rule, no wiring
    const want = mark === "shown" ? [mark, "wired"] : [mark];
    assert.deepEqual(judge(facts(INDEX(js), js)).lines, want.map((m) => `BAD ${SAYS[m]}`), `${mark}: ${js.slice(0, 80)}`);
  }
});

test("the version the app's kit must name is the kit's own at this commit, never a literal", () => {
  assert.equal(KIT, SIGNPAGE_KIT_VERSION);
  assert.ok(SAYS.hello.includes(SIGNPAGE_KIT_VERSION));
});
