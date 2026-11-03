// The exit tool's setup files, offline: the two sources are stubs serving the kit's own vendored files
// (packages/kit/zk/), whole or with one byte changed. A file is taken only when its bytes are the kit's pinned size and
// sha256, from the pinned commit first and the mirror second; a file with one byte changed is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ZK_SETUP_FILES, ZK_SETUP_SOURCE, type ZkSetupFileName } from "@blindfill/kit";
import { EXIT_SETUP_MIRROR, EXIT_SETUP_SOURCES, ExitSetupRefused, exitSetupFile, exitSetupFiles } from "../src/setup.ts";

// the kit's vendored setup files, read as test bytes (data, not code) from the repository root
const ROOT = new URL("../../../", import.meta.url);
const ZK = new URL("packages/kit/zk/", ROOT);
const NAMES = Object.keys(ZK_SETUP_FILES) as ZkSetupFileName[];
const FILES = new Map(NAMES.map((n) => [n, new Uint8Array(readFileSync(new URL(n, ZK)))]));
const [COMMIT, MIRROR] = EXIT_SETUP_SOURCES;

type Serve = (url: string) => Uint8Array | number; // the body, or a status
/** A fetch that answers each URL from `serve` and logs the URLs asked, in order. */
function stub(serve: Serve) {
  const asked: string[] = [];
  const fetchFn = (async (url: string) => {
    asked.push(url);
    const r = serve(url);
    return typeof r === "number" ? new Response(null, { status: r }) : new Response(r as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}
const nameOf = (url: string): ZkSetupFileName => {
  for (const n of NAMES) if (url === COMMIT.url(n) || url === MIRROR.url(n)) return n;
  throw new Error(`no such source URL: ${url}`);
};
const flip = (b: Uint8Array, at: number) => {
  const c = b.slice();
  c[at] ^= 0x01;
  return c;
};
const refused = (file: string, ...faults: RegExp[]) => (e: unknown) =>
  e instanceof ExitSetupRefused && e.file === file && e.faults.length === faults.length && faults.every((f, i) => f.test(e.faults[i]));

test("the vendored files are the kit's pins (the stubs serve the real bytes)", () => {
  for (const n of NAMES) {
    assert.equal(FILES.get(n)!.length, ZK_SETUP_FILES[n].bytes, n);
    assert.equal(createHash("sha256").update(FILES.get(n)!).digest("hex"), ZK_SETUP_FILES[n].sha256, n);
  }
});

test("the sources: the pinned commit's raw files, then the release mirror by sha256", () => {
  assert.deepEqual(EXIT_SETUP_SOURCES.map((s) => s.name), ["commit", "mirror"]);
  assert.equal(
    COMMIT.url("withdraw.zkey"),
    "https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/c312dcd58f6ad085204be61923c49f8065e4e9ae/packages/circuits/trusted-setup/final-keys/withdraw.zkey",
  );
  assert.equal(ZK_SETUP_SOURCE.commit, "c312dcd58f6ad085204be61923c49f8065e4e9ae");
  for (const n of NAMES) {
    assert.equal(COMMIT.url(n), `https://raw.githubusercontent.com/0xbow-io/privacy-pools-core/${ZK_SETUP_SOURCE.commit}/packages/circuits/${ZK_SETUP_FILES[n].path}`);
    assert.equal(MIRROR.url(n), `${EXIT_SETUP_MIRROR}${ZK_SETUP_FILES[n].sha256}.${n.split(".")[1]}`);
  }
  assert.ok(Object.isFrozen(EXIT_SETUP_SOURCES));
});

test("every file is taken from the pinned commit when it serves the pinned bytes, and the mirror is not asked", async () => {
  const { fetchFn, asked } = stub((url) => (url.startsWith(EXIT_SETUP_MIRROR) ? 500 : FILES.get(nameOf(url))!));
  const got = await exitSetupFiles(undefined, { fetchFn });
  for (const n of NAMES) assert.deepEqual(got.get(n), FILES.get(n), n);
  assert.deepEqual(asked, NAMES.map((n) => COMMIT.url(n)));
});

test("a setup file with one byte changed is refused, at the first, a middle and the last byte of each file", async () => {
  for (const n of NAMES) {
    const good = FILES.get(n)!;
    for (const at of [0, good.length >> 1, good.length - 1]) {
      const bad = flip(good, at);
      // both sources serve the changed bytes: refused, each source named
      const both = stub(() => bad);
      await assert.rejects(exitSetupFile(n, { fetchFn: both.fetchFn }), refused(n, /^commit .*: sha256 [0-9a-f]{64}, not /, /^mirror .*: sha256 [0-9a-f]{64}, not /), `${n} byte ${at}`);
      // the pinned commit serves the changed bytes and the mirror the real ones: the mirror's are taken
      const one = stub((url) => (url.startsWith(EXIT_SETUP_MIRROR) ? good : bad));
      assert.deepEqual(await exitSetupFile(n, { fetchFn: one.fetchFn }), good, `${n} byte ${at} from the mirror`);
      assert.deepEqual(one.asked, [COMMIT.url(n), MIRROR.url(n)]);
    }
  }
});

test("every byte of a verification key, changed, is refused", async () => {
  for (const n of ["withdraw.vkey", "commitment.vkey"] as const) {
    const good = FILES.get(n)!;
    for (let at = 0; at < good.length; at++) {
      const bad = flip(good, at);
      await assert.rejects(exitSetupFile(n, { fetchFn: stub(() => bad).fetchFn }), ExitSetupRefused, `${n} byte ${at}`);
    }
  }
});

test("a byte short, a byte over, another status or a source that throws is passed over, and a body over the pin is not read whole", async () => {
  const n = "withdraw.vkey";
  const good = FILES.get(n)!;
  const short = stub(() => good.subarray(0, good.length - 1));
  await assert.rejects(exitSetupFile(n, { fetchFn: short.fetchFn }), refused(n, /: 4207 bytes, not 4208$/, /: 4207 bytes, not 4208$/));
  const over = stub(() => Uint8Array.of(...good, 0));
  await assert.rejects(exitSetupFile(n, { fetchFn: over.fetchFn }), refused(n, /: more than 4208 bytes$/, /: more than 4208 bytes$/));
  const status = stub(() => 404);
  await assert.rejects(exitSetupFile(n, { fetchFn: status.fetchFn }), refused(n, /: HTTP 404$/, /: HTTP 404$/));
  const thrown = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  await assert.rejects(exitSetupFile(n, { fetchFn: thrown }), refused(n, /ENOTFOUND$/, /ENOTFOUND$/));

  // a source that never ends its body: the read stops one byte past the pin and cancels it
  let pulled = 0;
  let cancelled = false;
  const endless = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1024;
          c.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  await assert.rejects(exitSetupFile(n, { fetchFn: endless, sources: [COMMIT] }), refused(n, /: more than 4208 bytes$/));
  assert.ok(cancelled && pulled < 4208 + 4 * 1024, `pulled ${pulled} bytes`);
});

test("a name the kit does not pin, and no source, are refused; an abort ends the load", async () => {
  await assert.rejects(exitSetupFile("withdraw.r1cs" as ZkSetupFileName, { fetchFn: stub(() => 500).fetchFn }), refused("withdraw.r1cs", /not a setup file the kit pins/));
  await assert.rejects(exitSetupFile("withdraw.vkey", { sources: [] }), refused("withdraw.vkey", /no source given/));
  const ac = new AbortController();
  ac.abort(new Error("stopped by the user"));
  await assert.rejects(exitSetupFile("withdraw.vkey", { fetchFn: stub(() => FILES.get("withdraw.vkey")!).fetchFn, signal: ac.signal }), /stopped by the user/);
});
