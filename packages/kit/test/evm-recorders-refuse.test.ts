// The two recorders of mainnet quotes (evm-quote-calls-record.ts, evm-warm-tap-calls-record.ts) overwrite their
// fixtures with live reads; run with no `--record` they exit 2 and write nothing (card
// evm-warm-tap-ends-inside-two-seconds: a loop over test/ ran both and replaced both recordings).
//   node --test test/evm-recorders-refuse.test.ts      (from packages/kit)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const hashOf = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
for (const [rec, fx] of [["evm-quote-calls-record.ts", "evm-quote-calls.json.gz"], ["evm-warm-tap-calls-record.ts", "evm-warm-tap-calls.json.gz"]] as const) {
  test(`${rec} run without --record exits 2, names the flag and leaves ${fx} as it was`, () => {
    const file = fileURLToPath(new URL(`./${rec}`, import.meta.url));
    const fixture = fileURLToPath(new URL(`./fixtures/${fx}`, import.meta.url));
    const before = hashOf(fixture);
    // a recorder that runs reads mainnet for longer than this; one that refuses exits at once
    const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, `exit ${r.status} (signal ${r.signal}): ${String(r.stderr).slice(0, 300)}`);
    assert.match(r.stderr, /--record/);
    assert.equal(hashOf(fixture), before, `${fx} was written`);
  });
}
