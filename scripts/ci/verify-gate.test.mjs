// The verify gate on throwaway repositories. Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { verifyGate, verifyGroup } from "./verify-gate.mjs";

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
    r.commit("Card signpage-release: a page change", { "packages/signpage/index.html": "<!doctype html>\n" });
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
  for (const input of ["packages/signpage/index.html", "packages/signpage/public/app.js", "packages/kit/zk/NOTICE", "LICENSE"]) {
    const { r, base } = released();
    try {
      // the PR ships page v1, then v2, then adds a list naming v1's tree
      r.commit("Card signpage-release: v1", { [input]: "v1 (say, a script that sends the words out)\n" });
      const v1 = r.g("rev-parse", "HEAD^{tree}");
      r.commit("Card signpage-release: v2", { [input]: "v2, the page shipped\n" });
      const head = r.commit("Card signpage-release: release-2", { "packages/signpage/releases/release-2.json": cut(r, { tree: v1 }), [LEDGER]: ledgerText({ "release-1": H1, "release-2": H2 }) });
      assert.match(refusals(r, base, head), /release-2\.json names a tree whose SIGN_HOST build inputs \(packages\/signpage\/index\.html, packages\/signpage\/public, packages\/kit\/zk, LICENSE\) are not the pull request's/, input);
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
