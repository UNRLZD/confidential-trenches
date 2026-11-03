// The licences' notices ship in the built script (card app-token-chart): vite.config.ts keeps every legal comment, so
// klinecharts' Apache-2.0 header and NOTICE (KLineChart, and TradingView Lightweight Charts, whose code it carries) and
// React's MIT headers are in the one script the page loads. Built with the app's own config, as the deploy builds it;
// the planted build drops legal comments (Vite's default under minify) and must lack them, so this test fails on a
// config that drops them.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTICES: [string, RegExp][] = [
  ["klinecharts' own @license header", /@license\s+\*?\s*KLineChart v10\.0\.3/],
  ["klinecharts' NOTICE: KLineChart", /KLineChart, Copyright \(c\) 2019 lihu/],
  ["klinecharts' NOTICE: TradingView Lightweight Charts", /TradingView Lightweight[\s*]+Charts, Copyright \(c\) 2019 TradingView, Inc\./],
  ["React's MIT header", /@license React[\s\S]{0,200}Meta Platforms[\s\S]{0,200}MIT license/],
];

/** The built script's text, built with the app's config and `legal` as given (undefined: the config's own). */
async function script(legal?: boolean): Promise<string> {
  const out = mkdtempSync(path.join(tmpdir(), "ct-legal-"));
  try {
    const output = legal === undefined ? {} : { rolldownOptions: { output: { codeSplitting: false, comments: { legal } } } };
    await build({ root: APP, configFile: path.join(APP, "vite.config.ts"), logLevel: "error", build: { outDir: out, emptyOutDir: true, ...output } });
    const js = readdirSync(path.join(out, "assets")).filter((f) => f.endsWith(".js"));
    assert.equal(js.length, 1, `one script, not ${js.length}`);
    return readFileSync(path.join(out, "assets", js[0]!), "utf8");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test("the built script carries klinecharts' licence header and NOTICE and React's MIT header", async () => {
  const s = await script();
  const missing = NOTICES.filter(([, re]) => !re.test(s)).map(([what]) => what);
  assert.deepEqual(missing, []);
});

test("planted: a build that drops legal comments lacks every notice", async () => {
  const s = await script(false);
  assert.deepEqual(NOTICES.filter(([, re]) => re.test(s)).map(([what]) => what), []);
});
