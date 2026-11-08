#!/usr/bin/env node
// Card recordings-no-local-paths: a recorded live-check answer names the repo file or the URL it read, never a folder
// on the machine that recorded it. This gate fails when one does:
//   node scripts/ci/answers-no-local-paths.mjs [root]      (exit 1 and one line per refusal)
// It reads every scripts/live-checks/*.answers.json git lists (tracked, and untracked but not ignored), parses it, and
// refuses any key or string value that holds an absolute local path: a POSIX path under a user's, a temp or a mount
// folder (/Users/, /home/, /root/, /private/, /tmp/, /var/folders/, /var/tmp/, /Volumes/, /mnt/, /opt/, /run/user/),
// a home-relative ~/ path, a Windows drive (C:\ or C:/), a UNC share (\\server\) or a file: URL. A path counts only
// where it starts the string or follows a space or punctuation, so a URL's own path (https://host/tmp/x) and a
// look-alike (/tmp-x, tmp.abc) pass. A file that does not parse is refused, since it cannot be read.
// Risk it holds: a reader of the public repo sees the recorder's machine paths and tool folders (app-trade-box-mount's
// shot fields and signpage-shell's source fields on main ad1136e, 8 Nov).
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GLOB = "scripts/live-checks/*.answers.json";
// before a match: not a name character or a slash, so the path is not the tail of a URL or of a longer word
const AT = String.raw`(?<![A-Za-z0-9_.~/\\-])`;
const POSIX = ["Users", "home", "root", "private", "tmp", "var/folders", "var/tmp", "Volumes", "mnt", "opt", "run/user"];
// the POSIX folders and ~/ in their own case (/Users/ is macOS's; a lower-case /users/ is a URL's); a drive followed
// by a name (C:\Users, so a regex's escaped s:\/\/ in recorded code passes), a share and a file: URL in any case
const PATTERNS = [
  new RegExp([`${AT}/(?:${POSIX.join("|")})/`, `${AT}~/`].join("|")),
  new RegExp([String.raw`(?<![A-Za-z0-9_])[A-Za-z]:[\\/][A-Za-z0-9_.$~-]`, String.raw`${AT}\\\\[A-Za-z0-9_.$-]+\\`, String.raw`(?<![A-Za-z0-9_])file:/`].join("|"), "i"),
];

/** The first local path a string holds, from its start to the next space, quote or separator; or null. */
export function localPath(s) {
  const at = Math.min(...PATTERNS.map((re) => re.exec(s)?.index ?? Infinity));
  return at === Infinity ? null : s.slice(at).split(/[\s"',;)]/)[0];
}

/** The refusals in one parsed answers file: [json path, the path found]. */
export function refusals(value) {
  const out = [];
  const walk = (v, at) => {
    if (typeof v === "string") {
      const p = localPath(v);
      if (p) out.push([at, p]);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        const p = localPath(k);
        if (p) out.push([`${at} (a key)`, p]);
        walk(x, at ? `${at}.${k}` : k);
      }
  };
  walk(value, "");
  return out;
}

export function answersNoLocalPaths(root) {
  const files = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", GLOB], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const out = [];
  let read = 0;
  for (const f of [...new Set(files)]) {
    let value;
    try {
      value = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
    } catch (e) {
      out.push(`${f}: could not be read as JSON (${String(e?.message ?? e).split("\n")[0]}), so it is refused`);
      continue;
    }
    read++;
    for (const [at, p] of refusals(value)) out.push(`${f}: ${at || "(the whole file)"} holds a local path, ${p}: record the file name or the repo path`);
  }
  return { refusals: out, read };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = answersNoLocalPaths(process.argv[2] ?? process.cwd());
  for (const x of r.refusals) console.error(`answers-no-local-paths: REFUSED: ${x}`);
  if (r.refusals.length) process.exit(1);
  console.log(`answers-no-local-paths: OK (${r.read} answers file(s) read)`);
}
