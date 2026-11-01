#!/usr/bin/env node
// public/api.js is src/api.ts with its types removed by TypeScript's transpileModule (the lockfile's typescript), and
// index.html loads it with its sha384 (Integrity-Policy: blocked-destinations=(script)). Both are committed, so the
// files the deploy copies are the files in the repo, byte for byte; test/api.test.ts fails when either drifts.
//   node packages/signpage/scripts/api-build.mjs     writes public/api.js and the integrity in index.html
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const TAG = /<script type="module" src="\/api\.js" integrity="sha384-[A-Za-z0-9+/=]*" crossorigin="anonymous"><\/script>/;

/** src/api.ts as the browser runs it. */
export function apiJs(source = readFileSync(join(PKG, "src/api.ts"), "utf8")) {
  const out = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, newLine: ts.NewLineKind.LineFeed },
    reportDiagnostics: true,
  });
  if (out.diagnostics?.length) throw new Error(`api-build: ${out.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("; ")}`);
  return out.outputText;
}

export const integrityOf = (text) => `sha384-${createHash("sha384").update(text).digest("base64")}`;

/** index.html with its one api.js tag carrying `integrity`; throws when the tag is not there exactly once. */
export function withIntegrity(html, integrity) {
  if ((html.match(new RegExp(TAG.source, "g")) ?? []).length !== 1) throw new Error("api-build: index.html must hold the api.js script tag exactly once");
  return html.replace(TAG, `<script type="module" src="/api.js" integrity="${integrity}" crossorigin="anonymous"></script>`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const js = apiJs();
  writeFileSync(join(PKG, "public/api.js"), js);
  const html = join(PKG, "index.html");
  writeFileSync(html, withIntegrity(readFileSync(html, "utf8"), integrityOf(js)));
  console.log(`api-build: public/api.js ${integrityOf(js)}`);
}
