// The devnet pool's lookup table (card signpage-pool-flow-run): the table every tag 3 of the testnet build loads the pool,
// its pages and the venue's program-wide accounts from (contracts/pool-solana/TAG3.md; src/pool-testnet.ts DEVNET_TABLE).
//   node packages/signpage/scripts/pool-table-devnet.mjs key              make the table's authority T when absent; print its address
//   node packages/signpage/scripts/pool-table-devnet.mjs create <mint>    create the table and fill it; print it, write nothing else
// - T is a devnet key made here, kept only in this Mac's login Keychain (the devwallet tool's way: `security -i` reads the
//   command from stdin, so the key never shows in a process list) and read only into this process. It stays the table's
//   authority, so a page that opens (once every 1,024 entries) or a venue account can be added later; it holds no money
//   beyond what one run needs, which someone else sends it.
// - The list is the kit's own (solanaPoolBuyTableAccounts): the pool, the pages of both trees up to entry 2,047, the
//   token programs, wSOL, and the pump curve venue's program-wide accounts read for <mint> on both devnet RPCs.
// - The table derives from a slot the creating RPC itself holds: its SlotHashes sysvar's entry SLOT_BACK back from the
//   newest, read at confirmed on the RPC that simulates and sends (a load-balanced RPC's getSlot can come from a node
//   ahead of the one that simulates, which refuses "is not a recent slot"); on that refusal it reads again and retries,
//   up to 3 tries.
// - One transaction creates and extends it; it is read back at finalized on both RPCs, byte for byte, and must hold
//   exactly that list with T its authority, else exit 1.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { base58, base64 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { solanaJsonRpc } from "../../kit/src/trade/solana/send.ts";
import { readSolanaRent, solanaRentMin, readSolanaPoolBuyVenue, solanaPoolBuyTableAccounts, solanaPoolPages } from "../../kit/src/trade/solana/pool-buy.ts";
import { solanaCompileV0 } from "../../kit/src/trade/solana/build.ts";
import { solanaDecodeLookupTable, SOLANA_ALT_PROGRAM } from "../../kit/src/checks/solana/message.ts";
import { solanaPda, solanaPoolOf } from "../../wallet/src/pool/solana.ts";

const SERVICE = "confidential-trenches-solana-devnet-table";
const ACCOUNT = "T";
const PROGRAM = "9Z6Yi2VcXkFWgAV6Nb6kMei78vAAVUEMTqzvFiUZcvG8"; // SOL_POOLS.devnet (../../wallet/src/pool/solana.ts)
const RPCS = ["https://api.devnet.solana.com", "https://solana-devnet.api.onfinality.io/public"];
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SYSTEM = "11111111111111111111111111111111";
const FEE = 5_000n;
const log = (s) => console.log(`${new Date().toISOString()} ${s}`);
const die = (s) => (console.error(`pool-table-devnet: ${s}`), process.exit(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// public devnet RPCs answer HTTP 429 under load: wait and ask again, up to 8 times per call
const patient = (rpc) => async (method, params) => {
  for (let i = 0; ; i++) {
    try {
      return await rpc(method, params);
    } catch (e) {
      if (i >= 7 || !/HTTP 429|429|fetch failed/.test(String(e?.message))) throw e;
      await sleep(1_000 * 2 ** Math.min(i, 4));
    }
  }
};
const rpcs = [patient(solanaJsonRpc(RPCS[0])), patient(solanaJsonRpc(RPCS[1]))];

function readT() {
  let hex;
  try {
    hex = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) die(`the Keychain item ${SERVICE} is not a 32-byte seed`);
  const secret = Uint8Array.from(Buffer.from(hex, "hex"));
  return { secret, address: base58.encode(ed25519.getPublicKey(secret)) };
}

export const SLOT_HASHES = "SysvarS1otHashes111111111111111111111111111";
/** How far back from the SlotHashes sysvar's newest entry the table's slot is taken (about 13 s at 400 ms a slot; the
 *  sysvar keeps 512). */
export const SLOT_BACK = 32;
export const CREATE_TRIES = 3;

/** A recent slot as `rpc` holds it: entry SLOT_BACK (or its oldest, when it holds fewer) of its SlotHashes sysvar at
 *  confirmed. The sysvar is a u64 count, then (u64 slot, 32-byte hash) entries, newest first. */
export async function recentSlot(rpc) {
  const v = (await rpc("getAccountInfo", [SLOT_HASHES, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 8 + 40 * (SLOT_BACK + 1) } }])).value;
  if (!v || v.owner !== "Sysvar1111111111111111111111111111111111111") throw new Error(`no SlotHashes sysvar: ${JSON.stringify(v?.owner ?? null)}`);
  const d = base64.decode(v.data[0]);
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  const count = d.length >= 8 ? Number(dv.getBigUint64(0, true)) : 0;
  const held = Math.min(count, Math.floor((d.length - 8) / 40));
  if (held < 1) throw new Error("the SlotHashes sysvar holds no slot");
  return dv.getBigUint64(8 + 40 * Math.min(SLOT_BACK, held - 1), true);
}

/** The table's create and extend, signed: built by `build(slot, blockhash)` from a slot recentSlot reads on `rpc`, and
 *  simulated there; a simulation refused with "is not a recent slot" is built again from a new read, CREATE_TRIES tries
 *  in all. Any other refusal, or the last try's, throws. */
export async function simulatedCreate(rpc, build, tries = CREATE_TRIES) {
  for (let i = 1; ; i++) {
    const slot = await recentSlot(rpc);
    const bh = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
    const made = build(slot, bh);
    const sim = (await rpc("simulateTransaction", [base64.encode(made.tx), { encoding: "base64", commitment: "confirmed", sigVerify: false }])).value;
    if (sim.err === null) return { ...made, slot, tries: i };
    const stale = (sim.logs ?? []).some((l) => /is not a recent slot/.test(l));
    if (!stale || i >= tries) throw new Error(`the simulation failed (try ${i} of ${tries}, slot ${slot}): ${JSON.stringify(sim.err)}; ${JSON.stringify(sim.logs)}`);
    log(`slot ${slot} is not recent on the simulating node: reading again (try ${i + 1} of ${tries})`);
  }
}

const cmd = import.meta.main ? process.argv[2] : null;
if (cmd === "key") {
  if (readT() === null) {
    const hex = randomBytes(32).toString("hex");
    execFileSync("security", ["-i"], { input: `add-generic-password -s ${SERVICE} -a ${ACCOUNT} -l "Confidential Trenches devnet lookup table authority T" -w ${hex}\n`, stdio: ["pipe", "ignore", "ignore"] });
  }
  const t = readT() ?? die("the Keychain read-back found no key");
  t.secret.fill(0);
  console.log(t.address);
  process.exit(0);
}
if (import.meta.main) {
if (cmd !== "create" || !process.argv[3]) die("usage: pool-table-devnet.mjs key | create <mint>");
const mint = process.argv[3];

const genesis = await Promise.all(rpcs.map((r) => r("getGenesisHash", [])));
genesis.forEach((g, i) => g === DEVNET_GENESIS || die(`${RPCS[i]} answers genesis ${g}, not devnet's`));
const T = readT() ?? die(`no Keychain item ${SERVICE} (run: pool-table-devnet.mjs key)`);
const { pool } = solanaPoolOf(PROGRAM);
const venue = await readSolanaPoolBuyVenue(rpcs, "pump-curve", mint);
const list = [...new Set(solanaPoolBuyTableAccounts({ program: PROGRAM, pool }, venue, solanaPoolPages(PROGRAM, 1024, 1024)))];
const rent = await readSolanaRent(rpcs);
const NEED = solanaRentMin(rent, 56 + 32 * list.length) + FEE;
const balance = async () => {
  const got = await Promise.all(rpcs.map(async (r) => BigInt((await r("getBalance", [T.address, { commitment: "confirmed" }])).value)));
  return got[0] < got[1] ? got[0] : got[1];
};
log(`${list.length} addresses; fund T ${T.address} with at least ${NEED} lamports on devnet`);
for (let b = await balance(); b < NEED; b = await balance()) {
  if (b > 0n) log(`T holds ${b}: waiting for ${NEED}`);
  await sleep(10_000);
}

// the ALT program's CreateLookupTable (0) and ExtendLookupTable (2), bincode: u32 tag, then (u64 slot, u8 bump) or Vec<Pubkey>
const build = (slot, bh) => {
  const slotLe = new Uint8Array(8);
  new DataView(slotLe.buffer).setBigUint64(0, slot, true);
  const pda = solanaPda([base58.decode(T.address), slotLe], base58.decode(SOLANA_ALT_PROGRAM));
  const table = base58.encode(pda.address);
  const keys = [
    { key: table, signer: false, writable: true },
    { key: T.address, signer: true, writable: false },
    { key: T.address, signer: true, writable: true },
    { key: SYSTEM, signer: false, writable: false },
  ];
  const create = new Uint8Array(13);
  new DataView(create.buffer).setUint32(0, 0, true);
  create.set(slotLe, 4);
  create[12] = pda.bump;
  const extend = new Uint8Array(12 + 32 * list.length);
  const dv = new DataView(extend.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, BigInt(list.length), true);
  list.forEach((a, i) => extend.set(base58.decode(a), 12 + 32 * i));
  const { message } = solanaCompileV0(T.address, [{ program: SOLANA_ALT_PROGRAM, accounts: keys, data: create }, { program: SOLANA_ALT_PROGRAM, accounts: keys, data: extend }], bh, []);
  const sig = ed25519.sign(message, T.secret);
  const tx = new Uint8Array(65 + message.length);
  tx[0] = 1;
  tx.set(sig, 1);
  tx.set(message, 65);
  return { tx, table, signature: base58.encode(sig) };
};
let made;
try {
  made = await simulatedCreate(rpcs[0], build);
} catch (e) {
  die(e.message);
} finally {
  T.secret.fill(0);
}
const { tx, table, signature } = made;
log(`table ${table} from slot ${made.slot} (try ${made.tries}); tx ${signature} (${tx.length} bytes)`);
await rpcs[0]("sendTransaction", [base64.encode(tx), { encoding: "base64", preflightCommitment: "confirmed" }]);

// read back: the tx succeeded at finalized on both RPCs, and the table's bytes are the same on both, with exactly the list
for (let i = 0; ; i++) {
  const st = await Promise.all(rpcs.map((r) => r("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])));
  const s = st.map((x) => x.value[0]);
  if (s.every((x) => x?.confirmationStatus === "finalized")) {
    if (s.some((x) => x.err !== null)) die(`the tx failed: ${JSON.stringify(s.map((x) => x.err))}`);
    break;
  }
  if (i > 60) die("the tx is not finalized on both RPCs after 5 min");
  await sleep(5_000);
}
const reads = await Promise.all(rpcs.map((r) => r("getAccountInfo", [table, { encoding: "base64", commitment: "finalized" }])));
const datas = reads.map((r) => r.value && r.value.owner === SOLANA_ALT_PROGRAM ? r.value.data[0] : null);
if (datas[0] === null || datas[0] !== datas[1]) die("the table is not the ALT program's, or not the same bytes on both RPCs");
const bytes = base64.decode(datas[0]);
const got = solanaDecodeLookupTable(bytes);
if (base58.encode(bytes.subarray(22, 54)) !== T.address || bytes[21] !== 1) die("the table's authority is not T");
if (got.addresses.length !== list.length || got.addresses.some((a, i) => a !== list[i])) die("the table does not hold exactly the list");
log(`ok: table ${table} holds the ${list.length} addresses on both RPCs at finalized, authority T; T left ${await balance()}`);
console.log(JSON.stringify({ table, tx: signature, authority: T.address, mint, addresses: list }, null, 2));
}
