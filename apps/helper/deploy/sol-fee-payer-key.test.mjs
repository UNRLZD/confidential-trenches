// node --test apps/helper/deploy/sol-fee-payer-key.test.mjs: the mainnet Solana pool fee payer's key step (card
// helper-sol-fee-payer-mainnet). Each test runs the real script on a temp "server": the script under apps/helper/deploy,
// the pool's mainnet deploy record under contracts/pool-solana/deployments (this checkout's, unless a test plants
// another), two local RPCs that answer the Rent sysvar, and a stub `docker` on PATH that logs its arguments (up to the
// code after -e) and runs this machine's node from apps/helper with what follows the image name, as the image's node
// runs from its WORKDIR /app/apps/helper. A last test plants a leak in a copy of the script (the secret on stdout, the
// secret in docker's argv) and holds the leak check to finding each.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { solanaPoolFee } from "@blindfill/kit";
import { base58 } from "../src/bind/checks.ts";
import { base58decode } from "../src/bind/send.ts";
import { feePayerKey, solanaFeePayerLowMark, solanaPoolSendersFromEnv } from "../src/pool/solana.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, "..");
const SCRIPT = path.join(HERE, "sol-fee-payer-key.sh");
const RECORD_FILE = path.join(HERE, "../../../contracts/pool-solana/deployments/mainnet.json");
const RECORD = readFileSync(RECORD_FILE, "utf8");
const { program_id: PROGRAM, pool: POOL } = JSON.parse(RECORD);
const COMMIT = "c".repeat(40);
const NAMES = ["POOL_SOLANA_PROGRAM_MAINNET", "POOL_SOLANA_FEE_PAYER_KEY_MAINNET", "POOL_SOLANA_FEE_MAINNET", "POOL_SOLANA_RPCS_MAINNET"];
const BASE_ENV = `HELPER_COMMIT=${COMMIT}\nHELPER_RELEASE=3\nBIND_MARGIN_K=60\nJUPITER_API_KEY=test-jupiter-0001\n`;
/** The Rent sysvar's 17 bytes: lamports_per_byte u64 LE, exemption_threshold f64 LE, burn_percent u8. */
const rentData = (perByte, factor) => {
  const b = Buffer.alloc(17);
  b.writeBigUInt64LE(BigInt(perByte), 0);
  b.writeDoubleLE(factor, 8);
  b[16] = 50;
  return b.toString("base64");
};

/** Two local RPCs answering getAccountInfo of the Rent sysvar with `data` each (a list, one per RPC). */
async function rpcs(t, data = [rentData(5_080, 1), rentData(5_080, 1)]) {
  const servers = data.map((d) =>
    createServer((q, r) => {
      let b = "";
      q.on("data", (c) => (b += c)).on("end", () => {
        const { id } = JSON.parse(b);
        r.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: { owner: "Sysvar1111111111111111111111111111111111111", data: [d, "base64"], lamports: 1, executable: false } } }));
      });
    }).listen(0, "127.0.0.1"),
  );
  t.after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));
  await Promise.all(servers.map((s) => new Promise((ok) => (s.listening ? ok() : s.once("listening", ok)))));
  return servers.map((s) => `http://127.0.0.1:${s.address().port}`).join(",");
}

function server({ env = BASE_ENV, record = RECORD, script = readFileSync(SCRIPT, "utf8"), helper = HELPER } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sol-fee-key-"));
  const deploy = path.join(dir, "apps/helper/deploy");
  mkdirSync(deploy, { recursive: true });
  writeFileSync(path.join(deploy, "sol-fee-payer-key.sh"), script);
  chmodSync(path.join(deploy, "sol-fee-payer-key.sh"), 0o755);
  mkdirSync(path.join(dir, "contracts/pool-solana/deployments"), { recursive: true });
  if (record !== null) writeFileSync(path.join(dir, "contracts/pool-solana/deployments/mainnet.json"), record);
  if (env !== null) writeFileSync(path.join(deploy, ".env"), env, { mode: 0o600 });
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const log = path.join(dir, "docker.log");
  writeFileSync(log, "");
  // logs every argument but the code after -e, then runs node from apps/helper with the arguments after the image
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
a=(); for x in "$@"; do [[ "$x" == "-e" ]] && break; a+=("$x"); done
net=0; prev=""; for x in "\$@"; do [[ "\$prev" == "--network" && "\$x" == "none" ]] && net=1; prev="\$x"; done
printf '%s\\n' "\${a[*]}" >> "${log}"
while [[ $# -gt 0 && "$1" != ct-helper:* ]]; do shift; done
[[ "$1" == "ct-helper:${COMMIT}" ]] || exit 125
shift
# STUB_SLEEP: wait that long first (a run that holds the lock a while); PLANT_MAKER: the key maker (the run with
# --network none) prints that file and names PLANT_ADDRESS instead of running
[[ -n "\${STUB_SLEEP:-}" ]] && sleep "\$STUB_SLEEP"
if [[ \$net == 1 && -n "\${PLANT_MAKER:-}" ]]; then cat > /dev/null; cat "\$PLANT_MAKER"; echo "sol-fee-payer-key: fee payer \$PLANT_ADDRESS" >&2; exit 0; fi
cd "${helper}"
exec "${process.execPath}" "$@"
`,
    { mode: 0o755 },
  );
  // async: the local RPCs answer from this process, so the script must not block its event loop
  const run = (extra = {}, args = [], trace = false) =>
    new Promise((ok) => {
      const e = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra };
      for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k];
      const p = spawn("bash", [...(trace ? ["-x"] : []), path.join(deploy, "sol-fee-payer-key.sh"), ...args], { env: e });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (c) => (stdout += c));
      p.stderr.on("data", (c) => (stderr += c));
      p.on("close", (status) => ok({ status, stdout, stderr }));
    });
  const envText = () => readFileSync(path.join(deploy, ".env"), "utf8");
  const docker = () => readFileSync(log, "utf8");
  return { dir, deploy, run, envText, docker };
}

const valueOf = (text, name) => text.split("\n").find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1);
const files = (s) => readdirSync(s.deploy).sort();

/** Where the fee payer's secret, or its seed in any of three encodings, shows in a run's output or docker's argv. */
function leaks(run, docker, secret) {
  const seed = Buffer.from(base58decode(secret)).subarray(0, 32);
  const forms = [secret, seed.toString("hex"), seed.toString("base64"), base58(seed)];
  const out = [];
  if (forms.some((f) => run.stdout.includes(f))) out.push("stdout");
  if (forms.some((f) => run.stderr.includes(f))) out.push("stderr");
  if (forms.some((f) => docker.includes(f))) out.push("argv");
  return out;
}

test("writes the four mainnet names once: the record's program, a real fee payer key, the kit's fee for the rent both RPCs read, the RPC pair; prints only public parts and the SOL to send; the helper's start takes them", async (t) => {
  const pair = await rpcs(t);
  const s = server();
  const before = s.envText();
  const inode = statSync(path.join(s.deploy, ".env")).ino;
  const r = await s.run({ SOL_FEE_PAYER_RPCS: pair });
  assert.equal(r.status, 0, r.stderr);
  const after = s.envText();
  assert.notEqual(statSync(path.join(s.deploy, ".env")).ino, inode, "deploy/.env replaced by a rename, not written in place");
  assert.equal(statSync(path.join(s.deploy, ".env")).mode & 0o777, 0o600, "deploy/.env stays mode 600");
  assert.ok(after.startsWith(before), "every line kept, byte for byte, the four added after them");
  for (const n of NAMES) assert.equal(after.split("\n").filter((l) => l.startsWith(`${n}=`)).length, 1, n);
  assert.equal(valueOf(after, "POOL_SOLANA_PROGRAM_MAINNET"), PROGRAM);
  const rent = { lamportsPerByte: 5_080n, factor: 1n };
  assert.equal(valueOf(after, "POOL_SOLANA_FEE_MAINNET"), solanaPoolFee(rent).toString(), "the kit's fee at the rent read");
  assert.equal(valueOf(after, "POOL_SOLANA_FEE_MAINNET"), "1300000");
  assert.equal(valueOf(after, "POOL_SOLANA_RPCS_MAINNET"), pair);
  const secret = valueOf(after, "POOL_SOLANA_FEE_PAYER_KEY_MAINNET");
  const { address } = feePayerKey(secret);
  // the helper's own start takes the four lines and serves the record's pool from this fee payer
  const helperEnv = Object.fromEntries(after.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const senders = solanaPoolSendersFromEnv(helperEnv, async () => { throw new Error("no network in this test"); });
  const main = senders.get(POOL);
  assert.equal(main?.cluster, "mainnet");
  assert.equal(main?.feePayer, address);
  // nothing secret anywhere: stdout, stderr, docker's argv; no file left beside deploy/.env
  assert.deepEqual(leaks(r, s.docker(), secret), []);
  assert.deepEqual(files(s), [".env", "sol-fee-payer-key.sh"]);
  // the reader has the network and no secret; the maker has no network; both log nothing, read-only, no new privileges
  const runs = s.docker().trim().split("\n");
  assert.equal(runs.length, 2, s.docker());
  for (const line of runs) for (const f of ["--log-driver none", "--pull never", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", `ct-helper:${COMMIT}`]) assert.ok(line.includes(f), `${f} in: ${line}`);
  assert.ok(!runs[0].includes("--network none"), "the reader reads the rent on the network");
  assert.ok(runs[1].includes("--network none"), "the key maker has no network");
  // the print: the address, the low mark and the SOL to send with its reason, in order
  const mark = solanaFeePayerLowMark(rent);
  assert.equal(mark, 2_681_045n);
  assert.match(r.stdout, new RegExp(`^sol-fee-payer-key: fee payer ${address}$`, "m"));
  assert.match(r.stdout, new RegExp(`needs at least ${mark} lamports, its low mark`));
  const order = r.stdout.split("\n").filter((l) => /^sol-fee-payer-key: [1-3]\. /.test(l));
  assert.equal(order.length, 3);
  assert.equal(order[0], `sol-fee-payer-key: 1. apps/helper/deploy/redeploy.sh ${COMMIT} again (the commit the helper runs, whose image made the key), so the helper starts with the four lines`);
  assert.equal(order[1], `sol-fee-payer-key: 2. the owner sends 0.01 SOL (10000000 lamports) to ${address}: the low mark ${mark} and 32 failed sends at 217245 each, rounded up to 0.01 SOL; a page-opening release costs it the page's rent, which the page reserve pays back over the page`);
  assert.ok(!/pays it back more than it fronts/.test(r.stdout), "no claim that every release pays back more than it fronts (a page-opening one does not)");
  assert.match(order[2], /helper-sol-fee-payer-mainnet among them$/);
});

test("the trace (bash -x) shows no secret", async (t) => {
  const pair = await rpcs(t);
  const s = server();
  const r = await s.run({ SOL_FEE_PAYER_RPCS: pair }, [], true);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(leaks(r, s.docker(), valueOf(s.envText(), "POOL_SOLANA_FEE_PAYER_KEY_MAINNET")), []);
});

test("a name already set refuses (exit 3) with deploy/.env unchanged and no container run: each of the four, plain or exported", async () => {
  for (const n of NAMES) {
    for (const line of [`${n}=x`, `export ${n}=x`, `  ${n} = x`]) {
      const env = `${BASE_ENV}${line}\n`;
      const s = server({ env });
      const r = await s.run();
      assert.equal(r.status, 3, `${line}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${n} is already set in deploy/\\.env; nothing changed`));
      assert.equal(s.envText(), env);
      assert.equal(s.docker(), "", "no container ran");
      assert.ok(!r.stderr.includes("=x") && !r.stdout.includes("=x"), "the line's value is not printed");
    }
  }
});

test("no mainnet pool record refuses (exit 4), as does a record that is not mainnet's pool, unchanged", async (t) => {
  const pair = await rpcs(t);
  const none = server({ record: null });
  const r0 = await none.run({ SOL_FEE_PAYER_RPCS: pair });
  assert.equal(r0.status, 4, r0.stderr);
  assert.match(r0.stderr, /no contracts\/pool-solana\/deployments\/mainnet\.json/);
  assert.equal(none.envText(), BASE_ENV);
  assert.equal(none.docker(), "");
  const rec = JSON.parse(RECORD);
  for (const [why, bad] of [
    ["devnet", { ...rec, cluster: "devnet" }],
    ["another genesis", { ...rec, genesis_hash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" }],
    ["a pool not the program's", { ...rec, pool: "D7DSrQdqBZQEKxVXZpwVzdMrpyjfoZ8Vz13kGeMTKfef" }],
    ["no program", { ...rec, program_id: undefined }],
  ]) {
    const s = server({ record: `${JSON.stringify(bad)}\n` });
    const r = await s.run({ SOL_FEE_PAYER_RPCS: pair });
    assert.equal(r.status, 4, `${why}: ${r.stderr}`);
    assert.equal(s.envText(), BASE_ENV, why);
    assert.deepEqual(files(s), [".env", "sol-fee-payer-key.sh"], why);
  }
  const junk = server({ record: "not json" });
  assert.equal((await junk.run({ SOL_FEE_PAYER_RPCS: pair })).status, 4);
});

test("no HELPER_COMMIT (exit 6), a bad RPC pair (exit 2) and two RPCs that disagree on rent (exit 5) each leave deploy/.env unchanged", async (t) => {
  const noImage = server({ env: "HELPER_RELEASE=3\n" });
  assert.equal((await noImage.run()).status, 6);
  assert.equal(noImage.envText(), "HELPER_RELEASE=3\n");
  for (const bad of ["https://a.example", "https://a.example,https://a.example", "https://a.example,https://b.example,https://c.example", "https://a.example, https://b.example", "ftp://a.example,https://b.example", "https://a.example,https://b\".example"]) {
    const s = server();
    const r = await s.run({ SOL_FEE_PAYER_RPCS: bad });
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
    assert.equal(s.envText(), BASE_ENV);
    assert.equal(s.docker(), "");
  }
  const split = await rpcs(t, [rentData(5_080, 1), rentData(2_540, 1)]);
  const s = server();
  const r = await s.run({ SOL_FEE_PAYER_RPCS: split });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /the providers disagree on rent/);
  assert.equal(s.envText(), BASE_ENV);
  assert.deepEqual(files(s), [".env", "sol-fee-payer-key.sh"]);
  assert.equal(s.docker().trim().split("\n").length, 1, "the key maker never ran");
});

test("planted leaks are caught: the secret on stdout, the secret in docker's argv", async (t) => {
  const pair = await rpcs(t);
  const text = readFileSync(SCRIPT, "utf8");
  const at = '  mv -f "$tmp" "$env"\n  TMP=""\n';
  assert.ok(text.includes(at));
  const plants = {
    stdout: `${at}  grep -E '^POOL_SOLANA_FEE_PAYER_KEY_MAINNET=' "$env"\n`,
    argv: `${at}  docker run --rm "ct-helper:$commit" "$(grep -E '^POOL_SOLANA_FEE_PAYER_KEY_MAINNET=' "$env" | cut -d= -f2)" >/dev/null 2>&1 || true\n`,
  };
  for (const [where, plant] of Object.entries(plants)) {
    const s = server({ script: text.replace(at, plant) });
    const r = await s.run({ SOL_FEE_PAYER_RPCS: pair });
    assert.equal(r.status, 0, `${where}: ${r.stderr}`);
    const found = leaks(r, s.docker(), valueOf(s.envText(), "POOL_SOLANA_FEE_PAYER_KEY_MAINNET"));
    assert.ok(found.includes(where), `the ${where} plant is found (${JSON.stringify(found)})`);
  }
});

test("the script is executable in the tree and runs under bash", () => {
  assert.ok(existsSync(SCRIPT));
  assert.ok(statSync(SCRIPT).mode & 0o100, "mode +x");
});

test("the default RPC pair is the helper's keyless mainnet pair (src/data/solana/trades.ts TRADES_RPCS)", async () => {
  const { TRADES_RPCS } = await import("../src/data/solana/trades.ts");
  assert.equal(/^RPCS_DEFAULT="([^"]+)"$/m.exec(readFileSync(SCRIPT, "utf8"))?.[1], TRADES_RPCS.join(","));
});

// review FIX 1 (P-old-image): the documented order once ran this step on the image of the commit before this card,
// whose src/pool/solana.ts has no solanaFeePayerLowMark (5d86814f's has none): the reader died on a raw TypeError. It
// refuses by name now, exit 7, deploy/.env unchanged, and the order puts the redeploy first.
test("an image from before this card (no solanaFeePayerLowMark) refuses by name (exit 7), deploy/.env unchanged; the header puts the redeploy first", async (t) => {
  const pair = await rpcs(t);
  const old = mkdtempSync(path.join(tmpdir(), "sol-fee-old-image-"));
  cpSync(path.join(HELPER, "src"), path.join(old, "src"), { recursive: true });
  copyFileSync(path.join(HELPER, "package.json"), path.join(old, "package.json"));
  symlinkSync(path.join(HELPER, "node_modules"), path.join(old, "node_modules"));
  const file = path.join(old, "src/pool/solana.ts");
  const text = readFileSync(file, "utf8");
  const cut = text.replace(/export const solanaFeePayerLowMark = [^;]+;\n/, "");
  assert.notEqual(cut, text, "the planted image's solana.ts has no solanaFeePayerLowMark");
  writeFileSync(file, cut);
  const s = server({ helper: old });
  const r = await s.run({ SOL_FEE_PAYER_RPCS: pair });
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stderr, new RegExp(`^sol-fee-payer-key: the running image ct-helper:${COMMIT} predates this step \\(no solanaFeePayerLowMark in its src/pool/solana\\.ts\\): redeploy\\.sh .+ first; with the four lines absent the mainnet pool stays off; nothing changed$`, "m"));
  assert.ok(!/TypeError/.test(r.stderr), r.stderr);
  assert.equal(s.envText(), BASE_ENV);
  assert.deepEqual(files(s), [".env", "sol-fee-payer-key.sh"], "no temporary file, no lock left");
  assert.equal(s.docker().trim().split("\n").length, 1, "the key maker never ran");
  const header = readFileSync(SCRIPT, "utf8").split("\n").filter((l) => /^#   [1-5]\. /.test(l));
  assert.match(header[0], /^#   1\. apps\/helper\/deploy\/redeploy\.sh .*first/);
  assert.match(header[1], /^#   2\. this step;$/);
  assert.match(header[2], /^#   3\. apps\/helper\/deploy\/redeploy\.sh <the same commit> again/);
});

// review FIX 2 (P-twice): two runs at once both passed the "already set" check and both renamed: two addresses
// printed, only the second key kept, SOL sent to the first stranded. One lock now, from the check through the rename.
test("two runs at once: one writes, the other refuses on the lock (exit 9); one key in deploy/.env, one address printed, no lock left", async (t) => {
  const pair = await rpcs(t);
  const s = server();
  const first = s.run({ SOL_FEE_PAYER_RPCS: pair, STUB_SLEEP: "1.5" });
  await new Promise((ok) => setTimeout(ok, 400));
  const second = s.run({ SOL_FEE_PAYER_RPCS: pair });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 9, b.stderr);
  assert.match(b.stderr, /another key step holds deploy\/\.env\.lock/);
  const env = s.envText();
  assert.equal(env.split("\n").filter((l) => l.startsWith("POOL_SOLANA_FEE_PAYER_KEY_MAINNET=")).length, 1);
  const addresses = [a, b].flatMap((r) => [...r.stdout.matchAll(/^sol-fee-payer-key: fee payer (\S+)$/gm)].map((m) => m[1]));
  assert.deepEqual(addresses, [feePayerKey(valueOf(env, "POOL_SOLANA_FEE_PAYER_KEY_MAINNET")).address], "one address printed, the kept key's");
  assert.deepEqual(files(s), [".env", "sol-fee-payer-key.sh"]);
  // a lock left by a killed run (SIGKILL) refuses until it is removed
  mkdirSync(path.join(s.deploy, ".env.lock"));
  const c = await s.run({ SOL_FEE_PAYER_RPCS: pair });
  assert.equal(c.status, 9);
  assert.ok(existsSync(path.join(s.deploy, ".env.lock")), "another run's lock is never removed by the refused run");
});

// review FIX 4: base58 of seed||pub is 85 characters for a seed with three leading zero bytes; the form check takes
// 80 to 90 (8ccc7d84's {86,88} refused it, so a real key would have stopped the step)
test("an 85-character key passes the form check and is written", async (t) => {
  const pair = await rpcs(t);
  const seed = Buffer.alloc(32);
  seed[3] = 1;
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  const pub = Buffer.from(ed25519.getPublicKey(seed));
  const key = base58(Buffer.concat([seed, pub]));
  assert.equal(key.length, 85);
  const s = server();
  const plant = path.join(s.dir, "maker.out");
  writeFileSync(plant, `POOL_SOLANA_PROGRAM_MAINNET=${PROGRAM}\nPOOL_SOLANA_FEE_PAYER_KEY_MAINNET=${key}\nPOOL_SOLANA_FEE_MAINNET=1300000\nPOOL_SOLANA_RPCS_MAINNET=${pair}\n`);
  const r = await s.run({ SOL_FEE_PAYER_RPCS: pair, PLANT_MAKER: plant, PLANT_ADDRESS: base58(pub) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(valueOf(s.envText(), "POOL_SOLANA_FEE_PAYER_KEY_MAINNET"), key);
  assert.equal(feePayerKey(key).address, base58(pub));
});
