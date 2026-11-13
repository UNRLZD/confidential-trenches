// Card screens-never-say-proof (13 Nov 07:53Z: removed, the app names no proof): no word the terminal draws, in a words
// file or written in a screen, says proof, proving, ready or pending about the user's money. Every words file under src
// is read through its WORDS, and every screen's own text (JSX text, aria-label, title, placeholder) from its source.
//   node --test apps/terminal/test/screens-never-say-proof.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url);
const FILES = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((p) => /\.tsx?$/.test(p));
/** The words the app never shows about money. */
export const NAMED = /proo?f|prov(e|ed|es|ing)|\bready\b|pending/i;

test("every words file: no word says proof, proving, ready or pending", async () => {
  const files = FILES.filter((p) => /(^|\/)[\w-]*words\.ts$/.test(p));
  assert.ok(files.length >= 10, files.join(", "));
  const bad: string[] = [];
  for (const f of files) {
    const m = (await import(new URL(f, SRC).href)) as Record<string, unknown>;
    for (const [name, v] of Object.entries(m)) {
      if (!v || typeof v !== "object") continue;
      for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
        const text = w && typeof w === "object" && "text" in w ? (w as { text: unknown }).text : null;
        if (typeof text === "string" && NAMED.test(text)) bad.push(`${f} ${name}.${k}: ${JSON.stringify(text)}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test("every screen's own text: no JSX text, aria-label, title or placeholder says it", () => {
  const bad: string[] = [];
  for (const f of FILES.filter((p) => p.endsWith(".tsx"))) {
    const src = readFileSync(new URL(f, SRC), "utf8");
    // JSX text between tags, and the attribute literals a reader or a hover shows
    for (const m of src.matchAll(/>([^<>{}\n]*[A-Za-z][^<>{}\n]*)</g)) if (NAMED.test(m[1]!)) bad.push(`${f}: text ${JSON.stringify(m[1]!.trim())}`);
    for (const m of src.matchAll(/(?:aria-label|title|placeholder|alt)=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
      const v = m[1] ?? m[2] ?? m[3] ?? "";
      if (NAMED.test(v)) bad.push(`${f}: attribute ${JSON.stringify(v)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("the trade box draws no proof line: no trade-proof mark and no proof word id in its source", () => {
  const box = readFileSync(new URL("screens/trade/TradeBox.tsx", SRC), "utf8");
  assert.doesNotMatch(box, /trade-proof|proofReady|proofMaking|trb-proof/);
  const pf = readFileSync(new URL("screens/portfolio/Portfolio.tsx", SRC), "utf8");
  assert.doesNotMatch(pf, /W id="(ready|pending)"|data-ready|data-pending=\{r\./);
  const dep = readFileSync(new URL("screens/deposit/DepositSheet.tsx", SRC), "utf8");
  assert.doesNotMatch(dep, /W id="(ready|pending)"|data-ready|data-pending=\{p\./);
});
