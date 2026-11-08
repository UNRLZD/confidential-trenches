// The proving setup files for the exit tool (vault paper 2.12 step 6 and V4.2, docs/plan1/vault.md l.944-947 and
// l.1054-1055): fetched from the pinned commit of their source, or from the release mirror when that fails, and each
// checked against the size and sha256 the kit pins (ZK_SETUP_FILES) before anything uses it.
//
// - The sources are tried in order and trusted for nothing: a file is taken only when its bytes are the pinned size
//   and hash it. A source that answers wrong (another status, another size, one byte changed) is passed over for the
//   next, and when none gives the pinned bytes the file is refused (ExitSetupRefused, naming each source's fault).
// - The pinned commit: the Privacy Pools repository at the commit the kit pins (ZK_SETUP_SOURCE), each file at its
//   path there, read from GitHub's raw host.
// - The mirror: the release's static host, where each file sits under its own sha256 (/assets/zk/<sha256>.<ext>, the
//   prover's files). It is a second door to the same bytes, not a second authority: its answer passes the same check.
// - A body is read only up to the pinned size plus one byte, so a source cannot make the tool hold more than the file.
import { ZK_SETUP_FILES, ZK_SETUP_SOURCE, type ZkSetupFileName } from "@blindfill/kit";

/** The release mirror: each setup file at <this><sha256>.<ext>. */
export const EXIT_SETUP_MIRROR = "https://confidential.unrealized.trade/assets/zk/";

/** One place a setup file can be fetched from. */
export type ExitSetupSource = { name: string; url(file: ZkSetupFileName): string };

const GITHUB = "https://github.com/";
if (!ZK_SETUP_SOURCE.repo.startsWith(GITHUB)) throw new Error("exit: the kit's setup source is not on GitHub");
const RAW = `https://raw.githubusercontent.com/${ZK_SETUP_SOURCE.repo.slice(GITHUB.length)}/${ZK_SETUP_SOURCE.commit}/${ZK_SETUP_SOURCE.dir}/`;

/** The pinned commit first, then the release mirror. */
export const EXIT_SETUP_SOURCES: readonly ExitSetupSource[] = Object.freeze([
  Object.freeze({ name: "commit", url: (file: ZkSetupFileName) => RAW + ZK_SETUP_FILES[file].path }),
  Object.freeze({ name: "mirror", url: (file: ZkSetupFileName) => `${EXIT_SETUP_MIRROR}${ZK_SETUP_FILES[file].sha256}.${file.slice(file.lastIndexOf(".") + 1)}` }),
]);

/** No source gave the pinned bytes of `file`; `faults` holds each source's, in the order tried. */
export class ExitSetupRefused extends Error {
  readonly file: string;
  readonly faults: readonly string[];
  constructor(file: string, faults: readonly string[]) {
    super(`exit: setup file ${file} refused: ${faults.join("; ")}`);
    this.name = "ExitSetupRefused";
    this.file = file;
    this.faults = faults;
  }
}

export type ExitSetupArgs = { fetchFn?: typeof fetch; sources?: readonly ExitSetupSource[]; signal?: AbortSignal };

/** The bytes of one setup file, exactly its pinned size and sha256, from the first source that gives them. */
export async function exitSetupFile(file: ZkSetupFileName, args: ExitSetupArgs = {}): Promise<Uint8Array> {
  if (!Object.hasOwn(ZK_SETUP_FILES, file)) throw new ExitSetupRefused(String(file), ["not a setup file the kit pins"]);
  const pin = ZK_SETUP_FILES[file];
  const { fetchFn = fetch, sources = EXIT_SETUP_SOURCES, signal } = args;
  const faults: string[] = [];
  for (const source of sources) {
    signal?.throwIfAborted();
    const url = source.url(file);
    try {
      const res = await fetchFn(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const bytes = await readCapped(res, pin.bytes + 1);
      if (bytes.length > pin.bytes) throw new Error(`more than ${pin.bytes} bytes`);
      if (bytes.length < pin.bytes) throw new Error(`${bytes.length} bytes, not ${pin.bytes}`);
      const sha256 = await sha256Hex(bytes);
      if (sha256 !== pin.sha256) throw new Error(`sha256 ${sha256}, not ${pin.sha256}`);
      return bytes;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      faults.push(`${source.name} ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new ExitSetupRefused(file, faults.length ? faults : ["no source given"]);
}

/** Every setup file the kit pins (or those named), each checked as exitSetupFile checks it. */
export async function exitSetupFiles(
  files: readonly ZkSetupFileName[] = Object.keys(ZK_SETUP_FILES) as ZkSetupFileName[],
  args: ExitSetupArgs = {},
): Promise<Map<ZkSetupFileName, Uint8Array>> {
  const out = new Map<ZkSetupFileName, Uint8Array>();
  for (const file of files) out.set(file, await exitSetupFile(file, args));
  return out;
}

/** The body, read until it ends or reaches `cap` bytes (the read stops there and the body is cancelled). */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  while (n < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  if (n >= cap) await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, cap));
  let at = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - at);
    out.set(p.subarray(0, take), at);
    at += take;
    if (at === out.length) break;
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
