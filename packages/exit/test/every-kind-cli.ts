// Card exit-every-note-kind-on-a-mainnet-copy: the node helper of contracts/vault/tests/exit_every_kind.rs, which seeds
// on a copy of the mainnet vault, in near-sandbox, one note of each kind the exit tool's scan (src/scan.ts, the wallet's
// restoreNotes) takes from the 12 words, then runs the exit command (test/exit-cli.ts) on them. The words are the
// published all-zero vector's (packages/wallet/test/vectors/a8.json): test secrets, never money. Prints one JSON line.
//   node packages/exit/test/every-kind-cli.ts --deposit <scope>
//       {deposit, second_u}: the precommitments of deposit note (scope, 0) and of U_{scope,0}'s second arrival n = 0
//   node packages/exit/test/every-kind-cli.ts --arm <label>
//       {move, return, second_a, chain}: what the arm of withdrawal (label, 0) brings back, each on its own id: V's move
//       note, R's return note on chain tag `chain` (sol; restore walks every tag), and A's second arrival n = 0
//   node packages/exit/test/every-kind-cli.ts --bounce http://127.0.0.1:<port> <recipient>
//       {args, attach, label, value}: the withdraw of deposit note (scope, 0), whole, fee 0, to <recipient> with a
//       register_deposit of 1 yocto, below the token's storage minimum, so the payout bounces and the spend stays
//       refund_pending (as contracts/vault/tests/payouts.rs a_registration_below_the_minimum does): the pending refund,
//       and the spend (label, 0) the arm's notes follow. Its refund precommitment is refund note (label, 0)'s, as the
//       exit tool's own withdraw names it. Proved on the hash-checked setup files (src/prover.ts) against the trees the
//       sandbox's vault holds, read on the RPC pair named as the mainnet release's (test/exit-cli.ts's reads).
import { entropyToWords, noteSecrets, wordsToSeed64 } from "@blindfill/kit/core";
import { VaultTree, vaultProof, vaultProveWithdraw, vaultWithdrawRequest, vaultWithdrawYocto, type VaultSyncRpc } from "@blindfill/kit";
import { exitProver } from "../src/prover.ts";
import { EXIT_NETWORKS, exitReadPages, exitRpc } from "../src/rpc.ts";
import { EXIT_TOKENS, exitScanSeed } from "../src/scan.ts";

const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const out = (v: unknown) => console.log(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === "--deposit") {
  const s = BigInt(a1 ?? "x");
  out({
    deposit: noteSecrets(seed64, { kind: "deposit", s, i: 0 }).precommitment,
    second_u: noteSecrets(seed64, { kind: "second", id: { id: "U", s, i: 0 }, n: 0 }).precommitment,
  });
} else if (cmd === "--arm") {
  const l = BigInt(a1 ?? "x");
  const chain = "sol" as const;
  out({
    move: noteSecrets(seed64, { kind: "move", l, j: 0 }).precommitment,
    return: noteSecrets(seed64, { kind: "return", c: chain, l, j: 0 }).precommitment,
    second_a: noteSecrets(seed64, { kind: "second", id: { id: "A", l, j: 0 }, n: 0 }).precommitment,
    chain,
  });
} else if (cmd === "--bounce") {
  const url = new URL(a1 ?? "");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("every-kind-cli: a loopback http URL (the sandbox), never a real network");
  const recipient = a2 ?? "";
  const toSandbox: typeof fetch = (_input, init) => fetch(url.href, init);
  const rpcs = EXIT_NETWORKS.mainnet.rpcs.map((name) => exitRpc(name, toSandbox)) as unknown as readonly [VaultSyncRpc, VaultSyncRpc];
  const vault = EXIT_NETWORKS.mainnet.vault;
  const scan = await exitScanSeed(seed64, "mainnet", rpcs);
  const note = scan.notes.find((n) => n.ref.kind === "deposit" && n.ref.i === 0 && n.state === "UNSPENT");
  if (note === undefined) throw new Error("every-kind-cli: no unspent deposit note (scope, 0) of the words");
  const pages = await exitReadPages({ network: "mainnet", rpcs });
  const stateTree = new VaultTree([...pages.leaves]);
  const labelTree = new VaultTree([...pages.labels]);
  if (stateTree.root !== pages.stateTree.root || labelTree.root !== pages.labelTree.root) throw new Error("the read trees' roots are not the vault's");
  const block = (await (await fetch(url.href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { finality: "final" } }) })).json()) as {
    result: { header: { timestamp_nanosec: string } };
  };
  const nowMs = Number(BigInt(block.result.header.timestamp_nanosec) / 1_000_000n);
  const l = note.leaf.label;
  const own = noteSecrets(seed64, note.ref);
  const change = noteSecrets(seed64, { kind: "change", l, j: 0 });
  const refund = noteSecrets(seed64, { kind: "refund", l, j: 0 });
  const withdrawn = note.leaf.value;
  const req = vaultWithdrawRequest({
    vaultId: vault,
    token: EXIT_TOKENS.mainnet,
    recipient,
    registerDeposit: 1n,
    feeRecipient: recipient,
    relayFee: 0n,
    refundPrecommitment: refund.precommitment,
    deadlineMs: nowMs + 600_000,
    withdrawn,
    nowMs,
  });
  const proved = await vaultProveWithdraw(await exitProver(), {
    stateTree,
    labelTree,
    newestStateRoot: pages.stateTree.root,
    newestLabelRoot: pages.labelTree.root,
    note: { value: withdrawn, label: l, nullifier: own.nullifier, secret: own.secret },
    newNullifier: change.nullifier,
    newSecret: change.secret,
    withdrawn,
    withdrawal: req.withdrawal,
    vaultId: vault,
    scope: note.scope,
    nowMs,
  });
  out({
    args: { withdrawal: req.withdrawal, proof: vaultProof(proved.proof), public_signals: proved.publicSignals },
    attach: vaultWithdrawYocto(1n, 0n, true),
    label: l,
    value: withdrawn,
  });
} else {
  throw new Error(`every-kind-cli: unknown command ${JSON.stringify(cmd)}`);
}
