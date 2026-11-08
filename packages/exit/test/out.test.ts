// Card exit-ids-out: the exit tool's moves out of the one-time ids and arming accounts (src/out.ts), offline, on fake
// RPCs of the release pair. The reads: a halt on both RPCs reads as halted, never a zero, in either error shape; a halt
// on one only, two RPCs that differ, or heights spread too far stop; a busy answer is asked again; testnet has no
// intents.near. The typed account: its form, never the vault, intents.near or the token, and a named one must exist on
// both RPCs. The moves: each signed transaction is decoded from its bytes (nearcore's borsh Transaction V0) and its
// signature checked with the account's own key; no move names the vault; an id keeps one base unit and A moves all.
//   node --test test/out.test.ts      (from packages/exit)
// Test secrets come from the published all-zero BIP-39 vector (packages/wallet/test/vectors/a8.json), never money.
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { type VaultSyncRpc } from "@blindfill/kit";
import { buildMoveOut, buildRegisterOut, buildWithdrawOut, depositId, HEIGHT_SPREAD_MAX, MoveOutRefused, wordsToSeed64, type BuiltMove, type MoveOutReadFor, type WithdrawOutReadFor } from "@blindfill/kit/core";
import { EXIT_NETWORKS, ExitRpcRefused } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { EXIT_INTENTS, exitBuildMove, exitHoldings, exitKey, ExitOutStopped, exitRecipient, type ExitAccount, type ExitMove, type ExitRecipient } from "../src/out.ts";

const SEED = wordsToSeed64("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
const TYPED = "typed-user.testnet";
const TYPED_MAIN = "typed-user.near";
const H = 200_000_000;
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const BLOCK = "11111111111111111111111111111111"; // 32 zero bytes, base58
const PAUSED_A = 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "FiatToken: paused" })';
const BUSY = { jsonrpc: "2.0", id: "x", error: { code: 30, message: "Request timeout on the free plan, please upgrade to paid plan" } };
const noSleep = async () => {};

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
/** bal and mt: the views; accounts: the named accounts that exist; busy: how many busy answers come first; lag: blocks below H. */
type World = { bal: Record<string, View>; mt: Record<string, string>; accounts?: readonly string[]; busy?: number; lag?: number; stale?: boolean };
const view = (v: string, at: number) => ({ jsonrpc: "2.0", id: "x", result: { result: [...new TextEncoder().encode(JSON.stringify(v))], logs: [], block_height: at } });
function fake(name: string, w: World, log: string[]): VaultSyncRpc {
  let busy = w.busy ?? 0;
  return {
    name,
    async query(p: Record<string, unknown>) {
      log.push(`${name} ${String(p.request_type)} ${String(p.method_name ?? p.account_id)}`);
      if (busy > 0) return (busy--, BUSY);
      const at = (p.block_id as number | undefined) ?? H - (w.lag ?? 0) + (name.includes("drpc") ? 1 : 0);
      if (p.request_type === "view_account") {
        const known = Object.values(EXIT_TOKENS).includes(p.account_id as string) || (w.accounts ?? []).includes(p.account_id as string);
        return known
          ? { jsonrpc: "2.0", id: "x", result: { amount: "1", code_hash: "x", storage_usage: 1, block_height: w.stale && p.block_id !== undefined ? at - 1 : at } }
          : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000 } };
      }
      const args = JSON.parse(atob(String(p.args_base64)));
      if (p.method_name === "ft_balance_of") {
        const v = w.bal[args.account_id] ?? { ok: "0" };
        if ("ok" in v) return view(v.ok, at);
        if ("halt" in v)
          return v.halt === "a"
            ? { jsonrpc: "2.0", id: "x", result: { error: PAUSED_A, logs: [], block_height: at } }
            : { jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: { vm_error: "FiatToken: paused" } }, code: -32000 } };
        throw new Error("down");
      }
      if (p.method_name === "mt_balance_of") return view(w.mt[args.account_id] ?? "0", at);
      throw new Error(`unexpected ${String(p.method_name)}`);
    },
  };
}
const pair = (network: "mainnet" | "testnet", a: World, b: World = a, log: string[] = []) =>
  [fake(EXIT_NETWORKS[network].rpcs[0], a, log), fake(EXIT_NETWORKS[network].rpcs[1], b, log)] as const;
const holdings = (network: "mainnet" | "testnet", ids: string[], a: World, b: World = a, log: string[] = []) => exitHoldings({ network, ids, rpcs: pair(network, a, b, log) }, noSleep);

// ---------- the reads ----------
test("a halt on both RPCs reads as halted, never a zero, in either error shape; a true zero reads as a held zero", async () => {
  const [u, r] = [idOf(ACCOUNTS[0]!), idOf(ACCOUNTS[1]!)];
  for (const sa of ["a", "b"] as const) {
    for (const sb of ["a", "b"] as const) {
      const out = await holdings("testnet", [u, r], { bal: { [u]: { halt: sa }, [r]: { ok: "0" } }, mt: {} }, { bal: { [u]: { halt: sb }, [r]: { ok: "0" } }, mt: {} });
      assert.deepEqual(out.holdings[0]!.token, { state: "halted" }, `shapes ${sa} ${sb}`);
      assert.deepEqual(out.holdings[1]!.token, { state: "held", amount: 0n });
    }
  }
});

test("a halt on one RPC only, with an amount or a failure on the other, is a split and stops the read", async () => {
  const u = idOf(ACCOUNTS[0]!);
  for (const other of [{ ok: "2500000" }, { fail: true }] as const) {
    for (const side of [0, 1]) {
      const halted: World = { bal: { [u]: { halt: "a" } }, mt: {} };
      const fine: World = { bal: { [u]: other }, mt: {} };
      await assert.rejects(side === 0 ? holdings("testnet", [u], halted, fine) : holdings("testnet", [u], fine, halted), ExitOutStopped);
    }
  }
});

test("reads are at the lower of the two final heights, one query at a time on each RPC, and a balance read is that amount", async () => {
  const [u, r] = [idOf(ACCOUNTS[0]!), idOf(ACCOUNTS[1]!)];
  const log: string[] = [];
  const w: World = { bal: { [u]: { ok: "2500000" }, [r]: { ok: "7" } }, mt: {} };
  const rpcs = pair("testnet", w, w, log);
  let open = 0, most = 0;
  const paced = rpcs.map((x) => ({ name: x.name, query: async (p: Record<string, unknown>) => { open++; most = Math.max(most, open); await new Promise((ok) => setTimeout(ok, 1)); try { return await x.query(p); } finally { open--; } } })) as unknown as typeof rpcs;
  const out = await exitHoldings({ network: "testnet", ids: [u, r], rpcs: paced }, noSleep);
  assert.equal(out.height, H);
  assert.deepEqual(out.holdings, [{ id: u, token: { state: "held", amount: 2_500_000n }, intents: null }, { id: r, token: { state: "held", amount: 7n }, intents: null }]);
  assert.ok(most <= 2, `at most one query per RPC at once (saw ${most})`);
  assert.ok(!log.some((l) => l.includes("mt_balance_of")), "testnet has no intents.near: no read of it");
});

test("a busy answer (dRPC's free-plan 408) is asked again after the kit's waits; busy past them stops", async () => {
  const u = idOf(ACCOUNTS[0]!);
  const out = await holdings("testnet", [u], { bal: { [u]: { ok: "5" } }, mt: {} }, { bal: { [u]: { ok: "5" } }, mt: {}, busy: 3 });
  assert.deepEqual(out.holdings[0]!.token, { state: "held", amount: 5n });
  await assert.rejects(holdings("testnet", [u], { bal: {}, mt: {} }, { bal: {}, mt: {}, busy: 4 }), ExitOutStopped);
});

test("final heights that spread over the wallet's bound stop the read", async () => {
  const u = idOf(ACCOUNTS[0]!);
  const w: World = { bal: {}, mt: {} };
  await assert.rejects(holdings("testnet", [u], { ...w, lag: HEIGHT_SPREAD_MAX }, w), ExitOutStopped);
  await holdings("testnet", [u], { ...w, lag: HEIGHT_SPREAD_MAX - 1 }, w);
});

test("two RPCs that differ on a balance, or a failed balance read, stop the read", async () => {
  const u = idOf(ACCOUNTS[0]!);
  const a: World = { bal: { [u]: { ok: "2500000" } }, mt: { [u]: "5" } };
  const b: World = { bal: { [u]: { ok: "2500001" } }, mt: { [u]: "5" } };
  await assert.rejects(holdings("testnet", [u], a, b), ExitOutStopped);
  await assert.rejects(holdings("testnet", [u], a, { bal: { [u]: { fail: true } }, mt: {} }), ExitOutStopped);
  const c: World = { bal: { [u]: { ok: "2500000" } }, mt: { [u]: "6" } };
  await assert.rejects(holdings("mainnet", [u], a, c), ExitOutStopped, "intents.near's balance differs");
  const out = await holdings("mainnet", [u], a);
  assert.equal(out.holdings[0]!.intents, 5n);
});

test("refused before any read: an id that is not a 64-hex implicit account, a pair that is not the network's", async () => {
  const log: string[] = [];
  const w: World = { bal: {}, mt: {} };
  await assert.rejects(holdings("testnet", ["alice.testnet"], w, w, log), ExitRpcRefused);
  await assert.rejects(exitHoldings({ network: "testnet", ids: [idOf(ACCOUNTS[0]!)], rpcs: pair("mainnet", w, w, log) }, noSleep), ExitRpcRefused);
  assert.deepEqual(log, []);
});

// ---------- the typed account ----------
const named = (network: "mainnet" | "testnet", accounts: readonly string[]) => pair(network, { bal: {}, mt: {}, accounts });
test("the typed account: a named account that exists on both RPCs passes; one that exists on neither is no-account; a split is unread", async () => {
  const ok = await exitRecipient(` ${TYPED} `, "testnet", named("testnet", [TYPED]), noSleep);
  assert.ok(ok.ok && ok.recipient.account === TYPED && ok.recipient.network === "testnet");
  assert.deepEqual(await exitRecipient("typo-user.testnet", "testnet", named("testnet", [TYPED]), noSleep), { ok: false, code: "no-account" });
  const split = [named("testnet", [TYPED])[0], named("testnet", [])[1]] as const;
  assert.deepEqual(await exitRecipient(TYPED, "testnet", split, noSleep), { ok: false, code: "unread" });
  const stale = pair("testnet", { bal: {}, mt: {}, accounts: [TYPED], stale: true });
  assert.deepEqual(await exitRecipient(TYPED, "testnet", stale, noSleep), { ok: false, code: "unread" }, "an answer at another block is no read");
});

test("the typed account: an implicit one needs no read; a bad form, the vault, intents.near and the token are refused before any read", async () => {
  const log: string[] = [];
  const rpcs = pair("testnet", { bal: {}, mt: {} }, { bal: {}, mt: {} }, log);
  assert.ok((await exitRecipient("c".repeat(64), "testnet", rpcs, noSleep)).ok);
  for (const [typed, code] of [["Typed.testnet", "not-account"], ["a", "not-account"], ["a..b", "not-account"], [7, "not-account"], [EXIT_NETWORKS.testnet.vault, "vault"], ["intents.near", "intents"], [EXIT_TOKENS.testnet, "token"]] as const)
    assert.deepEqual(await exitRecipient(typed, "testnet", rpcs, noSleep), { ok: false, code }, String(typed));
  assert.deepEqual(log, []);
  await assert.rejects(exitRecipient(TYPED, "testnet", pair("mainnet", { bal: {}, mt: {} })), ExitRpcRefused);
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

const R_TEST = await (async () => { const r = await exitRecipient(TYPED, "testnet", named("testnet", [TYPED]), noSleep); assert.ok(r.ok); return r.recipient; })();
const R_MAIN = await (async () => { const r = await exitRecipient(TYPED_MAIN, "mainnet", named("mainnet", [TYPED_MAIN]), noSleep); assert.ok(r.ok); return r.recipient; })();
const typedOf = (n: "mainnet" | "testnet") => (n === "mainnet" ? TYPED_MAIN : TYPED);
const tokenRead = (account: ExitAccount, usdc: bigint, registered = true, network: "mainnet" | "testnet" = "testnet", to = typedOf(network)): MoveOutReadFor =>
  ({ height: H, blockHash: BLOCK, nonce: 41n, free: 10n ** 24n, usdc, registered, gasPrice: 100_000_000n, u: idOf(account), to, token: EXIT_TOKENS[network] });
const intentsRead = (account: ExitAccount, held: bigint, registered = true, network: "mainnet" | "testnet" = "mainnet", to = typedOf(network)): WithdrawOutReadFor =>
  ({ height: H, blockHash: BLOCK, nonce: 41n, free: 10n ** 24n, held, registered, gasPrice: 100_000_000n, u: idOf(account), to, token: EXIT_TOKENS[network] });
const regRead = (account: ExitAccount, registered: boolean, network: "mainnet" | "testnet" = "mainnet", to = typedOf(network)) => ({ nonce: 41n, blockHash: BLOCK, registered, u: idOf(account), to, token: EXIT_TOKENS[network] });

test("on the token: the account's own ft_transfer to the typed account; an id keeps one base unit, A moves all", () => {
  for (const account of ACCOUNTS) {
    for (const registered of [true, false]) {
      const m = exitBuildMove({ seed64: SEED, account, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(account, 2_500_000n, registered), storageMin: STORAGE_MIN } });
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
    const m = exitBuildMove({ seed64: SEED, account, network: "mainnet", to: R_MAIN, move: { leg: "intents", read: intentsRead(account, 3_000_000n) } });
    const tx = decode(m);
    const want = account.kind === "A" ? 3_000_000n : 2_999_999n;
    assert.equal(tx.receiver, "intents.near");
    assert.deepEqual(tx.actions.map((a) => [a.method, a.args, a.deposit]), [["ft_withdraw", { token: EXIT_TOKENS.mainnet, receiver_id: TYPED_MAIN, amount: want.toString() }, 1n]]);
    assert.throws(() => exitBuildMove({ seed64: SEED, account, network: "mainnet", to: R_MAIN, move: { leg: "intents", read: intentsRead(account, 3_000_000n, false) } }), MoveOutRefused);
  }
  assert.equal(EXIT_INTENTS.testnet, null);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "testnet", to: R_TEST, move: { leg: "intents", read: intentsRead(ACCOUNTS[2]!, 3_000_000n, true, "testnet") } }), ExitRpcRefused);
});

test("the registration alone: one storage_deposit of the typed account by the account itself; refused when it is registered", () => {
  const m = exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "mainnet", to: R_MAIN, move: { leg: "register", read: regRead(ACCOUNTS[2]!, false), storageMin: STORAGE_MIN } });
  const tx = decode(m);
  assert.equal(tx.receiver, EXIT_TOKENS.mainnet);
  assert.deepEqual(tx.actions.map((a) => [a.method, a.args, a.deposit]), [["storage_deposit", { account_id: TYPED_MAIN, registration_only: true }, STORAGE_MIN]]);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[2]!, network: "mainnet", to: R_MAIN, move: { leg: "register", read: regRead(ACCOUNTS[2]!, true), storageMin: STORAGE_MIN } }), MoveOutRefused);
});

test("exitBuildMove takes only a typed account exitRecipient checked for that network: a copy, a forged one or another network's is refused", () => {
  const move: ExitMove = { leg: "token", read: tokenRead(ACCOUNTS[0]!, 5n), storageMin: STORAGE_MIN };
  for (const to of [{ ...R_TEST }, Object.freeze({ account: TYPED, network: "testnet" }), R_MAIN, { account: EXIT_NETWORKS.testnet.vault, network: "testnet" }] as ExitRecipient[])
    assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to, move }), ExitRpcRefused);
});

test("nothing into the vault: each builder on each network refuses its vault, intents.near, its token and the account itself as the typed account", () => {
  for (const network of ["mainnet", "testnet"] as const) {
    const token = EXIT_TOKENS[network];
    for (const account of ACCOUNTS) {
      const kind = account.kind === "A" ? ("arm" as const) : ("id" as const);
      for (const to of [EXIT_NETWORKS[network].vault, "intents.near", token, idOf(account)]) {
        const key = () => exitKey(SEED, account);
        assert.throws(() => buildMoveOut({ read: tokenRead(account, 2_500_000n, true, network, to), key: key(), kind, to, token, storageMin: STORAGE_MIN }), MoveOutRefused, `${network} ${account.kind} token to ${to}`);
        assert.throws(() => buildMoveOut({ read: tokenRead(account, 2_500_000n, false, network, to), key: key(), kind, to, token, storageMin: STORAGE_MIN }), MoveOutRefused);
        assert.throws(() => buildRegisterOut({ read: regRead(account, false, network, to), key: key(), to, token, storageMin: STORAGE_MIN }), MoveOutRefused);
        assert.throws(() => buildWithdrawOut({ read: intentsRead(account, 3_000_000n, true, network, to), key: key(), kind, to, token }), MoveOutRefused);
      }
    }
  }
});

test("no signed move names the vault, as receiver or anywhere in its arguments", () => {
  const vaults = [EXIT_NETWORKS.mainnet.vault, EXIT_NETWORKS.testnet.vault];
  const built: BuiltMove[] = [];
  for (const account of ACCOUNTS) {
    built.push(exitBuildMove({ seed64: SEED, account, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(account, 2_500_000n, false), storageMin: STORAGE_MIN } }));
    built.push(exitBuildMove({ seed64: SEED, account, network: "mainnet", to: R_MAIN, move: { leg: "intents", read: intentsRead(account, 2n) } }));
    built.push(exitBuildMove({ seed64: SEED, account, network: "mainnet", to: R_MAIN, move: { leg: "register", read: regRead(account, false), storageMin: STORAGE_MIN } }));
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

test("a read of another account, typed account or token is refused before signing", () => {
  const u = ACCOUNTS[0]!;
  for (const read of [tokenRead(u, 5n, true, "testnet", "bob.testnet"), { ...tokenRead(u, 5n), u: idOf(ACCOUNTS[1]!) }, { ...tokenRead(u, 5n), token: EXIT_TOKENS.mainnet }])
    assert.throws(() => exitBuildMove({ seed64: SEED, account: u, network: "testnet", to: R_TEST, move: { leg: "token", read, storageMin: STORAGE_MIN } }), MoveOutRefused);
});

test("nothing to move: an id holding one base unit or less, A holding none, is refused before signing", () => {
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[0]!, 1n), storageMin: STORAGE_MIN } }), MoveOutRefused);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[3]!, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[3]!, 0n), storageMin: STORAGE_MIN } }), MoveOutRefused);
  const a = exitBuildMove({ seed64: SEED, account: ACCOUNTS[3]!, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[3]!, 1n), storageMin: STORAGE_MIN } });
  assert.equal(a.amount, 1n, "A's last base unit moves too");
});

test("the builder signs only with the moving account's own key: another id's key, or a key pair that does not match, is refused", () => {
  const u = depositId(SEED, 1n, 0);
  const other = depositId(SEED, 1n, 1);
  const read = tokenRead(ACCOUNTS[0]!, 2_500_000n);
  const args = { read, kind: "id" as const, to: TYPED, token: EXIT_TOKENS.testnet, storageMin: STORAGE_MIN };
  assert.throws(() => buildMoveOut({ ...args, key: { ...u, publicKey: other.publicKey } }), MoveOutRefused);
  assert.throws(() => buildMoveOut({ ...args, key: { ...u, secretKey: other.secretKey } }), MoveOutRefused);
  assert.throws(() => buildMoveOut({ ...args, key: { ...u, id: other.id } }), MoveOutRefused);
  assert.equal(decode(buildMoveOut({ ...args, key: u })).signer, u.id);
});

test("the account's key is zeroed once the move is built, and when the builder refuses", () => {
  const keys: Uint8Array[] = [];
  const spy: typeof exitKey = (seed, acct) => {
    const k = exitKey(seed, acct);
    keys.push(k.secretKey);
    return k;
  };
  exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[0]!, 5n), storageMin: STORAGE_MIN } }, spy);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[0]!, 1n), storageMin: STORAGE_MIN } }, spy), MoveOutRefused);
  assert.equal(keys.length, 2);
  for (const k of keys) assert.ok(k.every((b) => b === 0), "zeroed");
});

test("an unknown account kind or network is refused", () => {
  assert.throws(() => exitBuildMove({ seed64: SEED, account: { kind: "W", l: 1n, j: 0 } as unknown as ExitAccount, network: "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[0]!, 5n), storageMin: STORAGE_MIN } }), ExitRpcRefused);
  assert.throws(() => exitBuildMove({ seed64: SEED, account: ACCOUNTS[0]!, network: "betanet" as "testnet", to: R_TEST, move: { leg: "token", read: tokenRead(ACCOUNTS[0]!, 5n), storageMin: STORAGE_MIN } }), ExitRpcRefused);
});
