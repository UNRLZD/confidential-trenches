// node --test scripts/live-checks/record-names.test.mjs: the folder namer the recorders share (card
// recordings-no-local-paths) names a folder inside the repo by its repo path and any other by its own name, so no
// recorded answer holds the recording machine's folders.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { named, REPO } from "./record-names.mjs";
import { localPath } from "../ci/answers-no-local-paths.mjs";

test("a folder inside the repo is named by its repo path, the repo itself by .", () => {
  assert.equal(named(path.join(REPO, "apps/terminal/dist")), "apps/terminal/dist");
  assert.equal(named(path.join(REPO, "apps/terminal/dist/")), "apps/terminal/dist");
  assert.equal(named(REPO), ".");
  assert.equal(named("/r/repo/packages/signpage/dist", "/r/repo"), "packages/signpage/dist");
});

test("a folder outside the repo is named by its own name, never its path", () => {
  for (const [dir, want] of [
    ["/private/tmp/claude-501/x/scratchpad/dist", "dist"],
    ["/tmp/tmp.cI2pD1U4Ff", "tmp.cI2pD1U4Ff"],
    ["/Users/someone/Downloads/repo-other/apps/terminal/dist", "dist"],
    ["/r/repo-sibling/site", "site"],
  ]) {
    const got = named(dir, "/r/repo");
    assert.equal(got, want, dir);
    assert.equal(localPath(`harness, SIGN_HOST from ${got}`), null, got);
  }
});
