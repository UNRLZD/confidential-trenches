// LiteSVM proof of card pool-senders-next-page: the kit's tag 1, which names each tree's next page, lands when an insert
// that lands first carries its entries onto the next page, on the pool program's pinned bytes; today's six-account form
// fails there. Nothing is sent to any cluster.
//   LITESVM_DIR=<a folder with `npm i --no-package-lock litesvm@1.5.0`> \
//   POOL_SO=<blindfill_pool_solana.so: the pinned code (contracts/pool-solana/scripts/pin.mjs), or the run stops> \
//   node packages/kit/test/svm/pool-next-page.svm.mjs [--record <file>]
// - A fresh program id runs the pinned bytes; tag 0 makes the pool; 1,023 deposits by the kit (solanaPoolDepositTx at the
//   trees' sizes read from the pool account) fill each tree to entry 1,022.
//   Deposits 0 and 511 of them are today's six-account form, away from a page's end: each lands (else the run stops).
// - At sizes 1,023 / 1,023 three deposits are built from the same read: B (the kit's, eight accounts), A6 (the same
//   note as A, the first six accounts only: the form before this card) and A (the kit's). B lands first and takes
//   slot 1,023 of page 0 of each tree; A6 then fails (its entries are index 1,024, page 1, which it does not name); A
//   lands, its entries at slot 0 of page 1 of each tree.
// - B and A each come from a one-time wallet funded with exactly the note and solanaPoolDepositCost at the sizes read
//   (both trees inside SOLANA_POOL_NEXT_PAGE_WINDOW: the next pages' opening), A also A6's fee: B's U ends at the
//   unspent rest (the price less the exact cost; M350 (4)), A's at 0.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readPin } from "../../../../contracts/pool-solana/scripts/pin.mjs";

const need = (k) => process.env[k] ?? (() => { throw new Error(`${k} is required`); })();
const req = createRequire(pathToFileURL(need("LITESVM_DIR") + "/package.json"));
const so = readFileSync(need("POOL_SO"));
const sha = createHash("sha256").update(so).digest("hex");
if (sha !== readPin()) throw new Error(`POOL_SO is ${sha}, not the pinned ${readPin()}`);
const { LiteSVM, FailedTransactionMetadata } = await import(pathToFileURL(req.resolve("litesvm")).href);
const kitSol = await import(pathToFileURL(req.resolve("@solana/kit")).href);
const kit = await import(new URL("../../src/index.ts", import.meta.url).href);
const kreq = createRequire(new URL("../../package.json", import.meta.url));
const { base58 } = await import(pathToFileURL(kreq.resolve("@scure/base")).href);
const { ed25519 } = await import(pathToFileURL(kreq.resolve("@noble/curves/ed25519.js")).href);
const args = process.argv.slice(2);
const record = args.includes("--record") ? args[args.indexOf("--record") + 1] : null;

const keypair = () => {
  const seed = ed25519.utils.randomSecretKey();
  return { seed, address: base58.encode(ed25519.getPublicKey(seed)) };
};
const PROGRAM = keypair().address;
const POOL = kit.solanaPoolAccount(PROGRAM);
const SYSTEM = "11111111111111111111111111111111";
const addr = kitSol.address;
const svm = new LiteSVM();
svm.addProgramFromFile(addr(PROGRAM), process.env.POOL_SO);
const rent = { lamportsPerByte: svm.minimumBalanceForRentExemption(0n) / 128n, factor: 1n };
if (svm.minimumBalanceForRentExemption(88n) !== kit.solanaRentMin(rent, 88)) throw new Error("LiteSVM's rent is not linear per byte");
const depositor = keypair();
svm.airdrop(addr(depositor.address), kitSol.lamports(100_000_000_000n));
const decode = kitSol.getTransactionDecoder();
const signed = (wire, key) => {
  const w = wire.slice();
  w.set(ed25519.sign(w.subarray(65), key.seed), 1);
  return w;
};
const send = (wire) => svm.sendTransaction(decode.decode(wire));
const failed = (r) => r instanceof FailedTransactionMetadata;
const log = (s) => console.log(s);

// tag 0: the pool
{
  const { message } = kit.solanaCompileV0(depositor.address, [{ program: PROGRAM, accounts: [{ key: POOL, signer: false, writable: true }, { key: depositor.address, signer: true, writable: true }, { key: SYSTEM, signer: false, writable: false }], data: Uint8Array.of(0) }], svm.latestBlockhash(), []);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  const r = send(signed(wire, depositor));
  if (failed(r)) throw new Error(`init failed: ${r.err()} ${r.meta().logs().join("\n")}`);
}
const sizes = () => {
  const a = svm.getAccount(addr(POOL));
  return kit.solanaPoolTreeSizes({ owner: a.programAddress, data: Uint8Array.from(a.data) }, PROGRAM);
};
const pre = () => BigInt("0x" + randomBytes(31).toString("hex")) + 1n;
const VALUE = kit.solanaPoolNoteFloor(rent); // the least note the kit builds (audit S-01)
const depositWire = (note, s, six = false, u = depositor) => {
  const ix = kit.solanaPoolDepositIx(PROGRAM, u.address, note, s, rent);
  const ixs = [six ? { ...ix, accounts: ix.accounts.slice(0, 6) } : ix];
  const { message } = kit.solanaCompileV0(u.address, ixs, svm.latestBlockhash(), []);
  const wire = new Uint8Array(1 + 64 + message.length);
  wire[0] = 1;
  wire.set(message, 65);
  return signed(wire, u);
};
const t0 = Date.now();
// deposits 0 and 511 are today's six-account form (no next page named), away from a page's end: the program still takes it
const SIX = [0, 511];
for (let i = 0; i < 1023; i++) {
  const r = send(depositWire({ value: VALUE, precommitment: pre() }, sizes(), SIX.includes(i)));
  if (failed(r)) throw new Error(`deposit ${i}${SIX.includes(i) ? " (six accounts)" : ""} failed: ${r.err()} ${r.meta().logs().join("\n")}`);
  if (i % 256 === 255) svm.expireBlockhash();
}
const at = sizes();
log(`filled: state ${at.stateSize}, label ${at.labelSize} (${Date.now() - t0} ms)`);
if (at.stateSize !== 1023 || at.labelSize !== 1023) throw new Error("not at a page's last slot");

svm.expireBlockhash();
// the price the device reads now, before B lands: each page holds its 1,023 entries' rent, both trees 1 entry from their
// page's end, inside SOLANA_POOL_NEXT_PAGE_WINDOW: priced at the next pages' opening
const FEE = 5_000n;
const price = kit.solanaPoolDepositCost(FEE, rent, at, { mark: 0n, statePage: kit.solanaRentMin(rent, 16 + 72 * 1023), labelPage: kit.solanaRentMin(rent, 16 + 72 * 1023) });
const exact = FEE + kit.solanaRentMin(rent, 17) + 2n * 72n * rent.lamportsPerByte * rent.factor;
const opened = FEE + kit.solanaRentMin(rent, 17) + 2n * kit.solanaRentMin(rent, 16 + 72);
// two one-time wallets, each funded with exactly the note and that price (A also A6's fee: A6 is A's own first try)
const uB = keypair(), uA = keypair();
svm.airdrop(addr(uB.address), kitSol.lamports(VALUE + price));
svm.airdrop(addr(uA.address), kitSol.lamports(VALUE + price + FEE));
const bal = (u) => svm.getBalance(addr(u.address)) ?? 0n;
const noteA = { value: VALUE, precommitment: pre() };
const B = depositWire({ value: VALUE, precommitment: pre() }, at, false, uB);
const A6 = depositWire(noteA, at, true, uA);
const A = depositWire(noteA, at, false, uA);
const rB = send(B);
const exists = (k) => { const a = svm.getAccount(addr(k)); return Boolean(a && a.exists !== false); };
const page1 = [kit.solanaPoolPage(PROGRAM, 0, 1024), kit.solanaPoolPage(PROGRAM, 1, 1024)];
const out = { program: PROGRAM, so_sha256: sha, six_away_from_end_landed: SIX, filled: at, price: String(price), exact: String(exact), opened: String(opened), steps: [] };
out.steps.push({ tx: "B (kit, 8 accounts) at 1023/1023, lands first", landed: !failed(rB), sizes: sizes(), u_left: String(bal(uB)) });
log(`price at 1023/1023: ${price} (exact ${exact}, with both next pages opened ${opened})`);
log(`B: ${failed(rB) ? `FAILED ${rB.err()}` : "landed"} on page 0, sizes ${JSON.stringify(sizes())}; its U ends at ${bal(uB)}, the unspent rest ${price - exact} (M350 (4): it stays for U's next deposit)`);
const rA6 = send(A6);
out.steps.push({ tx: "A6 (6 accounts) at 1023/1023, overtaken", landed: !failed(rA6), err: failed(rA6) ? String(rA6.err()) : null, logs: failed(rA6) ? rA6.meta().logs().slice(-2) : [] });
log(`A6: ${failed(rA6) ? `failed as today (${rA6.err()}): ${rA6.meta().logs().slice(-1).join("")}` : "LANDED (unexpected)"}`);
// A6 failed before any write (the runtime rolls back) and paid its fee; A is the same note, so its mark is still free
const rA = send(A);
out.steps.push({ tx: "A (kit, 8 accounts) at 1023/1023, overtaken", landed: !failed(rA), sizes: sizes(), page1: page1.map(exists), u_left: String(bal(uA)) });
log(`A: ${failed(rA) ? `FAILED ${rA.err()} ${rA.meta().logs().slice(-3).join(" | ")}` : "landed"} on page 1, sizes ${JSON.stringify(sizes())}, page 1 of each tree ${page1.map(exists)}; its U ends at ${bal(uA)}`);
const ok = price === opened && !failed(rB) && bal(uB) === price - exact && failed(rA6) && !failed(rA) && bal(uA) === 0n && sizes().stateSize === 1025 && sizes().labelSize === 1025 && page1.every(exists);
out.ok = ok;
if (record) writeFileSync(record, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v), 1) + "\n");
console.log(ok ? "PASS pool-next-page.svm" : "FAIL pool-next-page.svm");
process.exit(ok ? 0 : 1);
