// The verify gate on throwaway repositories. Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyGate, verifyGroup } from "./verify-gate.mjs";
import { SIGN_BUILD_INPUTS } from "./sign-build-inputs.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "verify-gate-"));
  const g = (...a) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    }).trim();
  g("init", "-q", "-b", "main");
  const commit = (msg, files) => {
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
      g("add", "--", p);
    }
    g("commit", "-q", "-m", msg);
    return g("rev-parse", "HEAD");
  };
  return { dir, g, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const check = "// recorded good answer passes, recorded bad answer fails\nexport default async () => true;\n";
const refusals = (r, base, head, body = "") => verifyGate(r.dir, base, head, body).refusals.join("\n");

test("a card whose live check is in the tree passes", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    r.g("checkout", "-q", "-b", "card/app-shell");
    r.commit("Card app-shell: shell", { "apps/terminal/src/main.ts": "export {}\n" });
    const head = r.commit("Card app-shell: its live check", { "scripts/live-checks/app-shell.mjs": check });
    assert.deepEqual(verifyGate(r.dir, base, head, "").refusals, []);
  } finally {
    r.done();
  }
});

test("a live check already on main counts for a later pull request of the same card", () => {
  const r = repo();
  try {
    r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    const base = r.commit("Card app-shell: its live check", { "scripts/live-checks/app-shell.mjs": check });
    const head = r.commit("Card app-shell: a fix", { "apps/terminal/src/main.ts": "export const a = 1\n" });
    assert.equal(refusals(r, base, head), "");
  } finally {
    r.done();
  }
});

test("a commit that names no card is refused", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    r.commit("add the shell", { "apps/terminal/src/main.ts": "export {}\n" });
    const head = r.commit("Card app-shell: its live check", { "scripts/live-checks/app-shell.mjs": check });
    const out = verifyGate(r.dir, base, head, "").refusals;
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0], /names no card .*: add the shell$/);
  } finally {
    r.done();
  }
});

test("a card with no live check and no exemption is refused, and no merge record is asked for", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    const head = r.commit("Card app-shell: shell", { "apps/terminal/src/main.ts": "export {}\n" });
    const out = refusals(r, base, head);
    assert.match(out, /card app-shell has no live check: add scripts\/live-checks\/app-shell\.mjs/);
    assert.doesNotMatch(out, /merge: PASS|verify\//);
  } finally {
    r.done();
  }
});

test("`Live check: none (<reason>)` in the PR body passes a card with nothing live", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    const head = r.commit("Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" });
    assert.equal(refusals(r, base, head, "A plan.\n\nLive check: none (docs only, nothing deployed)\n"), "");
    assert.equal(refusals(r, base, head, "Live check: docs-plan: none (docs only)\r\n"), "");
  } finally {
    r.done();
  }
});

test("an exemption with no reason, or not on a line of its own, is refused", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    const head = r.commit("Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" });
    for (const body of ["Live check: none", "Live check: none ()", "Live check: none (  )", "see Live check: none (docs)", "Live check: none (docs) and more"])
      assert.match(refusals(r, base, head, body), /card docs-plan has no live check/, body);
  } finally {
    r.done();
  }
});

test("with several cards, a bare exemption covers none of them; a keyed one covers only its card", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    r.commit("Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" });
    const head = r.commit("Card app-shell: shell", { "apps/terminal/src/main.ts": "export {}\n" });
    const bare = refusals(r, base, head, "Live check: none (docs only)");
    assert.match(bare, /card docs-plan has no live check/);
    assert.match(bare, /card app-shell has no live check/);
    const keyed = refusals(r, base, head, "Live check: docs-plan: none (docs only)");
    assert.doesNotMatch(keyed, /docs-plan/);
    assert.match(keyed, /card app-shell has no live check/);
  } finally {
    r.done();
  }
});

test("a live check that is a symlink is refused", () => {
  const r = repo();
  try {
    const base = r.commit("Card kickoff-kit: kit", { "README.md": "x\n", "elsewhere.mjs": check });
    mkdirSync(join(r.dir, "scripts/live-checks"), { recursive: true });
    symlinkSync("../../elsewhere.mjs", join(r.dir, "scripts/live-checks/app-shell.mjs"));
    r.g("add", "--", "scripts/live-checks/app-shell.mjs");
    r.g("commit", "-q", "-m", "Card app-shell: a linked check");
    const head = r.g("rev-parse", "HEAD");
    assert.match(refusals(r, base, head), /scripts\/live-checks\/app-shell\.mjs is not a regular file/);
  } finally {
    r.done();
  }
});

test("a merge of main into the card branch names no card and passes; an empty pull request is refused", () => {
  const r = repo();
  try {
    r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
    r.g("checkout", "-q", "-b", "card/app-shell");
    r.commit("Card app-shell: its live check", { "scripts/live-checks/app-shell.mjs": check });
    r.g("checkout", "-q", "main");
    const main2 = r.commit("Card other: on main", { "o.ts": "1\n", "scripts/live-checks/other.mjs": check });
    r.g("checkout", "-q", "card/app-shell");
    r.g("merge", "-q", "--no-edit", "main");
    const head = r.g("rev-parse", "HEAD");
    assert.equal(refusals(r, main2, head), "");
    assert.match(refusals(r, head, head), /no commits/);
  } finally {
    r.done();
  }
});

// ---------- SIGN_HOST's release lists and their ledger: what main holds never changes ----------

const LEDGER = "packages/signpage/scripts/release-list.mjs";
const ledgerText = (entries) => `export const RELEASED = Object.freeze({\n${Object.entries(entries).map(([k, v]) => `  "${k}": "${v}",\n`).join("")}});\n`;
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
/** main with release-1 and its ledger entry, then a card branch: { r, base }. */
function released() {
  const r = repo();
  const base = r.commit("Card kickoff-kit: release-1", {
    "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"x","hosts":{}}\n`,
    [LEDGER]: ledgerText({ "release-1": H1 }),
    "scripts/live-checks/signpage-release.mjs": check,
  });
  r.g("checkout", "-q", "-b", "card/signpage-release");
  return { r, base };
}
const cut = (r, extra = {}) => {
  const tree = r.g("rev-parse", "HEAD^{tree}");
  return `${JSON.stringify({ release: "release-2", commit: null, tree, hosts: {}, ...extra })}\n`;
};

test("a new release list with its tree and a new ledger entry passes; old ones untouched", () => {
  const { r, base } = released();
  try {
    r.commit("Card signpage-release: a page change", { "packages/signpage/src/main.ts": "export {};\n" });
    const list = cut(r);
    const head = r.commit("Card signpage-release: release-2", { "packages/signpage/releases/release-2.json": list, [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) });
    assert.equal(refusals(r, base, head), "");
    // the same list naming the commit it was cut at (a Mac cut) passes too
    const named = r.commit("Card signpage-release: release-3", { "packages/signpage/releases/release-3.json": cut(r, { release: "release-3", commit: r.g("rev-parse", "HEAD") }) });
    assert.equal(refusals(r, base, named), "");
  } finally {
    r.done();
  }
});

test("planted: a release list on main changed or removed, or its ledger entry changed or removed, is refused", () => {
  const { r, base } = released();
  try {
    const edited = r.commit("Card signpage-release: edit", { "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"y","hosts":{}}\n` });
    assert.match(refusals(r, base, edited), /release-1\.json is on main and was changed/);
    r.g("rm", "-q", "--", "packages/signpage/releases/release-1.json");
    r.g("commit", "-q", "-m", "Card signpage-release: remove");
    assert.match(refusals(r, base, r.g("rev-parse", "HEAD")), /release-1\.json is on main and was removed/);
  } finally {
    r.done();
  }
  const b = released();
  try {
    // the list and its ledger hash changed together in one commit: still refused (the review's L3)
    const both = b.r.commit("Card signpage-release: both", {
      "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"y","hosts":{}}\n`,
      [LEDGER]: ledgerText({ "release-1": H2 }),
    });
    const got = refusals(b.r, b.base, both);
    assert.match(got, /release-1\.json is on main and was changed/);
    assert.match(got, /RELEASED release-1 is on main and was changed/);
    const gone = b.r.commit("Card signpage-release: drop the entry", { [LEDGER]: ledgerText({}) });
    assert.match(refusals(b.r, b.base, gone), /RELEASED release-1 is on main and was removed/);
  } finally {
    b.r.done();
  }
});

test("planted: a new release list with no tree, a tree of no commit here, or a commit that has not its tree, is refused", () => {
  const { r, base } = released();
  try {
    const add = (list) => r.commit("Card signpage-release: release-2", { "packages/signpage/releases/release-2.json": list });
    assert.match(refusals(r, base, add(`{"release":"release-2","commit":null,"hosts":{}}\n`)), /release-2\.json names no tree/);
    // no commit key at all is not null: refused (the review's G9)
    const noCommit = JSON.parse(cut(r));
    delete noCommit.commit;
    assert.match(refusals(r, base, add(`${JSON.stringify(noCommit)}\n`)), /release-2\.json names a commit that is not null and has not its tree/);
    assert.match(refusals(r, base, add(cut(r, { tree: "f".repeat(40) }))), /release-2\.json names no tree/);
    assert.match(refusals(r, base, add(cut(r, { commit: base }))), /release-2\.json names a commit that is not null and has not its tree/);
    assert.match(refusals(r, base, add(cut(r, { commit: "e".repeat(40) }))), /names a commit that is not null and has not its tree/);
    assert.match(refusals(r, base, add("not json")), /release-2\.json is not JSON/);
  } finally {
    r.done();
  }
});

test("planted: a new list naming a tree whose SIGN_HOST build inputs are not the head's is refused (the review's repro)", () => {
  // card signpage-generated-merge-free: the inputs are the bundle's sources, its lockfile and the files it serves as they are
  for (const input of ["packages/signpage/src/main.ts", "packages/signpage/public/_headers", "packages/wallet/src/index.ts", "packages/kit/src/prover/worker.js", "packages/kit/zk/NOTICE", "pnpm-lock.yaml", "LICENSE", "tsconfig.json", "packages/signpage/tsconfig.json", "packages/wallet/tsconfig.json"]) {
    const { r, base } = released();
    try {
      // the PR ships page v1, then v2, then adds a list naming v1's tree
      r.commit("Card signpage-release: v1", { [input]: "v1 (say, a script that sends the words out)\n" });
      const v1 = r.g("rev-parse", "HEAD^{tree}");
      r.commit("Card signpage-release: v2", { [input]: "v2, the page shipped\n" });
      const head = r.commit("Card signpage-release: release-2", { "packages/signpage/releases/release-2.json": cut(r, { tree: v1 }), [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) });
      assert.match(refusals(r, base, head), new RegExp(`release-2\\.json names a tree whose SIGN_HOST build inputs \\(${SIGN_BUILD_INPUTS.join(", ").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\) are not the pull request's`), input);
      // the base's tree while the PR changes the page: refused too
      const baseTree = r.g("rev-parse", `${base}^{tree}`);
      const head2 = r.commit("Card signpage-release: release-3", { "packages/signpage/releases/release-3.json": cut(r, { release: "release-3", tree: baseTree }) });
      assert.match(refusals(r, base, head2), /release-3\.json names a tree whose SIGN_HOST build inputs/, input);
      // a change outside the inputs after the cut (the ledger, a test) still passes
      const v2 = r.g("rev-parse", "HEAD^{tree}");
      const head3 = r.commit("Card signpage-release: release-4", { "packages/signpage/releases/release-4.json": cut(r, { release: "release-4", tree: v2 }), "packages/signpage/test/x.test.ts": "export {}\n" });
      assert.doesNotMatch(refusals(r, base, head3), /release-4/, input);
    } finally {
      r.done();
    }
  }
});

// ---------- a branch cut before main wrote a release is judged from its merge base, not from main's tip ----------

const LIST2 = "packages/signpage/releases/release-2.json";
/** main with release-1, a card branch cut there with one commit (head), then main writes release-2 (base). */
function stale() {
  const { r, base: from } = released();
  const head = r.commit("Card signpage-release: a test", { "packages/signpage/test/y.test.ts": "export {}\n" });
  r.g("checkout", "-q", "main");
  const base = r.commit("Card signpage-release: release-2", { [LIST2]: cut(r), [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) });
  r.g("checkout", "-q", "card/signpage-release");
  return { r, from, base, head };
}

test("a branch cut before main wrote release-2, untouched, passes without a main merge", () => {
  const { r, base, head } = stale();
  try {
    assert.equal(refusals(r, base, head), "");
  } finally {
    r.done();
  }
});

test("planted: that branch removing or editing a list or a ledger line it had is refused, and main's newer one is not named", () => {
  for (const [what, files, want] of [
    ["edit the list", { "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"y","hosts":{}}\n` }, /release-1\.json is on main and was changed/],
    ["edit the ledger line", { [LEDGER]: ledgerText({ "release-1": H2 }) }, /RELEASED release-1 is on main and was changed/],
    ["drop the ledger line", { [LEDGER]: ledgerText({}) }, /RELEASED release-1 is on main and was removed/],
  ]) {
    const { r, base } = stale();
    try {
      const got = refusals(r, base, r.commit(`Card signpage-release: ${what}`, files));
      assert.match(got, want, what);
      assert.doesNotMatch(got, /release-2/, what);
    } finally {
      r.done();
    }
  }
  const { r, base } = stale();
  try {
    r.g("rm", "-q", "--", "packages/signpage/releases/release-1.json");
    r.g("commit", "-q", "-m", "Card signpage-release: remove");
    const got = refusals(r, base, r.g("rev-parse", "HEAD"));
    assert.match(got, /release-1\.json is on main and was removed/);
    assert.doesNotMatch(got, /release-2/);
  } finally {
    r.done();
  }
});

test("planted: a branch that writes release-2 while main wrote another release-2 is refused (a name clash); main's own bytes are no clash", () => {
  const { r, base } = stale();
  try {
    const clash = r.commit("Card signpage-release: release-2", { [LIST2]: cut(r), [LEDGER]: ledgerText({ "release-1": H1, "release-2": "3".repeat(64) }) });
    const got = refusals(r, base, clash);
    assert.match(got, /release-2\.json is on main as another list: a release name is never used twice/);
    assert.match(got, /RELEASED release-2 is on main with another hash/);
  } finally {
    r.done();
  }
  const b = stale();
  try {
    // the branch takes main's own list and ledger, byte for byte (a cherry-pick): nothing clashes
    b.r.g("checkout", b.base, "--", LIST2, LEDGER);
    b.r.g("commit", "-q", "-m", "Card signpage-release: main's release-2");
    assert.equal(refusals(b.r, b.base, b.r.g("rev-parse", "HEAD")), "");
  } finally {
    b.r.done();
  }
});

test("PR 120 replayed: a branch cut where the ledger held no entry, judged against a main that wrote release-2 and its ledger, passes", () => {
  // branch 1405633 cut from 19ecd8d (release-1, a ledger file with no RELEASED), base 6a64dcd (release-2, RELEASED 1 and 2)
  const r = repo();
  try {
    const from = r.commit("Card kickoff-kit: release-1", {
      "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"x","hosts":{}}\n`,
      [LEDGER]: "export const listPath = (tag) => tag;\n",
    });
    r.g("checkout", "-q", "-b", "card/vault-s20-deploy-line");
    const head = r.commit("Card vault-s20-deploy-line: s20 follows deploy.mjs's next line", { "contracts/vault/tests/s20.mjs": "export {}\n" });
    r.g("checkout", "-q", "main");
    const tree = r.g("rev-parse", `${from}^{tree}`);
    const base = r.commit("Card signpage-withdraw-form: merge", {
      [LIST2]: `${JSON.stringify({ release: "release-2", commit: null, tree, hosts: {} })}\n`,
      [LEDGER]: `export const listPath = (tag) => tag;\n${ledgerText({ "release-1": H1, "release-2": H2 })}`,
      "scripts/live-checks/signpage-withdraw-form.mjs": check,
    });
    const body = "Live check: none (a sandbox test and the deploy script's last printed line, no deploy behaviour changes)";
    assert.equal(refusals(r, base, head, body), "");
  } finally {
    r.done();
  }
});

test("a merge of main into that branch passes; deleting main's list or ledger line after the merge, or in the merge itself, is refused", () => {
  const { r, base } = stale();
  try {
    r.g("merge", "-q", "--no-edit", "main");
    assert.equal(refusals(r, base, r.g("rev-parse", "HEAD")), "");
    r.g("rm", "-q", "--", LIST2);
    r.g("commit", "-q", "-m", "Card signpage-release: drop main's release-2");
    assert.match(refusals(r, base, r.g("rev-parse", "HEAD")), /release-2\.json is on main and was removed/);
    const led = r.commit("Card signpage-release: drop main's ledger line", { [LEDGER]: ledgerText({ "release-1": H1 }) });
    assert.match(refusals(r, base, led), /RELEASED release-2 is on main and was removed/);
  } finally {
    r.done();
  }
  const b = stale();
  try {
    b.r.g("merge", "-q", "--no-commit", "--no-ff", "main");
    b.r.g("rm", "-q", "-f", "--", LIST2);
    b.r.g("commit", "-q", "-m", "Merge main");
    assert.match(refusals(b.r, b.base, b.r.g("rev-parse", "HEAD")), /release-2\.json is on main and was removed/);
  } finally {
    b.r.done();
  }
});

test("a new list on that branch may name the merge base's tree when its SIGN_HOST build inputs are the head's", () => {
  const { r, from, base } = stale();
  try {
    const tree = r.g("rev-parse", `${from}^{tree}`);
    const head = r.commit("Card signpage-release: release-3", { "packages/signpage/releases/release-3.json": cut(r, { release: "release-3", tree }) });
    assert.equal(refusals(r, base, head), "");
  } finally {
    r.done();
  }
});

// ---------- a merge queue group: main, then one queue merge commit per pull request, each judged as its pull request ----------

/**
 * main with the kit, then each pull request on its own branch from main, then the queue's branch: main with a merge
 * commit per pull request, its message as GitHub's queue writes it with the repository's "Pull request title and
 * description" default (the title and number, a blank line, the description). prs: [{ n, title, body, commits }].
 */
function group(prs, { base: baseFiles = { "README.md": "x\n" } } = {}) {
  const r = repo();
  const main = r.commit("Card kickoff-kit: kit", baseFiles);
  for (const pr of prs) {
    r.g("checkout", "-q", "-b", `pr-${pr.n}`, main);
    for (const [msg, files] of pr.commits) r.commit(msg, files);
  }
  r.g("checkout", "-q", "-b", "gh-readonly-queue/main/pr", main);
  for (const pr of prs) r.g("merge", "-q", "--no-ff", "-m", `${pr.title} (#${pr.n})`, "-m", pr.body ?? "", `pr-${pr.n}`);
  return { r, main, head: r.g("rev-parse", "HEAD") };
}
const groupRefusals = (q) => verifyGroup(q.r.dir, q.main, q.head).refusals.join("\n");
const shell = { n: 1, title: "Card app-shell: merge (the shell)", commits: [["Card app-shell: shell", { "apps/terminal/src/main.ts": "export {}\n", "scripts/live-checks/app-shell.mjs": check }]] };
const plan = { n: 2, title: "Card docs-plan: merge (a plan)", body: "A plan.\n\nLive check: none (docs only)", commits: [["Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" }]] };

test("a clean two-card group passes: one card's live check is in its tree, the other's exemption is in its own merge commit's description", () => {
  const q = group([shell, plan]);
  try {
    const out = verifyGroup(q.r.dir, q.main, q.head);
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.cards.sort(), ["app-shell", "docs-plan"]);
  } finally {
    q.r.done();
  }
});

test("planted: a group whose card commit names no card is refused", () => {
  const q = group([shell, { ...plan, commits: [["add a plan", { "docs/plans/app.md": "# app\n" }]] }]);
  try {
    assert.match(groupRefusals(q), /names no card .*: add a plan$/m);
  } finally {
    q.r.done();
  }
});

test("planted: a two-card group with one bad card is refused for that card alone", () => {
  const q = group([shell, { ...plan, body: "A plan." }]);
  try {
    const out = groupRefusals(q);
    assert.match(out, /card docs-plan has no live check/);
    assert.doesNotMatch(out, /app-shell/);
  } finally {
    q.r.done();
  }
});

test("planted: one pull request's exemption never covers another's card in the same group", () => {
  const other = { n: 3, title: "Card app-copy: merge (copy)", commits: [["Card app-copy: copy", { "apps/terminal/src/copy.ts": "export {}\n" }]] };
  const q = group([{ ...plan, body: "Live check: none (docs only)\nLive check: app-copy: none (copy only)" }, other]);
  try {
    const out = groupRefusals(q);
    assert.match(out, /card app-copy has no live check/);
    assert.doesNotMatch(out, /docs-plan/);
  } finally {
    q.r.done();
  }
});

test("planted: a group commit on the queue's line that is not a merge (a squash or a rebase) is refused", () => {
  const q = group([shell]);
  try {
    q.r.commit("Card docs-plan: merge (a plan) (#2)", { "docs/plans/app.md": "# app\n", "scripts/live-checks/docs-plan.mjs": check });
    const out = verifyGroup(q.r.dir, q.main, q.r.g("rev-parse", "HEAD")).refusals.join("\n");
    assert.match(out, /is not a merge commit/);
  } finally {
    q.r.done();
  }
});

test("planted: a group with no queued pull request is refused", () => {
  const q = group([shell]);
  try {
    assert.match(verifyGroup(q.r.dir, q.head, q.main).refusals.join("\n"), /no queued pull request/);
  } finally {
    q.r.done();
  }
});

test("planted: a group judged from a main that already holds its first pull request judges the second alone", () => {
  const q = group([shell, { ...plan, body: "" }]);
  try {
    const first = q.r.g("rev-parse", `${q.head}^1`);
    const out = verifyGroup(q.r.dir, first, q.head);
    assert.deepEqual(out.cards, ["docs-plan"]);
    assert.match(out.refusals.join("\n"), /card docs-plan has no live check/);
  } finally {
    q.r.done();
  }
});

// ---------- GitHub hard-wraps a queued pull request's description at 72 characters in the group's merge commit ----------

// GitHub's wrap as the group commits show it: each line of the description, greedily, at most 72 characters a line
const wrap72 = (text) =>
  text.split("\n").map((line) => {
    const out = [];
    for (const w of line.split(" ")) {
      if (out.length && [...out.at(-1)].length + 1 + [...w].length <= 72) out[out.length - 1] += ` ${w}`;
      else out.push(w);
    }
    return out.join("\n");
  }).join("\n");

test("wrap72 writes PR 540's description as GitHub wrote it in group commit 3de09186", () => {
  const body = "Card exit-withdraw: Nov 6 · The exit tool proves on the device and sends each withdrawal itself from its own one-use account, then closes that account to the typed one\n\nLive check: exit-withdraw: none (no deploy, the exit tool runs on the user's device)";
  assert.equal(
    wrap72(body),
    "Card exit-withdraw: Nov 6 · The exit tool proves on the device and sends\neach withdrawal itself from its own one-use account, then closes that\naccount to the typed one\n\nLive check: exit-withdraw: none (no deploy, the exit tool runs on the\nuser's device)",
  );
});

const long = "A plan for every screen the terminal shows, written before a line of its code, read by people.";

test("a description GitHub wrapped at 72 exempts its card, keyed or bare (PR 540's group)", () => {
  for (const line of ["Live check: docs-plan: none (no deploy, the plan is read by people and nothing runs it)", "Live check: none (no deploy, the plan is read by people and nothing at all runs it)"]) {
    const body = wrap72(`${long}\n\n${line}`);
    assert.match(body, /^Live check: .*\n[^\n]+\)$/m); // wrapped across two lines
    const q = group([shell, { ...plan, body }]);
    try {
      const out = verifyGroup(q.r.dir, q.main, q.head);
      assert.deepEqual(out.refusals, []);
      assert.deepEqual(out.cards.sort(), ["app-shell", "docs-plan"]);
    } finally {
      q.r.done();
    }
  }
});

test("planted: a wrapped exemption naming another card does not exempt this one", () => {
  const q = group([{ ...plan, body: wrap72(`${long}\n\nLive check: app-copy: none (no deploy, the plan is read by people and nothing runs it)`) }]);
  try {
    assert.match(groupRefusals(q), /card docs-plan has no live check/);
  } finally {
    q.r.done();
  }
});

test("planted: a wrapped exemption with an empty reason is refused; the same with a reason passes", () => {
  const key = "docs-plan-of-every-screen-the-terminal-shows-on-a-phone";
  const pr = (reason) => ({ n: 4, title: `Card ${key}: merge (a plan)`, body: wrap72(`Live check: ${key}: none (${reason})`), commits: [[`Card ${key}: a plan`, { "docs/plans/app.md": "# app\n" }]] });
  for (const reason of [" ", ""]) {
    const q = group([pr(reason)]);
    try {
      assert.match(q.r.g("log", "-1", "--format=%b", q.head), /^Live check: [^\n]+:\nnone \(/m); // "none (" wrapped onto its own line
      assert.match(groupRefusals(q), new RegExp(`card ${key} has no live check`));
    } finally {
      q.r.done();
    }
  }
  const q = group([pr("docs only")]);
  try {
    assert.deepEqual(verifyGroup(q.r.dir, q.main, q.head).refusals, []);
  } finally {
    q.r.done();
  }
});

test("two Live check lines one after the other, each wrapped, each exempt their own card alone", () => {
  const two = { n: 5, title: "Card docs-plan: merge (a plan and copy)", commits: [["Card docs-plan: a plan", { "docs/plans/app.md": "# app\n" }], ["Card app-copy: copy", { "apps/terminal/src/copy.ts": "export {}\n" }]] };
  const lines = (second) => wrap72(`${long}\n\nLive check: docs-plan: none (no deploy, the plan is read by people and nothing runs it)\nLive check: ${second}: none (the words ship with the next deploy of the terminal's screens)`);
  const q = group([{ ...two, body: lines("app-copy") }]);
  try {
    assert.equal(q.r.g("log", "-1", "--format=%b", q.head).split("\n").filter((l) => l.startsWith("Live check:")).length, 2);
    const out = verifyGroup(q.r.dir, q.main, q.head);
    assert.deepEqual(out.refusals, []);
    assert.deepEqual(out.cards.sort(), ["app-copy", "docs-plan"]);
  } finally {
    q.r.done();
  }
  const bad = group([{ ...two, body: lines("app-shell") }]);
  try {
    const out = groupRefusals(bad);
    assert.match(out, /card app-copy has no live check/);
    assert.doesNotMatch(out, /card docs-plan/);
  } finally {
    bad.r.done();
  }
});

test("planted: a Live check quoted mid-line, which GitHub's wrap moves to a line start, is no exemption, as on the pull request", () => {
  const prose = "The gate's hint for a pull request with nothing live, if it needs one: Live check: none (docs only)";
  const body = wrap72(prose);
  assert.match(body, /\nLive check: none \(docs only\)$/); // the wrap put it at a line start
  const q = group([{ ...plan, body }]);
  try {
    assert.match(groupRefusals(q), /card docs-plan has no live check/);
    assert.match(refusals(q.r, `${q.head}^1`, `${q.head}^2`, prose), /card docs-plan has no live check/); // the PR path refuses it too
  } finally {
    q.r.done();
  }
});

// ---------- a release list in a group is judged on its pull request's own merge base and commits, as on its pull request ----------

/**
 * PR 548 replayed (group run 42701775123): main at `old`, then `from` (release-1 and its ledger); pull request 2 cut at
 * `from` (build(r) makes its commits there); pull request 1, cut at `from` too, writes `ahead` (in 548's group it was
 * #547, which changed the wallet's and the kit's sources, both SIGN_HOST build inputs); main may gain mainAfter(r); then
 * the queue's group: main, #1, #2, each a merge commit. Pull request 2's merge commit C has C^1 = main + #1, so the
 * merge base of C^1 and C is C^1 itself, while its pull request's is `from`. { r, old, from, main, head, pr }.
 */
function queuedRelease(build, { ahead = { "packages/wallet/src/pool.ts": "export const v = 2;\n" }, mainAfter } = {}) {
  const r = repo();
  const old = r.commit("Card kickoff-kit: kit", { "README.md": "x\n" });
  const from = r.commit("Card kickoff-kit: release-1", {
    "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"x","hosts":{}}\n`,
    [LEDGER]: ledgerText({ "release-1": H1 }),
    "scripts/live-checks/signpage-release.mjs": check,
    "scripts/live-checks/app-ahead.mjs": check,
  });
  r.g("checkout", "-q", "-b", "pr-2", from);
  build(r);
  const pr = r.g("rev-parse", "HEAD");
  r.g("checkout", "-q", "-b", "pr-1", from);
  r.commit("Card app-ahead: the pull request queued ahead", typeof ahead === "function" ? ahead(r) : ahead);
  r.g("checkout", "-q", "main");
  const main = mainAfter ? r.commit("Card signpage-later: main gains a list", mainAfter(r)) : from;
  r.g("checkout", "-q", "-b", "gh-readonly-queue/main/pr", main);
  r.g("merge", "-q", "--no-ff", "-m", "Card app-ahead: merge (#1)", "-m", "", "pr-1");
  r.g("merge", "-q", "--no-ff", "-m", "Card signpage-release: merge (#2)", "-m", "", "pr-2");
  return { r, old, from, main, head: r.g("rev-parse", "HEAD"), pr };
}
const release2 = (r, extra = {}) =>
  r.commit("Card signpage-release: release-2", { [LIST2]: cut(r, extra), [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) });

test("a release list naming the tree its pull request was cut from passes in a group queued behind another pull request, and on its pull request run", () => {
  const q = queuedRelease((r) => release2(r)); // cut() names HEAD's tree: `from`, the pull request's parent and merge base
  try {
    assert.equal(JSON.parse(q.r.g("show", `${q.pr}:${LIST2}`)).tree, q.r.g("rev-parse", `${q.from}^{tree}`));
    assert.notEqual(q.r.g("rev-parse", `${q.head}^1`), q.from); // C^1 is main + #1, not the list's commit
    assert.deepEqual(verifyGroup(q.r.dir, q.main, q.head).refusals, []);
    assert.equal(refusals(q.r, q.from, q.pr), ""); // its pull request run, base main as it was
    assert.equal(refusals(q.r, `${q.head}^1`, q.pr), ""); // and run again on main + #1
  } finally {
    q.r.done();
  }
  // the same pull request with a page change after the cut, its list naming that later commit's tree: passes too
  const b = queuedRelease((r) => {
    r.commit("Card signpage-release: a page change", { "packages/signpage/src/main.ts": "export {};\n" });
    release2(r);
  });
  try {
    assert.deepEqual(verifyGroup(b.r.dir, b.main, b.head).refusals, []);
  } finally {
    b.r.done();
  }
});

test("planted: in a group, a release list naming a tree of no base, no merge base and no commit of its pull request is refused", () => {
  for (const [what, tree] of [
    ["an older main commit's tree", (r) => r.g("rev-parse", "HEAD~1^{tree}")],
    ["a tree of no commit here", () => "f".repeat(40)],
  ]) {
    const q = queuedRelease((r) => release2(r, { tree: tree(r) }));
    try {
      assert.match(refusals(q.r, q.from, q.pr), /release-2\.json names no tree/, what); // as on its pull request run
      assert.match(groupRefusals(q), /Card signpage-release: merge \(#2\): packages\/signpage\/releases\/release-2\.json names no tree of the base, of the merge base or of this pull request's commits/, what);
    } finally {
      q.r.done();
    }
  }
  // the tree of the pull request queued ahead: a commit of the line, but on none of this pull request's three (main
  // moved after #1 was cut, so main + #1 is another tree): refused
  const r = repo();
  try {
    const from = r.commit("Card kickoff-kit: kit", { "README.md": "x\n", "scripts/live-checks/app-ahead.mjs": check, "scripts/live-checks/signpage-release.mjs": check });
    r.g("checkout", "-q", "-b", "pr-1");
    const aheadTree = r.g("rev-parse", `${r.commit("Card app-ahead: ahead", { "docs/x.md": "x\n" })}^{tree}`);
    r.g("checkout", "-q", "-b", "pr-2", from);
    r.commit("Card signpage-release: release-1", { "packages/signpage/releases/release-1.json": `${JSON.stringify({ release: "release-1", commit: null, tree: aheadTree, hosts: {} })}\n` });
    r.g("checkout", "-q", "main");
    const main = r.commit("Card app-other: main moves on", { "docs/y.md": "y\n" });
    r.g("merge", "-q", "--no-ff", "-m", "Card app-ahead: merge (#1)", "-m", "", "pr-1");
    r.g("merge", "-q", "--no-ff", "-m", "Card signpage-release: merge (#2)", "-m", "", "pr-2");
    assert.notEqual(r.g("rev-parse", "HEAD^1^{tree}"), aheadTree);
    assert.match(verifyGroup(r.dir, main, r.g("rev-parse", "HEAD")).refusals.join("\n"), /merge \(#2\): .*release-1\.json names no tree/);
  } finally {
    r.done();
  }
});

test("planted: in a group, a list naming a tree whose SIGN_HOST build inputs are not its pull request's own is refused", () => {
  // the pull request ships page v1, then v2, then names v1's tree (the review's repro, queued behind #1)
  const q = queuedRelease((r) => {
    r.commit("Card signpage-release: v1", { "packages/signpage/src/main.ts": "v1 (say, a script that sends the words out)\n" });
    const v1 = r.g("rev-parse", "HEAD^{tree}");
    r.commit("Card signpage-release: v2", { "packages/signpage/src/main.ts": "v2, the page shipped\n" });
    release2(r, { tree: v1 });
  });
  try {
    assert.match(groupRefusals(q), /merge \(#2\): .*release-2\.json names a tree whose SIGN_HOST build inputs .* are not the pull request's/);
  } finally {
    q.r.done();
  }
});

test("planted: in a group, a release list or ledger line main had, changed or removed by the pull request, is refused", () => {
  for (const [what, change, want] of [
    ["edit the list", (r) => r.commit("Card signpage-release: edit", { "packages/signpage/releases/release-1.json": `{"release":"release-1","commit":"y","hosts":{}}\n` }), /release-1\.json is on main and was changed/],
    ["remove the list", (r) => { r.g("rm", "-q", "--", "packages/signpage/releases/release-1.json"); r.g("commit", "-q", "-m", "Card signpage-release: remove"); }, /release-1\.json is on main and was removed/],
    ["edit the ledger line", (r) => r.commit("Card signpage-release: edit", { [LEDGER]: ledgerText({ "release-1": H2 }) }), /RELEASED release-1 is on main and was changed/],
    ["drop the ledger line", (r) => r.commit("Card signpage-release: drop", { [LEDGER]: ledgerText({}) }), /RELEASED release-1 is on main and was removed/],
  ]) {
    const q = queuedRelease(change);
    try {
      assert.match(groupRefusals(q), want, what);
    } finally {
      q.r.done();
    }
  }
});

test("in a group, a list main gained after the pull request was cut, which it never touches, is no refusal", () => {
  const later = (r) => ({ [LIST2]: cut(r), [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) }); // names `from`'s tree
  const test = (r) => r.commit("Card signpage-release: a test", { "packages/signpage/test/y.test.ts": "export {}\n" });
  for (const [what, opts] of [["on main before the group", { mainAfter: later }], ["from the pull request queued ahead", { ahead: later }]]) {
    const q = queuedRelease(test, opts);
    try {
      assert.deepEqual(verifyGroup(q.r.dir, q.main, q.head).refusals, [], what);
    } finally {
      q.r.done();
    }
  }
});

// main's verify gate runs from scripts/ alone (ci.yml verify-gate: git archive "$BASE" scripts), so what it imports reads
// nothing outside scripts/: sign-build-inputs.mjs loads in a folder that holds scripts/ci/ and nothing else (a read of the
// kit's prover names there, delta review P3-2, would break main's gate; release.test.mjs holds the names instead)
test("sign-build-inputs.mjs, which main's verify gate imports, loads from scripts/ alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "vg-scripts-only-"));
  try {
    mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
    cpSync(join(dirname(fileURLToPath(import.meta.url)), "sign-build-inputs.mjs"), join(dir, "scripts", "ci", "sign-build-inputs.mjs"));
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(join(dir, "scripts", "ci", "sign-build-inputs.mjs"))}); console.log(m.SIGN_BUILD_INPUTS.length)`], { encoding: "utf8" });
    assert.ok(Number(out) > 0, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
