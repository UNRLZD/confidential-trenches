// The verify gate on throwaway repositories. Run: node --test scripts/ci/
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { verifyGate } from "./verify-gate.mjs";

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
