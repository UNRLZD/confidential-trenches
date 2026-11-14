// Card exit-with-only-the-words: the Solana pool's exit (src/sol-out.ts), offline. A fake chain answers the release's
// two mainnet RPCs (by their URLs), a fake pool binds and gives trees, a fake prover gives signals of the input's shape;
// what is checked is what the exit builds, signs, sends and refuses. The words are BIP-39's public test words, which
// hold nothing.
//   node --test packages/exit/test/sol-out.test.ts
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { solanaDecodePoolRelease, solanaDecodeTransaction, VaultTree, type SolanaRpc, type VaultSnarkjsProof } from "@blindfill/kit";
import { solanaContextOf, solanaPoolOf, wordsToSeed64, type SolanaReleaseRequest, type SolanaRestoredNote } from "@blindfill/kit/core";
import type { ExitCtx } from "../src/chain.ts";
import { b58decode, b58encode, solExitWith, solFeeWallet, type SolExitOver } from "../src/sol-out.ts";
import { EXIT_SOL_CLUSTERS } from "../src/sol-rpc.ts";

const WORDS = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NET = EXIT_SOL_CLUSTERS.mainnet;
const PROGRAM = NET.program;
const { pool: POOL, scope: SCOPE } = solanaPoolOf(PROGRAM);
const SYSTEM = "11111111111111111111111111111111";
const TO = b58encode(new Uint8Array(32).fill(9));
const LABEL = 77n;
const VALUE = 50_000_000n; // 0.05 SOL
const NOW = 1_800_000_000_000n;
/** The epoch fee at the fake rent (3,480 a byte, factor 2): the cost 981,360 + 501,120 + 10,000 rounded up to the step, plus two steps (the kit's solanaPoolFee). */
const FEE = 1_700_000n;

/** A chain on two RPCs (the same state, each its own URL): balances, accounts, and every transaction sent. */
function chain(o: { accounts?: Record<string, { owner: string; executable: boolean }> } = {}) {
  const balance = new Map<string, bigint>();
  const landed = new Map<string, Uint8Array>();
  const sent: Uint8Array[] = [];
  let calls = 0;
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
  const rent = new Uint8Array(17);
  new DataView(rent.buffer).setBigUint64(0, 3480n, true);
  new DataView(rent.buffer).setFloat64(8, 2, true);
  const poolData = new Uint8Array(2179);
  poolData.set(new TextEncoder().encode("bfpool01"));
  new DataView(poolData.buffer).setBigUint64(49, 1n, true);
  new DataView(poolData.buffer).setBigUint64(49 + 8 + 1 + 33 * 32, 1n, true);
  const blockhash = b58encode(new Uint8Array(32).fill(7));
  const answer = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls++;
    const p = params as unknown[];
    switch (method) {
      case "getAccountInfo": {
        const a = p[0] as string;
        if (a === "SysvarRent111111111111111111111111111111111") return { value: { owner: "Sysvar1111111111111111111111111111111111111", executable: false, data: [b64(rent), "base64"] } };
        if (a === POOL) return { value: { owner: PROGRAM, executable: false, data: [b64(poolData), "base64"] } };
        const x = o.accounts?.[a];
        return { value: x ? { ...x, data: ["", "base64"] } : null };
      }
      case "getBalance":
        return { value: Number(balance.get(p[0] as string) ?? 0n) };
      case "getLatestBlockhash":
        return { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 1_000 } };
      case "isBlockhashValid":
        return { context: { slot: 10 }, value: true };
      case "getBlockHeight":
        return 900;
      case "getFeeForMessage": {
        const m = Buffer.from(p[0] as string, "base64");
        return { value: 5_000 * m[1]! };
      }
      case "sendTransaction": {
        const wire = new Uint8Array(Buffer.from(p[0] as string, "base64"));
        sent.push(wire);
        const tx = solanaDecodeTransaction(wire);
        const keys = tx.message.staticKeys;
        const sig = b58encode(wire.subarray(1, 65));
        if (tx.signatures === 2) {
          // the release: W is paid the chunk less the relay fee, the fee payer the fee less its costs
          const ix = tx.message.instructions.find((i) => keys[i.programIndex] === PROGRAM)!;
          const r = solanaDecodePoolRelease(ix.data);
          balance.set(keys[1]!, (balance.get(keys[1]!) ?? 0n) + r.withdrawnValue - r.relayFee);
          balance.set(keys[0]!, (balance.get(keys[0]!) ?? 0n) - 10_000n - 1_000_000n + r.relayFee);
        } else {
          const ix = tx.message.instructions[0]!;
          const v = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true);
          const from = keys[ix.accounts[0]!]!, to = keys[ix.accounts[1]!]!;
          balance.set(from, (balance.get(from) ?? 0n) - v - 5_000n);
          balance.set(to, (balance.get(to) ?? 0n) + v);
        }
        landed.set(sig, wire);
        return sig;
      }
      case "getTransaction": {
        const w = landed.get(p[0] as string);
        return w ? { slot: 11, transaction: [b64(w), "base64"], meta: { err: null } } : null;
      }
      default:
        throw new Error(`the fake chain has no ${method}`);
    }
  };
  const rpcs = [Object.assign((m: string, p: readonly unknown[]) => answer(m, p), { url: NET.rpcs[0] }), Object.assign((m: string, p: readonly unknown[]) => answer(m, p), { url: NET.rpcs[1] })] as const satisfies readonly [SolanaRpc, SolanaRpc];
  return { rpcs, balance, sent, calls: () => calls };
}

const note: SolanaRestoredNote = { ref: { kind: "deposit", s: 1n, i: 0 }, scope: SCOPE, precommitment: 1n, leaf: { value: VALUE, label: LABEL, commitment: 5n, leafIndex: 0n }, state: "UNSPENT" };
const proof = { pi_a: ["1", "2", "1"], pi_b: [["3", "4"], ["5", "6"], ["1", "0"]], pi_c: ["7", "8", "1"], protocol: "groth16", curve: "bn128" } as VaultSnarkjsProof;

/** The test's pool, scan and prover around a fake chain. */
function over(c: ReturnType<typeof chain>, sleep: (ms: number) => Promise<void> = async () => {}): SolExitOver {
  return {
    rpcs: c.rpcs,
    sleep,
    scan: async () => ({ notes: [note], spends: [] }),
    pool: (feePayer, program) => ({
      epochMs: 60_000n,
      lifeMs: 240_000n,
      now: async () => NOW,
      trees: async () => {
        const stateTree = new VaultTree([5n]);
        const labelTree = new VaultTree([LABEL]);
        return { stateTree, labelTree, stateRoot: stateTree.root!, labelRoot: labelTree.root! };
      },
      bind: async (a) => {
        const fee = FEE;
        const request: SolanaReleaseRequest = { program, pool: POOL, recipient: a.wallet.address, feePayer, relayFee: fee, relayFeeCap: fee, tipCap: a.tipCap ?? 1n, deadlineMs: a.deadlineMs, salt: "00".repeat(16) };
        return { context: solanaContextOf(request, SCOPE), feeCap: fee, request };
      },
    }),
    prove: async (args) => ({ proof, publicSignals: ["11", "12", args.withdrawn.toString(), args.newestStateRoot.toString(), "1", args.newestLabelRoot.toString(), "1", args.context.toString()] }),
  };
}
const ctxOf = (seed: Uint8Array, lines: string[], to = TO, rpcs: [string, string] = [...NET.rpcs] as [string, string]): ExitCtx => ({ seed, to, rpcs, say: (l) => lines.push(l) });
const ed = (pub: string) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(b58decode(pub, 32)!)]), format: "der", type: "spki" });

test("(a) a fee wallet short of the fees: one line with its address and the lamports short, then the release goes once funded", async () => {
  const seed = wordsToSeed64(WORDS);
  const F = solFeeWallet(seed);
  F.secretKey.fill(0);
  const c = chain();
  const lines: string[] = [];
  let sleeps = 0;
  const r = await solExitWith(over(c, async () => {
    // the user sends 0.01 SOL to F while the exit waits
    if (++sleeps === 2) c.balance.set(F.address, 10_000_000n);
  }))(ctxOf(seed, lines));
  // F: SLIP-10 ed25519 at m/44'/501'/0'/0' of the test words, pinned so the path never drifts
  assert.equal(F.address, "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk");
  const short = lines.filter((l) => l.startsWith("Send "));
  assert.equal(short.length, 1, lines.join("\n"));
  // need: two signatures 10,000 + rent(13) 981,360 + rent(88) 1,503,360 at 3,480 a byte, factor 2; F held 0
  assert.equal(short[0], `Send 0.00249472 SOL to ${F.address} to pay the fees (it holds 0, needs 0.00249472). Waiting...`);
  assert.equal(c.sent.filter((w) => w[0] === 2).length, 1, "the release went once");
  assert.equal(r.chain, "solana");
  assert.equal(r.txs.length, 2);
});

test("(b) the release: fee payer F, W the recipient and a signer; the onward: W to the typed address only", async () => {
  const seed = wordsToSeed64(WORDS);
  const F = solFeeWallet(seed);
  F.secretKey.fill(0);
  // W_{sol,77,0} of the test words (m/44'/501'/527881472'/681728428'), pinned: the exit derives no key of its own, and a
  // drift of the wallet's derivation fails here
  const W = { address: "5KWWcnta5aTAnCLgtPUCpyCu1D3spPzGr7x7thJWSyry" };
  const c = chain();
  c.balance.set(F.address, 1_000_000_000n);
  const lines: string[] = [];
  const r = await solExitWith(over(c))(ctxOf(seed, lines));
  assert.equal(c.sent.length, 2, lines.join("\n"));
  const [rel, on] = c.sent.map((w) => solanaDecodeTransaction(w));
  // the release: two signers, F (the fee payer) then W, both signatures good over the message
  assert.equal(rel!.signatures, 2);
  assert.equal(rel!.message.requiredSignatures, 2);
  assert.deepEqual(rel!.message.staticKeys.slice(0, 2), [F.address, W.address]);
  assert.ok(verify(null, rel!.messageBytes, ed(F.address), c.sent[0]!.subarray(1, 65)), "F signed");
  assert.ok(verify(null, rel!.messageBytes, ed(W.address), c.sent[0]!.subarray(65, 129)), "W signed");
  const ix = rel!.message.instructions.find((i) => rel!.message.staticKeys[i.programIndex] === PROGRAM)!;
  const data = solanaDecodePoolRelease(ix.data);
  assert.equal(data.withdrawnValue, VALUE, "the note leaves whole");
  assert.equal(data.tipCap, 0n);
  assert.equal(rel!.message.staticKeys[ix.accounts[1]!], W.address, "W is the release's recipient");
  assert.equal(rel!.message.staticKeys[ix.accounts[2]!], F.address, "F is the release's fee payer");
  assert.ok(!rel!.message.staticKeys.includes(TO), "the typed address is not in the release");
  // the onward: W alone signs and pays, one System transfer of all W holds less its fee, to the typed address
  assert.equal(on!.signatures, 1);
  assert.equal(on!.message.staticKeys[0], W.address);
  assert.equal(on!.message.instructions.length, 1);
  const t = on!.message.instructions[0]!;
  assert.equal(on!.message.staticKeys[t.programIndex], SYSTEM);
  assert.deepEqual(t.accounts.map((k) => on!.message.staticKeys[k]), [W.address, TO]);
  assert.ok(verify(null, on!.messageBytes, ed(W.address), c.sent[1]!.subarray(1, 65)), "W signed");
  const amount = VALUE - FEE - 5_000n;
  assert.equal(new DataView(t.data.buffer, t.data.byteOffset).getBigUint64(4, true), amount);
  assert.equal(c.balance.get(W.address), 0n, "W ends at 0");
  assert.equal(c.balance.get(TO), amount);
  assert.deepEqual(r, { chain: "solana", txs: [b58encode(c.sent[0]!.subarray(1, 65)), b58encode(c.sent[1]!.subarray(1, 65))], sent: amount.toString(), left: "0" });
});

test("(c) a typed address that is a program, the pool program or not base58 is refused before any send", async () => {
  const seed = wordsToSeed64(WORDS);
  const exe = b58encode(new Uint8Array(32).fill(4));
  for (const [to, why] of [[exe, /is a program/], [PROGRAM, /the pool's own/], [POOL, /the pool's own/], ["not-base58-0OIl", /not a base58 32-byte key/], [b58encode(new Uint8Array(31).fill(1)), /not a base58 32-byte key/]] as const) {
    const c = chain({ accounts: { [exe]: { owner: "BPFLoaderUpgradeab1e11111111111111111111111", executable: true } } });
    c.balance.set(solFeeWallet(seed).address, 1_000_000_000n);
    await assert.rejects(solExitWith(over(c))(ctxOf(seed, [], to)), why, to);
    assert.equal(c.sent.length, 0, `${to}: nothing sent`);
  }
  // an account the pool program owns (a page, a mark)
  const page = b58encode(new Uint8Array(32).fill(5));
  const c = chain({ accounts: { [page]: { owner: PROGRAM, executable: false } } });
  await assert.rejects(solExitWith(over(c))(ctxOf(seed, [], page)), /an account of the pool/);
  assert.equal(c.sent.length, 0);
});

test("(d) a pair of RPCs that is not the release's is refused before any read", async () => {
  const seed = wordsToSeed64(WORDS);
  for (const pair of [["https://api.mainnet-beta.solana.com/", "https://evil.example/"], [NET.rpcs[1], NET.rpcs[0]], ["https://api.devnet.solana.com/", NET.rpcs[1]]] as [string, string][]) {
    const c = chain();
    await assert.rejects(solExitWith(over(c))(ctxOf(seed, [], TO, pair)), /the two Solana RPCs are a release pair/);
    assert.equal(c.calls(), 0, `${pair.join(" ")}: no read`);
  }
});
