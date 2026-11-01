// The build's last step: every script and stylesheet tag of the built index.html gets the sha384 of the file written
// to disk (the bytes the host serves), so APP_HOST's Integrity-Policy (blocked-destinations=(script), app.md 2.3) lets
// each one run; and the shell's fonts are preloaded, so the first paint is not held back by them. A script tag without
// a src (inline), or one whose file is missing, stops the build.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const sha384 = (bytes) => `sha384-${createHash("sha384").update(bytes).digest("base64")}`;

// html: the built index.html; read(urlPath) gives the bytes of a root-relative path; fonts: root-relative woff2 paths
export function addIntegrity(html, read, fonts = []) {
  const tag = (attrs, url) => {
    if (/\sintegrity=/.test(attrs)) throw new Error(`already has an integrity: ${url}`);
    return sha384(read(url));
  };
  let out = html.replace(/<script\b([^>]*)>/g, (whole, attrs) => {
    const src = /\ssrc="([^"]+)"/.exec(attrs)?.[1];
    if (!src) throw new Error(`an inline script in index.html: ${whole}`);
    return `<script${attrs} integrity="${tag(attrs, src)}">`;
  });
  out = out.replace(/<link\b([^>]*\srel="(?:stylesheet|modulepreload)"[^>]*)>/g, (_, attrs) => {
    const href = /\shref="([^"]+)"/.exec(attrs)[1];
    return `<link${attrs} integrity="${tag(attrs, href)}">`;
  });
  const preloads = fonts.map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`).join("\n    ");
  if (preloads) out = out.replace("</title>", `</title>\n    ${preloads}`);
  return out;
}

export function sri() {
  let outDir = "dist";
  return {
    name: "ct-sri",
    apply: "build",
    enforce: "post",
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const file = path.join(outDir, "index.html");
      const read = (url) => readFileSync(path.join(outDir, url.replace(/^\//, "")));
      const fonts = readdirSync(path.join(outDir, "assets")).filter((f) => f.endsWith(".woff2")).sort().map((f) => `/assets/${f}`);
      writeFileSync(file, addIntegrity(readFileSync(file, "utf8"), read, fonts));
    },
  };
}
