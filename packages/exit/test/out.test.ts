// Card exit-ids-out: the exit tool's moves out of the one-time ids and arming accounts (src/out.ts), offline, on fake
// RPCs of the release pair. The reads: a halt reads as halted, never a zero, on either RPC and in either error shape; two
// RPCs that differ stop; testnet has no intents.near. The moves: each signed transaction is decoded from its bytes
// (nearcore's borsh Transaction V0) and its signature checked with the account's own key; no move names the vault, as
// receiver or as an argument, on either network, by any leg; an id keeps one base unit and A moves all.
//   node --test test/out.test.ts      (from packages/exit)
// Test secrets come from the published all-zero BIP-39 vector (packages/wallet/test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { type VaultSyncRpc } from "@blindfill/kit";
import { buildMoveOut, depositId, MoveOutRefused, wordsToSeed64, type BuiltMove, type MoveOutRead, type WithdrawOutRead } from "@blindfill/kit/core";
import { EXIT_NETWORKS, ExitRpcRefused } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { EXIT_INTENTS, exitBuildMove, exitHoldings, exitKey, ExitOutStopped, type ExitAccount, type ExitMove } from "../src/out.ts";

const SEED = wordsToSeed64("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const TYPED = "typed-user.testnet";
const TYPED_MAIN = "typed-user.near";
const H = 200_000_000;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const BLOCK = "11111111111111111111111111111111"; // 32 zero bytes, base58
const PAUSED_A = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })';

const ACCOUNTS: readonly ExitAccount[] = [
  { kind: "U", s: 1n, i: 0 },
  { kind: "R", chain: "sol", l: 7n, j: 0 },
  { kind: "V", l: 7n, j: 1 },
  { kind: "A", l: 7n, j: 2 },
];
const idOf = (a: ExitAccount) => {
  const k = exitKey(SEED, a);
  k.secretKey.fill(0);
  return k.id;
};

// ---------- fake RPCs ----------
type View = { ok: string } | { halt: "a" | "b" } | { fail: true };
type World = { bal: Record<string, View>; mt: Record<string, string> };
const view = (v: string, at: number) => ({ jsonrpc: "2.0", id: "x", result: { result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [], block_height: at } });
function fake(name: string, w: World, log: string[]): VaultSyncRpc {
  return {
    name,
    async query(p: Record<string, unknown>) {
      log.push(`${name} ${String(p.request_type)} ${String(p.method_name ?? p.account_id)}`);
      if (p.request_type === "view_account") return { jsonrpc: "2.0", id: "x", result: { amount: "1", code_hash: "x", storage_usage: 1, block_height: H + (name.includes("drpc") ? 1 : 0) } };
      const args = JSON.parse(atob(String(p.args_base64)));
      if (p.method_name === "ft_balance_of") {
        const v = w.bal[args.account_id] ?? { ok: "0" };
        if ("ok" in v) return view(v.ok, p.block_id as number);
        if ("halt" in v)
          return v.halt === "a"
            ? { jsonrpc: "2.0", id: "x", result: { error: PAUSED_A, logs: [], block_height: p.block_id } }
            : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "FiatToken: paused" } }, code: -32000 } };
        throw new Error("down");
      }
      if (p.method_name === "mt_balance_of") return view(w.mt[args.account_id] ?? "0", p.block_id as number);
      throw new Error(`unexpected ${String(p.method_name)}`);
    },
  };
}
const pair = (network: "mainnet" | "testnet", a: World, b: World = a, log: string[] = []) =>
  [fake(EXIT_NETWORKS[network].rpcs[0], a, log), fake(EXIT_NETWORKS[network].rpcs[1], b, log)] as const;

// ---------- the reads ----------
test("a halt reads as halted, never a zero: on either RPC, in either error shape, while the other reads a balance", async () => {
  const [u, r] = [idOf(ACCOUNTS[0]!), idOf(ACCOUNTS[1]!)];
  for (const shape of ["a", "b"] as const) {
    for (const side of [0, 1]) {
      const halted: World = { bal: { [u]: { halt: shape }, [r]: { ok: "0" } }, mt: {} };
      const fine: World = { bal: { [u]: { ok: "2500000" }, [r]: { ok: "0" } }, mt: {} };
      const out = await exitHoldings({ network: "testnet", ids: [u, r], rpcs: side === 0 ? pair("testnet", halted, fine) : pair("testnet", fine, halted) });
      assert.deepEqual(out.holdings[0]!.token, { state: "halted" }, `shape ${shape}, side ${side}`);
      // a true zero is a held zero, which a halt never becomes
      assert.deepEqual(out.holdings[1]!.token, { state: "held", amount: 0n });
    }
  }
});

test("reads are at the lower of the two final heights, and a balance read is that amount", async () => {
  const u = idOf(ACCOUNTS[0]!);
  const log: string[] = [];
  const w: World = { bal: { [u]: { ok: "2500000" } }, mt: {} };
  const out = await exitHoldings({ network: "testnet", ids: [u], rpcs: pair("testnet", w, w, log) });
  assert.equal(out.height, H);
  assert.deepEqual(out.holdings, [{ id: u, token: { state: "held", amount: 2_500_000n }, intents: null }]);
  assert.ok(!log.some((l) => l.includes("mt_balance_of")), "testnet has no intents.near: no read of it");
});

test("two RPCs that differ on a balance, or a failed balance read, stop the read", async () => {
  const u = idOf(ACCOUNTS[0]!);
  const a: World = { bal: { [u]: { ok: "2500000" } }, mt: { [u]: "5" } };
  const b: World = { bal: { [u]: { ok: "2500001" } }, mt: { [u]: "5" } };
  await assert.rejects(exitHoldings({ network: "testnet", ids: [u], rpcs: pair("testnet", a, b) }), ExitOutStopped);
  await assert.rejects(exitHoldings({ network: "testnet", ids: [u], rpcs: pair("testnet", a, { bal: { [u]: { fail: true } }, mt: {} }) }), ExitOutStopped);
  const c: World = { bal: { [u]: { ok: "2500000" } }, mt: { [u]: "6" } };
  await assert.rejects(exitHoldings({ network: "mainnet", ids: [u], rpcs: pair("mainnet", a, c) }), ExitOutStopped, "intents.near's balance differs");
  const out = await exitHoldings({ network: "mainnet", ids: [u], rpcs: pair("mainnet", a) });
  assert.equal(out.holdings[0]!.intents, 5n);
});

test("refused before any read: an id that is not a 64-hex implicit account, a pair that is not the network's", async () => {
  const log: string[] = [];
  const w: World = { bal: {}, mt: {} };
  await assert.rejects(exitHoldings({ network: "testnet", ids: ["alice.testnet"], rpcs: pair("testnet", w, w, log) }), ExitRpcRefused);
  await assert.rejects(exitHoldings({ network: "testnet", ids: [idOf(ACCOUNTS[0]!)], rpcs: pair("mainnet", w, w, log) }), ExitRpcRefused);
  assert.deepEqual(log, []);
});

// ---------- the moves ----------
type Tx = { signer: string; publicKey: Uint8Array; nonce: bigint; receiver: string; actions: { method: string; args: Record<string, unknown>; gas: bigint; deposit: bigint }[] };
/** nearcore's SignedTransaction (Transaction V0, ed25519), read back from the bytes, its signature checked. */
function decode(m: BuiltMove): Tx {
  const b = Uint8Array.from(atob(m.signed), (c) => c.charCodeAt(0));
  let at = 0;
  const int = (n: number) => {
    let x = 0n;
    for (let k = 0; k < n; k++) x |= BigInt(b[at + k]!) << BigInt(8 * k);
    at += n;
    return x;
  };
  const bytes = () => {
    const n = Number(int(4));
    return b.slice(at, (at += n));
  };
  const str = () => new TextDecoder().decode(bytes());
  const signer = str();
  assert.equal(int(1), 0n, "an ed25519 key");
  const publicKey = b.slice(at, (at += 32));
  const nonce = int(8);
  const receiver = str();
  at += 32; // the block hash
  const actions: Tx["actions"] = [];
  for (let n = Number(int(4)); n > 0; n--) {
    assert.equal(int(1), 2n, "a FunctionCall action, nothing else");
    actions.push({ method: str(), args: JSON.parse(str()), gas: int(8), deposit: int(16) });
  }
  const txBytes = b.slice(0, at);
  assert.equal(int(1), 0n);
  const sig = b.slice(at, (at += 64));
  assert.equal(at, b.length, "nothing after the signature");
  const digest = createHash("sha256").update(txBytes).digest();
  const spki = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), format: "der", type: "spki" });
  assert.ok(verify(null, digest, spki, sig), "signed by the account's own key over sha256 of the tx");
  return { signer, publicKey, nonce, receiver, actions };
}

const tokenRead = (usdc: bigint, registered = true): MoveOutRead => ({ height: H, blockHash: BLOCK, nonce: 41n, free: 10n ** 24n, usdc, registered, gasPrice: 100_000_000n });
const intentsRead = (held: bigint, registered = true): WithdrawOutRead => ({ height: H, blockHash: BLOCK, nonce: 41n, free: 10n ** 24n, held, registered, gasPrice: 100_000_000n });

test("on the token: the account's own ft_transfer to the typed account; an id keeps one base unit, A moves all", () => {
  for (const account of ACCOUNTS) {
    for (const registered of [true, false]) {
      const m = exitBuildMove({ seed64: SEED, account, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(2_500_000n, registered), storageMin: STORAGE_MIN } });
      const tx = decode(m);
      const want = account.kind === "A" ? 2_500_000n : 2_499_999n;
      assert.equal(tx.signer, idOf(account));
      assert.equal(tx.nonce, 42n);
      assert.equal(tx.receiver, EXIT_TOKENS.testnet);
      assert.equal(m.amount, want);
      const send = tx.actions.at(-1)!;
      assert.deepEqual([send.method, send.args, send.deposit], ["ft_transfer", { receiver_id: TYPED, amount: want.toString() }, 1n]);
      if (registered) assert.equal(tx.actions.length, 1);
      else assert.deepEqual([tx.actions[0]!.method, tx.actions[0]!.args, tx.actions[0]!.deposit], ["storage_deposit", { account_id: TYPED, registration_only: true }, STORAGE_MIN]);
    }
  }
});

test("out of intents.near: the account's own ft_withdraw, no memo or msg, one base unit kept by an id; refused on testnet and to an unregistered typed account", () => {
  for (const account of ACCOUNTS) {
    const m = exitBuildMove({ seed64: SEED, account, network: "mainnet", to: TYPED_MAIN, move: { leg: "intents", read: intentsRead(3_000_000n) } });
    const tx = decode(m);
    const want = account.kind === "A" ? 3_000_000n : 2_999_999n;
    assert.equal(tx.receiver, "intents.near");
    assert.deepEqual(tx.actions.map((a) => [a.method, a.args, a.deposit]), [["ft_withdraw", { token: EXIT_TOKENS.mainnet, receiver_id: TYPED_MAIN, amount: want.toString() }, 1n]]);
    assert.throws(() => exitBuildMove({ seed64: SEED, account, network: "mainnet", to: TYPED_MAIN, move: { leg: "intents", read: intentsRead(3_000_000n, false) } }), MoveOutRefused);
  }
  assert.equal(EXIT_INTENTS.testnet, null);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "testnet", to: TYPED, move: { leg: "intents", read: intentsRead(3_000_000n) } }), ExitRpcRefused);
});

test("the registration alone: one storage_deposit of the typed account by the account itself; refused when it is registered", () => {
  const m = exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "mainnet", to: TYPED_MAIN, move: { leg: "register", read: { nonce: 41n, blockHash: BLOCK, registered: false }, storageMin: STORAGE_MIN } });
  const tx = decode(m);
  assert.equal(tx.receiver, EXIT_TOKENS.mainnet);
  assert.deepEqual(tx.actions.map((a) => [a.method, a.args, a.deposit]), [["storage_deposit", { account_id: TYPED_MAIN, registration_only: true }, STORAGE_MIN]]);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "mainnet", to: TYPED_MAIN, move: { leg: "register", read: { nonce: 41n, blockHash: BLOCK, registered: true }, storageMin: STORAGE_MIN } }), MoveOutRefused);
});

test("nothing into the vault: every leg on each network refuses its vault, intents.near, its token and the account itself as the typed account", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    for (const account of ACCOUNTS) {
      const refused = [EXIT_NETWORKS[network].vault, "intents.near", EXIT_TOKENS[network], idOf(account)];
      const legs: ExitMove[] = [
        { leg: "token", read: tokenRead(2_500_000n), storageMin: STORAGE_MIN },
        { leg: "token", read: tokenRead(2_500_000n, false), storageMin: STORAGE_MIN },
        { leg: "register", read: { nonce: 41n, blockHash: BLOCK, registered: false }, storageMin: STORAGE_MIN },
        ...(network === "mainnet" ? [{ leg: "intents", read: intentsRead(3_000_000n) } as const] : []),
      ];
      for (const to of refused) for (const move of legs) assert.throws(() => exitBuildMove({ seed64: SEED, account, network, to, move }), MoveOutRefused, `${network} ${account.kind} ${move.leg} to ${to}`);
    }
  }
});

test("no signed move names the vault, as receiver or anywhere in its arguments", () => {
  const vaults = [EXIT_NETWORKS.mainnet.vault, EXIT_NETWORKS.testnet.vault];
  const built: BuiltMove[] = [];
  for (const account of ACCOUNTS) {
    built.push(exitBuildMove({ seed64: SEED, account, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(2_500_000n, false), storageMin: STORAGE_MIN } }));
    built.push(exitBuildMove({ seed64: SEED, account, network: "mainnet", to: TYPED_MAIN, move: { leg: "intents", read: intentsRead(2n) } }));
    built.push(exitBuildMove({ seed64: SEED, account, network: "mainnet", to: TYPED_MAIN, move: { leg: "register", read: { nonce: 1n, blockHash: BLOCK, registered: false }, storageMin: STORAGE_MIN } }));
  }
  for (const m of built) {
    const tx = decode(m);
    assert.ok(!vaults.includes(tx.receiver));
    for (const a of tx.actions) {
      assert.ok(!["ft_transfer_call", "mt_transfer_call"].includes(a.method), "no call that delivers into a receiver's code");
      for (const v of vaults) assert.ok(!JSON.stringify(a.args).includes(v), `${a.method} names the vault`);
    }
  }
});

test("nothing to move: an id holding one base unit or less, A holding none, is refused before signing", () => {
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(1n), storageMin: STORAGE_MIN } }), MoveOutRefused);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[3]!, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(0n), storageMin: STORAGE_MIN } }), MoveOutRefused);
  const a = exitBuildMove({ seed64: SEED, account: ACCOUNTS[3]!, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(1n), storageMin: STORAGE_MIN } });
  assert.equal(a.amount, 1n, "A's last base unit moves too");
});

test("the builder signs only with the moving account's own key: another id's key, or a key pair that does not match, is refused", () => {
  const u = depositId(SEED, 1n, 0);
  const other = depositId(SEED, 1n, 1);
  const read = tokenRead(2_500_000n);
  assert.throws(() => buildMoveOut({ read, key: { ...u, publicKey: other.publicKey }, kind: "id", to: TYPED, token: EXIT_TOKENS.testnet, storageMin: STORAGE_MIN }), MoveOutRefused);
  assert.throws(() => buildMoveOut({ read, key: { ...u, secretKey: other.secretKey }, kind: "id", to: TYPED, token: EXIT_TOKENS.testnet, storageMin: STORAGE_MIN }), MoveOutRefused);
  assert.throws(() => buildMoveOut({ read, key: { ...u, id: other.id }, kind: "id", to: TYPED, token: EXIT_TOKENS.testnet, storageMin: STORAGE_MIN }), MoveOutRefused);
  assert.equal(decode(buildMoveOut({ read, key: u, kind: "id", to: TYPED, token: EXIT_TOKENS.testnet, storageMin: STORAGE_MIN })).signer, u.id);
});

test("the account's key is zeroed once the move is built, and when the builder refuses", () => {
  const keys: Uint8Array[] = [];
  const spy: typeof exitKey = (seed, acct) => {
    const k = exitKey(seed, acct);
    keys.push(k.secretKey);
    return k;
  };
  exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(5n), storageMin: STORAGE_MIN } }, spy);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: EXIT_NETWORKS.testnet.vault, move: { leg: "token", read: tokenRead(5n), storageMin: STORAGE_MIN } }, spy), MoveOutRefused);
  assert.equal(keys.length, 2);
  for (const k of keys) assert.ok(k.every((b) => b === 0), "zeroed");
});

test("an unknown account kind or network is refused", () => {
  assert.throws(() => exitBuildMove({ seed64: SEED, account: { kind: "W", l: 1n, j: 0 } as unknown as ExitAccount, network: "testnet", to: TYPED, move: { leg: "token", read: tokenRead(5n), storageMin: STORAGE_MIN } }), ExitRpcRefused);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "betanet" as "testnet", to: TYPED, move: { leg: "token", read: tokenRead(5n), storageMin: STORAGE_MIN } }), ExitRpcRefused);
});
