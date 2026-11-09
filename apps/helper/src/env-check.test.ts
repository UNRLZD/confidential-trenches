// node --test src/env-check.test.ts: the pool senders' settings check that deploy/redeploy.sh runs before a swap refuses
// every network set only in part (the deploy of 2026-11-04 had POOL_EVM_SENDER_KEY_BASE_SEPOLIA alone, and both
// redeploys left a new helper that never got ready), takes a whole set, and names variables, never values.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { evmPoolProvidersOf, evmPoolVenues, evmRpcOperator } from "@blindfill/kit";
import { checkPoolEnv } from "./env-check.ts";
import { evmPoolSendersFromEnv, POOL_EVM_ENV, POOL_EVM_SELL_ENV } from "./pool/evm.ts";
import { POOL_SOLANA_ENV } from "./pool/solana.ts";

// test values only: no key here holds or moves anything
const EVM = ["0x" + "ab".repeat(20), "0x" + "11".repeat(32), "10000000000000", "0x" + "cd".repeat(20), "https://a.example,https://b.example"];
// the pool a network's senders start with: the kit's pin for it (evmPoolSendersFromEnv, card helper-evm-mainnet-pools)
const PIN_OF = (network: string): string => evmPoolVenues()[network as keyof ReturnType<typeof evmPoolVenues>].pool!;
const SOL = ["11111111111111111111111111111111", "not-a-key-test-value", "5000", "https://a.example,https://b.example"];
const subsets = (n: number) => Array.from({ length: (1 << n) - 1 }, (_, m) => [...Array(n).keys()].filter((i) => (m + 1) & (1 << i)));
const refusal = (env: Record<string, string>) => {
  try {
    checkPoolEnv(env);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

test("an EVM network with only some of its names set is refused, naming one of its variables and no value; the address and key are taken with the RPCs, or with the RPCs unset where the kit lists the network's fee pair (card evm-quote-warm-round fold 8), and refused naming the RPCs where it lists none; the fee (unset or the kit's floor) and the fee recipient optional", () => {
  const kit = evmPoolVenues();
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) {
    const v = kit[network as keyof typeof kit];
    // the same network with no fee pair in the kit: only its RPCs, set, read the past blocks
    const { feeProviders: _, ...bare } = v!;
    for (const [venues, paired] of [[kit, v?.feeProviders !== undefined], [{ ...kit, [network]: bare }, false]] as const) {
      for (const set of subsets(names.length)) {
        const env = Object.fromEntries(set.map((i) => [names[i]!, i === 0 ? PIN_OF(network) : EVM[i]!]));
        const keyed = [0, 1].every((i) => set.includes(i));
        const whole = keyed && (set.includes(4) || paired);
        const why = (() => {
          try {
            evmPoolSendersFromEnv(env, venues);
            return null;
          } catch (e) {
            return (e as Error).message;
          }
        })();
        if (whole) assert.equal(why, null, `${network} ${set.join(",")}${paired ? " (the kit's fee pair)" : ""}`);
        else {
          assert.ok(why !== null, `${network}: ${set.map((i) => names[i]).join(", ")} alone was taken${paired ? "" : " with no fee pair in the kit"}`);
          // the address and key set, the RPCs not and no fee pair: the refusal names the RPCs
          if (keyed) assert.ok(why.includes(names[4]), why);
          else assert.ok(names.some((n) => why.includes(n)), why);
          for (const x of EVM) assert.ok(!why.includes(x), `a value in: ${why}`);
        }
      }
    }
    // every network the senders run on has the kit's fee pair today (packages/kit/src/trade/evm/buy-unpinned.ts), so the
    // deploy's own check, which reads the kit's list, takes the address and key alone
    assert.ok(v?.feeProviders !== undefined, `${network}: no fee pair in the kit`);
    assert.equal(refusal({ [names[0]]: PIN_OF(network), [names[1]]: EVM[1]! }), null, `${network}: the address and key alone`);
    assert.ok(refusal({ [POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV]]: "0x" + "22".repeat(32) })?.includes(POOL_EVM_SELL_ENV[network as keyof typeof POOL_EVM_SELL_ENV]), `${network}: a sell key alone`);
  }
});

// (the Solana reader's refusal of a missing fee payer key, "fee payer key: not 64 bytes", names no variable; it is refused all the same)
test("a Solana cluster with only some of its names set is refused, with no value in the refusal", () => {
  for (const [cluster, names] of Object.entries(POOL_SOLANA_ENV)) {
    for (const set of subsets(names.length).filter((s) => s.length < names.length)) {
      const why = refusal(Object.fromEntries(set.map((i) => [names[i]!, SOL[i]!])));
      assert.ok(why !== null, `${cluster}: ${set.map((i) => names[i]).join(", ")} alone was taken`);
      for (const v of SOL) assert.ok(!why.includes(v), `a value in: ${why}`);
    }
  }
});

/**
 * card vault-lines-record-read: vault-lines.sh reads the record with node in the running helper's image
 * (ct-helper:<HELPER_COMMIT>); this stub `docker` in `dir`/bin runs this machine's node with what follows the image
 * name, as the image's node would. The PATH to spawn the script with.
 */
async function dockerStub(dir: string): Promise<string> {
  const fs = await import("node:fs");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash\nwhile [[ $# -gt 0 && "$1" != ct-helper:* ]]; do shift; done\n[[ "$1" == "ct-helper:${"a".repeat(40)}" ]] || exit 125\nshift\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ""}`;
}

// card helper-v1-cutover: the record commit moves MAINNET_VAULT, and the host's .env still names the vault before it.
// The settings check redeploy.sh runs before the swap refuses those lines at once (not after the 300 s wait), and
// deploy/vault-lines.sh moves them to mainnet-v1.json's vault, after which the check takes them.
test("MAINNET_VAULT moves: env-check refuses the old WITHDRAW_VAULT_MAINNET and BIND_VAULT_MAINNET at once, naming the variable and no key; vault-lines.sh moves both lines, printing no value, and env-check takes them", async () => {
  const { checkSenderEnv } = await import("./env-check.ts");
  const { MAINNET_VAULT } = await import("./withdraw/send.ts");
  const { createPrivateKey, createPublicKey } = await import("node:crypto");
  const { b58encode } = await import("./data/solana/lists.ts");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const keyOf = (fill: number) => {
    const seed = Buffer.alloc(32, fill);
    const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    const pub = Buffer.from(createPublicKey(priv).export({ format: "jwk" }).x as string, "base64url");
    return { key: `ed25519:${b58encode(Buffer.concat([seed, pub]))}`, account: pub.toString("hex") };
  };
  const OLD: string = MAINNET_VAULT;
  const NEXT = OLD === "vault.confidential.unrlzd.near" ? "vault2.confidential.unrlzd.near" : "vault.confidential.unrlzd.near";
  const [w, b] = [keyOf(3), keyOf(4)];
  const store = fs.mkdtempSync(path.join(os.tmpdir(), "envchk-store-"));
  const lines = [
    "HELPER_COMMIT=" + "a".repeat(40),
    "HELPER_RELEASE=9",
    `HELPER_STORE_DIR=${store}`,
    "BIND_MARGIN_K=60",
    `WITHDRAW_VAULT_MAINNET=${OLD}`,
    `WITHDRAW_RELAYER_MAINNET=${w.account}`,
    `WITHDRAW_FEE_RECIPIENT_MAINNET=${w.account}`,
    `WITHDRAW_RELAYER_KEYS_MAINNET=${w.key}`,
    `BIND_VAULT_MAINNET=${OLD}`,
    `BIND_RELAYER_MAINNET=${b.account}`,
    `BIND_RELAYER_KEY_MAINNET=${b.key}`,
    "JUPITER_API_KEY=test-jupiter-0001",
  ];
  const parse = (text: string) => Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const refusal = (env: Record<string, string>, pin: string) => {
    try {
      checkSenderEnv(env, pin);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const before = parse(lines.join("\n"));
  assert.equal(refusal(before, OLD), null, "the set is whole under the pin it was written for");
  // the release moves its pin: the old lines are refused by the settings check itself, each by name
  const why = refusal(before, NEXT);
  assert.match(why ?? "", /^WITHDRAW_VAULT_MAINNET must be /, why ?? "taken");
  const bindOnly = Object.fromEntries(Object.entries(before).filter(([k]) => !k.startsWith("WITHDRAW_")));
  assert.match(refusal(bindOnly, NEXT) ?? "", /^BIND_VAULT_MAINNET must be /);
  for (const m of [why!, refusal(bindOnly, NEXT)!]) for (const k of [w.key, b.key]) assert.ok(!m.includes(k.slice(8)), m);
  // it runs beside the live helper on the same store volume: it opens no store and takes no lock
  assert.deepEqual(fs.readdirSync(store), [], "the check opened nothing in the store");

  // the script on a temp server: the record commit's mainnet-v1.json, and the .env as the host has it
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-lines-"));
  const deploy = path.join(dir, "apps/helper/deploy");
  fs.mkdirSync(deploy, { recursive: true });
  fs.mkdirSync(path.join(dir, "contracts/vault/deployments"), { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, "../deploy/vault-lines.sh"), path.join(deploy, "vault-lines.sh"));
  fs.writeFileSync(path.join(dir, "contracts/vault/deployments/mainnet-v1.json"), `${JSON.stringify({ network: "mainnet", account_id: NEXT, scope: "7" }, null, 1)}\n`);
  const envFile = path.join(deploy, ".env");
  fs.writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  const inode = fs.statSync(envFile).ino;
  const PATH = await dockerStub(dir);
  const r = spawnSync("bash", [path.join(deploy, "vault-lines.sh")], { encoding: "utf8", env: { ...process.env, PATH } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /moved WITHDRAW_VAULT_MAINNET BIND_VAULT_MAINNET to mainnet-v1\.json's vault/);
  for (const v of [OLD, NEXT, w.key.slice(8), b.key.slice(8)]) assert.ok(!(r.stdout + r.stderr).includes(v), "no value printed");
  const after = fs.readFileSync(envFile, "utf8");
  assert.equal(after, `${lines.map((l) => (l.startsWith("WITHDRAW_VAULT_MAINNET=") || l.startsWith("BIND_VAULT_MAINNET=") ? `${l.slice(0, l.indexOf("="))}=${NEXT}` : l)).join("\n")}\n`, "only the two vault lines changed");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.notEqual(fs.statSync(envFile).ino, inode, "replaced by one rename");
  assert.deepEqual(fs.readdirSync(deploy).sort(), [".env", "vault-lines.sh"], "no temporary file left");
  assert.equal(refusal(parse(after), NEXT), null, "the moved lines are taken under the new pin");
  // a second run changes nothing
  const again = spawnSync("bash", [path.join(deploy, "vault-lines.sh")], { encoding: "utf8", env: { ...process.env, PATH } });
  assert.equal(again.status, 0);
  assert.equal(fs.readFileSync(envFile, "utf8"), after);
});

// card helper-v1-cutover: vault-lines.sh never falls back to the test vault and never edits a line it cannot read
test("vault-lines.sh: no mainnet-v1.json (only mainnet-test.json), a record that names no mainnet vault, or a vault line not in the plain form is refused with deploy/.env unchanged; a name not set stays unset", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const server = async (env: string, record: string | null) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-lines-"));
    const deploy = path.join(dir, "apps/helper/deploy");
    fs.mkdirSync(deploy, { recursive: true });
    fs.mkdirSync(path.join(dir, "contracts/vault/deployments"), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, "../deploy/vault-lines.sh"), path.join(deploy, "vault-lines.sh"));
    fs.writeFileSync(path.join(dir, "contracts/vault/deployments/mainnet-test.json"), JSON.stringify({ network: "mainnet", account_id: "vault-test.confidential.unrlzd.near" }));
    if (record !== null) fs.writeFileSync(path.join(dir, "contracts/vault/deployments/mainnet-v1.json"), record);
    fs.writeFileSync(path.join(deploy, ".env"), env, { mode: 0o600 });
    const r = spawnSync("bash", [path.join(deploy, "vault-lines.sh")], { encoding: "utf8", env: { ...process.env, PATH: await dockerStub(dir) } });
    return { r, text: fs.readFileSync(path.join(deploy, ".env"), "utf8"), files: fs.readdirSync(deploy).sort() };
  };
  // the running image's line, which the record reader needs (vault-lines.sh exit 6 without it)
  const IMAGE = `HELPER_COMMIT=${"a".repeat(40)}\n`;
  const OLD = "WITHDRAW_VAULT_MAINNET=vault-test.confidential.unrlzd.near\n";
  const rec = (o: object) => JSON.stringify(o);
  for (const [record, code] of [[null, 4], [rec({ network: "testnet", account_id: "vault.x.testnet" }), 4], [rec({ network: "mainnet", account_id: "Evil Vault" }), 4], [rec({ network: "mainnet" }), 4], ["{not json", 4], [rec({ network: "mainnet", x: { account_id: "b.near" } }), 4]] as const) {
    const s = await server(IMAGE + OLD, record);
    assert.equal(s.r.status, code, `${record}: ${s.r.stderr}`);
    assert.equal(s.text, IMAGE + OLD);
  }
  // card vault-lines-record-read: the top level's account_id is the vault, a nested one (the real record's
  // sources.account_id) is never read for it
  const nested = await server(IMAGE + OLD, rec({ network: "mainnet", account_id: "a.near", x: { account_id: "b.near" } }));
  assert.equal(nested.r.status, 0, nested.r.stderr);
  assert.equal(nested.text, `${IMAGE}WITHDRAW_VAULT_MAINNET=a.near\n`);
  // no image line: refused before the record is read, deploy/.env unchanged
  const noImage = await server(OLD, rec({ network: "mainnet", account_id: "vault.confidential.unrlzd.near" }));
  assert.equal(noImage.r.status, 6, noImage.r.stderr);
  assert.equal(noImage.text, OLD);
  const good = rec({ network: "mainnet", account_id: "vault.confidential.unrlzd.near" });
  for (const env of ["export WITHDRAW_VAULT_MAINNET=vault-test.confidential.unrlzd.near\n", "WITHDRAW_VAULT_MAINNET = vault-test.confidential.unrlzd.near\n", `${OLD}${OLD}`, "BIND_VAULT_MAINNET: vault-test.confidential.unrlzd.near\n"]) {
    const s = await server(IMAGE + env, good);
    assert.equal(s.r.status, 1, `${env}: ${s.r.stderr}`);
    assert.equal(s.text, IMAGE + env);
    assert.deepEqual(s.files, [".env", "vault-lines.sh"]);
  }
  // only the withdrawal's line set: it moves, and BIND_VAULT_MAINNET stays unset
  const s = await server(`HELPER_COMMIT=${"a".repeat(40)}\n${OLD}`, good);
  assert.equal(s.r.status, 0, s.r.stderr);
  assert.equal(s.text, `HELPER_COMMIT=${"a".repeat(40)}\nWITHDRAW_VAULT_MAINNET=vault.confidential.unrlzd.near\n`);
  const usage = spawnSync("bash", [path.join(import.meta.dirname, "../deploy/vault-lines.sh"), "--force"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("node src/env-check.ts exits 2 on the deploy's half set (a sender key alone), naming its network's variable and never the key; 0 on a whole set", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, [path.join(import.meta.dirname, "env-check.ts")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  const names = POOL_EVM_ENV["base-sepolia"];
  const half = run({ [names[1]]: EVM[1]! });
  assert.equal(half.status, 2, half.stdout + half.stderr);
  assert.match(half.stderr, /POOL_EVM_[A-Z_]+_BASE_SEPOLIA/);
  assert.ok(!(half.stdout + half.stderr).includes(EVM[1]!.slice(2)), "the key was printed");
  const whole = run(Object.fromEntries(names.map((n, i) => [n, i === 0 ? PIN_OF("base-sepolia") : EVM[i]!])));
  assert.equal(whole.status, 0, whole.stdout + whole.stderr);
});

// card robinhood-mainnet-rpcs fold B: a POOL_EVM_RPCS_<NETWORK> the host sets passes the same two-operator check as the
// kit's pool list (an operator: the host's last two labels, an IP its address): two URLs of one operator are one
// provider's word, and the start refuses them with the reason, naming the variable and the operator, never a URL's
// path or query (a key may sit there).
test("fold B: POOL_EVM_RPCS_* of two URLs of one operator is refused at the start, naming the variable and the operator; two operators, and the kit's fee pairs, are taken", () => {
  const env = (rpcs: string) => ({ POOL_EVM_ADDRESS_ROBINHOOD: PIN_OF("robinhood"), POOL_EVM_SENDER_KEY_ROBINHOOD: EVM[1]!, POOL_EVM_RPCS_ROBINHOOD: rpcs });
  for (const rpcs of ["https://rpc.mainnet.chain.robinhood.com,https://rpc.testnet.chain.robinhood.com/v2/s3cr3tKEY", "https://a.robinhood.com,https://b.robinhood.com", "http://127.0.0.1:1,http://127.0.0.1:2"]) {
    const why = refusal(env(rpcs));
    assert.ok(why !== null, `${rpcs}: taken`);
    assert.match(why, /^POOL_EVM_RPCS_ROBINHOOD must be two RPC URLs of two operators: both are (robinhood\.com|127\.0\.0\.1)$/, why);
    assert.ok(!why.includes("s3cr3tKEY"), why);
  }
  assert.equal(refusal(env("https://rpc.mainnet.chain.robinhood.com,https://robinhood.api.pocket.network")), null);
  // unset: the kit's fee pair, of two operators on every network
  for (const [network, names] of Object.entries(POOL_EVM_ENV)) assert.equal(refusal({ [names[0]]: PIN_OF(network), [names[1]]: EVM[1]! }), null, network);
});

// review L-2 and L-3 (op-edges): the start's operator is the kit's one rule (evmRpcOperator), so no spelling of one
// operator passes as two, no text that is not a URL passes at all, and one URL written twice is one URL
test("L-2/L-3: POOL_EVM_RPCS_* of one operator however written, a CNAME of the other, or Pocket's words twice is refused; a non-URL is refused naming no key; a trailing slash is the same URL", () => {
  const env = (rpcs: string) => ({ POOL_EVM_ADDRESS_ROBINHOOD: PIN_OF("robinhood"), POOL_EVM_SENDER_KEY_ROBINHOOD: EVM[1]!, POOL_EVM_RPCS_ROBINHOOD: rpcs });
  const one: [string, string][] = [
    ["https://rpc.mainnet.chain.robinhood.com.,https://robinhood.com", "robinhood.com"],
    ["https://a.robinhood.com.,https://b.robinhood.com", "robinhood.com"],
    ["https://RPC.Mainnet.Chain.Robinhood.COM,https://x.robinhood.com", "robinhood.com"],
    ["https://user:s3cr3t@a.robinhood.com/v2/KEY?k=1,https://b.robinhood.com", "robinhood.com"],
    ["https://rpc.mainnet.chain.robinhood.com,https://customer-origin.offchainlabs.com", "robinhood.com"],
    ["https://robinhood.api.pocket.network,https://rpc.degenprotocol.io", "pocket.network"],
    // delta review L-2: by domain, never by host
    ["https://customer-origin.offchainlabs.com,https://other-origin.offchainlabs.com", "robinhood.com"],
    ["https://rpc.degenprotocol.io,https://rpc2.degenprotocol.io", "pocket.network"],
    ["https://rpc.foo.co.uk,https://rpc.bar.co.uk", "co.uk"],
    ["http://127.0.0.1:1,http://127.1:2", "127.0.0.1"],
    ["http://2130706433:1,http://127.0.0.1:2", "127.0.0.1"],
    ["http://[::ffff:127.0.0.1]:1,http://127.0.0.1:2", "127.0.0.1"],
    ["http://[::1]:1,http://[0:0:0:0:0:0:0:1]:2", "[::1]"],
    ["http://localhost:1,http://localhost:2", "localhost"],
  ];
  for (const [rpcs, op] of one) {
    const why = refusal(env(rpcs));
    assert.equal(why, `POOL_EVM_RPCS_ROBINHOOD must be two RPC URLs of two operators: both are ${op}`, rpcs);
  }
  for (const rpcs of ["not a url/KEY,also not/KEY2", "robinhood.com,https://x.robinhood.com/KEY", "ws://a.example/s3cr3t,https://b.example"]) {
    const why = refusal(env(rpcs));
    assert.equal(why, "POOL_EVM_RPCS_ROBINHOOD must be two http or https URLs", rpcs);
  }
  assert.equal(refusal(env("https://robinhood.drpc.org/,https://robinhood.drpc.org")), "POOL_EVM_RPCS_ROBINHOOD must be two different RPC URLs");
  assert.equal(refusal(env("https://robinhood.drpc.org/,https://rpc.mainnet.chain.robinhood.com/")), null);
});

// card evm-pool-sync-holds: the device's EVM pool sync keeps old logs only when two operators give them alike, the
// helper's ?keyed=only route counted as operator "helper" (packages/wallet/src/pool/evm.ts evmSourceOperator). A keyed
// Base or Robinhood URL run by an operator of that chain's pool list would be one operator counted twice, so the start
// and the redeploy's check refuse it, naming the variable and the operator, never the URL or its key.
test("evm-pool-sync-holds: a keyed Base or Robinhood URL whose operator runs that chain's pool list is refused, naming the variable and never the URL or its key; another operator's, and none set, pass", async () => {
  const { checkPoolRpcOperators } = (await import("./env-check.ts")) as unknown as { checkPoolRpcOperators: (env: Record<string, string | undefined>) => void };
  assert.equal(typeof checkPoolRpcOperators, "function", "env-check.ts checkPoolRpcOperators");
  const why = (env: Record<string, string | undefined>) => {
    try {
      checkPoolRpcOperators(env);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const KEY = "FAKEKEY123";
  for (const [name, url, op, chain] of [
    ["BASE_RPC_URL", `https://base-rpc.publicnode.com/${KEY}`, "publicnode.com", "base"],
    ["BASE_RPC_URL_QUICKNODE", `https://x.base.api.pocket.network/${KEY}`, "pocket.network", "base"],
    ["ROBINHOOD_RPC_URL_DRPC_1", `https://robinhood.rpc.grove.city/v1/${KEY}`, "pocket.network", "robinhood"],
    ["ROBINHOOD_RPC_URL", `https://user:${KEY}@rpc.mainnet.chain.robinhood.com/?k=${KEY}`, "robinhood.com", "robinhood"],
  ] as const) {
    const m = why({ [name]: url });
    assert.equal(m, `${name}: its operator ${op} runs the device's ${chain} pool list`, url);
    assert.ok(!m!.includes(url) && !m!.includes(KEY), `a URL or key in: ${m}`);
  }
  // review P3-2: the history list's operators (the kit's EVM_POOL_HISTORY) are the device's sources too: a keyed URL of
  // one is that operator counted twice, refused the same way, naming the variable only
  for (const [name, url, op] of [
    ["BASE_RPC_URL", `https://base.rpc.blxrbdn.com/${KEY}`, "blxrbdn.com"],
    ["BASE_RPC_URL_QUICKNODE", `https://base.gateway.tenderly.co/${KEY}`, "tenderly.co"],
  ] as const) {
    const m = why({ [name]: url });
    assert.equal(m, `${name}: its operator ${op} runs the device's base pool history`, url);
    assert.ok(!m!.includes(url) && !m!.includes(KEY), `a URL or key in: ${m}`);
  }
  // Sentio is in neither list (its 429 range cap reads as a throttle to the page's pager): its keyed URL passes
  assert.equal(why({ BASE_RPC_URL_DRPC_1: `https://rpc.sentio.xyz/${KEY}/base` }), null);
  // a keyed URL that is not http(s) has no operator: refused the same way, naming the variable only
  for (const [name, url] of [["BASE_RPC_URL_DRPC_2", `ws://lb.drpc.live/base/${KEY}`], ["ROBINHOOD_RPC_URL_QUICKNODE", `not a url/${KEY}`]] as const) {
    const m = why({ [name]: url });
    assert.equal(m, `${name}: not an http(s) URL, so no operator apart from the device's pool list`, url);
    assert.ok(!m!.includes(KEY), m!);
  }
  // dRPC's keyed URL on Base: drpc.org is not one of Base's pool-list operators (buy-unpinned.ts base poolProviders)
  const basePool = (evmPoolProvidersOf(evmPoolVenues().base) ?? []).map(evmRpcOperator);
  assert.ok(!basePool.includes("drpc.org"), `Base's pool list: ${basePool.join(", ")}`);
  assert.equal(why({ BASE_RPC_URL_DRPC_1: `https://lb.drpc.live/base/${KEY}` }), null);
  // none set, or set empty, passes; another chain's names are not read here
  assert.equal(why({}), null);
  assert.equal(why({ BASE_RPC_URL: "", ROBINHOOD_RPC_URL: "" }), null);
  assert.equal(why({ SOLANA_RPC_URL: `https://base-rpc.publicnode.com/${KEY}` }), null);
});

test("evm-pool-sync-holds: node src/env-check.ts exits 2 on a keyed URL of a pool-list operator, naming the variable and never the URL or its key", () => {
  const url = "https://base-rpc.publicnode.com/FAKEKEY123";
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "env-check.ts")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", BASE_RPC_URL: url } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /helper env: BASE_RPC_URL: its operator publicnode\.com runs the device's base pool list/);
  assert.ok(!(r.stdout + r.stderr).includes("FAKEKEY123"), "the key was printed");
});

// review P3-6 of a34c1626 (card sol-pools-mainnet-pin): the signing page reads every Solana pool mark and page on its
// pair, PublicNode directly (seat 0) and this helper's /v1/rpc/solana (seat 1); a keyed Solana URL of PublicNode's here
// would make the two seats one operator, so a lie of that one operator would pass both.
test("a keyed Solana URL the helper reads /v1/rpc/solana from, run by the page's direct seat's operator (PublicNode), is refused naming the variable, never the URL or its key; another operator's, and none set, pass", async () => {
  const { checkSolanaPairOperators, PAGE_SOLANA_DIRECT } = (await import("./env-check.ts")) as unknown as { checkSolanaPairOperators: (env: Record<string, string | undefined>) => void; PAGE_SOLANA_DIRECT: string };
  assert.equal(typeof checkSolanaPairOperators, "function", "env-check.ts checkSolanaPairOperators");
  const fs = await import("node:fs");
  // the page's own constant (packages/signpage/src/trade.ts SOLANA_PROVIDER_A), read as text: the helper imports no page code
  const page = fs.readFileSync(new URL("../../../packages/signpage/src/trade.ts", import.meta.url), "utf8");
  assert.equal(/export const SOLANA_PROVIDER_A = "([^"]+)";/.exec(page)?.[1], PAGE_SOLANA_DIRECT);
  const KEY = "k3y-test-value-not-a-key";
  const why = (env: Record<string, string | undefined>): string | null => {
    try {
      checkSolanaPairOperators(env);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  for (const name of ["SOLANA_RPC_URL", "SOLANA_RPC_URL_QUICKNODE", "SOLANA_RPC_URL_DRPC_1", "SOLANA_RPC_URL_DRPC_2", "SOLANA_RPC_URL_DRPC_3"]) {
    for (const url of [`https://solana-rpc.publicnode.com/${KEY}`, `https://solana-mainnet.publicnode.com/?token=${KEY}`]) {
      const m = why({ SOLANA_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${KEY}`, [name]: url });
      assert.equal(m, `${name}: its operator publicnode.com is the signing page's direct Solana seat, so the page's pair would read one operator twice`);
      assert.ok(!m!.includes(KEY), m!);
    }
    assert.equal(why({ [name]: `not a url ${KEY}` }), `${name}: not an http(s) URL, so no operator apart from the page's direct Solana seat`);
  }
  assert.equal(why({}), null);
  assert.equal(why({ SOLANA_RPC_URL: `https://mainnet.helius-rpc.com/?api-key=${KEY}`, SOLANA_RPC_URL_QUICKNODE: `https://x.solana-mainnet.quiknode.pro/${KEY}/`, SOLANA_RPC_URL_DRPC_1: `https://lb.drpc.live/solana/${KEY}` }), null);
});
