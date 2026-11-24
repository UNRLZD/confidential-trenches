// node --test test/main-settles-caught.test.ts (from packages/signpage): every settle pass src/main.ts starts and does not
// await ends in a catch (card deposit-settle-sign-out-caught). A sign out closes the wallet store under a settle started
// on it, and the settle's next store call rejects "the wallet store is closed": uncaught, that is an unhandled rejection
// in the page. The merge queue's run 45397378447 (24 Nov 12:5xZ, job 138457097899) failed main-withdraw-settle-own.test.ts
// on it: main.ts's store open restarted the deposit follows with `void follows?.settle()`, the one settle call of the
// page with no catch, and the sign out's close made its keys() reject (deposit-follow.ts settle).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MAIN = new URL("../src/main.ts", import.meta.url);

/** Each `void <name>.settle(...)` statement part of `src` whose chain's last call is not `.catch(...)`, by line: the
 *  part runs to its `,` or `;` at the statement's own depth, and only the calls chained at that depth count (a catch
 *  inside an argument catches nothing of the settle). */
export function uncaughtSettles(src: string): string[] {
  const out: string[] = [];
  src.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\bvoid\s+[A-Za-z_$][\w$]*(?:\?\.|\.)settle\(/g)) {
      let depth = 0;
      let end = line.length;
      let last = "settle";
      for (let j = m.index! + m[0].length - 1; j < line.length; j++) {
        const c = line[j];
        if (c === "(") {
          // a call chained at the statement's depth: its name is the word before its paren
          if (depth === 0) last = /([\w$]+)\s*$/.exec(line.slice(0, j))?.[1] ?? "";
          depth++;
        } else if (c === ")") depth--;
        else if (depth === 0 && (c === "," || c === ";")) {
          end = j;
          break;
        }
      }
      if (last !== "catch") out.push(`${i + 1}: ${line.slice(m.index!, end).trim()}`);
    }
  });
  return out;
}

test("card deposit-settle-sign-out-caught: every settle pass main.ts starts unawaited ends in a catch (red at be72fcf9e: main.ts:1709 `void follows?.settle()`)", () => {
  const src = readFileSync(MAIN, "utf8");
  assert.ok((src.match(/\bvoid\s+[\w$]+(?:\?\.|\.)settle\(/g) ?? []).length >= 3, "main.ts starts fewer settle passes than it did: the test reads nothing");
  assert.deepEqual(uncaughtSettles(src), []);
});

test("card deposit-settle-sign-out-caught: planted: a settle with no catch, or a catch inside its arguments only, is named; a caught one, and one caught after a then, are not", () => {
  assert.deepEqual(uncaughtSettles("  void follows?.settle(), void pool?.settle().catch(() => {});"), ["1: void follows?.settle()"]);
  assert.deepEqual(uncaughtSettles("void a.settle(x.catch(() => {}));"), ["1: void a.settle(x.catch(() => {}))"]);
  assert.deepEqual(uncaughtSettles("void a?.settle({ load: true }).catch(() => {});\nvoid r?.settle().then(() => r?.resume()).catch(() => {});"), []);
});
