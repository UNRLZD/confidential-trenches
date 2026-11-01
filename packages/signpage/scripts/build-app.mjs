#!/usr/bin/env node
// Builds the signing page's one script: src/main.ts and the wallet code it imports, bundled by Vite (rolldown) into
// public/app.js, and index.html with that file's sha384, since SIGN_HOST's Integrity-Policy blocks a script without
// integrity metadata (public/_headers). Both files are committed, so the deploy's build (scripts/deploy.mjs, a copy of
// index.html and public/) and every harness serve exactly these bytes, and a release can be checked byte for byte.
//   node packages/signpage/scripts/build-app.mjs           writes public/app.js and index.html
//   node packages/signpage/scripts/build-app.mjs --check   exit 1 when the committed files differ from a fresh build
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
export const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

/** The page around the script: no inline script or style, nothing but the one module script with its integrity. */
export const page = (integrity) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <script type="module" src="/app.js" integrity="${integrity}"></script>
  </head>
  <body></body>
</html>
`;

/** A fresh bundle: { js, html } as bytes and text. */
export async function bundle(pkg = PKG) {
  const { build } = await import("vite");
  const out = mkdtempSync(join(tmpdir(), "ct-signpage-app-"));
  try {
    await build({
      configFile: false,
      root: pkg,
      logLevel: "warn",
      publicDir: false,
      build: {
        outDir: out,
        emptyOutDir: true,
        target: "es2023",
        minify: true,
        modulePreload: false,
        copyPublicDir: false,
        rolldownOptions: {
          input: join(pkg, "src/main.ts"),
          output: { format: "es", entryFileNames: "app.js", codeSplitting: false },
        },
      },
    });
    const js = readFileSync(join(out, "app.js"));
    return { js, html: page(sha384(js)) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Problems with the committed files (in `committed`, the package by default) against a fresh build (empty = they match). */
export async function check(pkg = PKG, committed = pkg) {
  const fresh = await bundle(pkg);
  const p = [];
  let js = null;
  try {
    js = readFileSync(join(committed, "public/app.js"));
  } catch {}
  if (!js || !js.equals(fresh.js)) p.push("public/app.js is not the build of src/main.ts: run node packages/signpage/scripts/build-app.mjs");
  if (readFileSync(join(committed, "index.html"), "utf8") !== fresh.html) p.push("index.html is not the page around public/app.js with its sha384");
  return p;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const p = await check();
    for (const l of p) console.error(`build-app: ${l}`);
    if (!p.length) console.log("build-app: public/app.js and index.html match a fresh build");
    process.exit(p.length ? 1 : 0);
  }
  const { js, html } = await bundle();
  writeFileSync(join(PKG, "public/app.js"), js);
  writeFileSync(join(PKG, "index.html"), html);
  console.log(`build-app: public/app.js ${js.length} bytes, ${sha384(js)}`);
}
