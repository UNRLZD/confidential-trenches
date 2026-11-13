// The pure parts of the mainnet copy run (./sol-mainnet-copy.mjs): what it clones, how a cloned account is
// written for solana-test-validator, which coins it runs, and the record it keeps of each transaction. No I/O here, so
// parse.test.mjs holds each one on recorded answers.

/** A lookup table's header (solana-program address_lookup_table state.rs LookupTableMeta, bincode after a u32
 *  ProgramState tag): deactivation_slot u64 at 4, last_extended_slot u64 at 12, last_extended_slot_start_index u8 at 20,
 *  authority Option<Pubkey> at 21, then the addresses from 56. */
export const ALT_META_SIZE = 56;
const ALT_LAST_EXTENDED_SLOT = 12;
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";

/**
 * A mainnet account as solana-test-validator's --account-dir loads it (the JSON `solana account --output json` writes).
 * A lookup table's last_extended_slot is set to 0: a local validator starts near slot 0, and a table whose
 * last_extended_slot is past the current slot serves only the addresses before its last extension
 * (LookupTableMeta::get_active_addresses_len), so the copy would refuse a mainnet table's newest addresses. Nothing
 * else is changed.
 */
export function copyAccountFile(pubkey, a) {
  if (!a || typeof a.owner !== "string" || !Array.isArray(a.data) || a.data[1] !== "base64") throw new Error(`${pubkey}: not a base64 account answer`);
  let data = Buffer.from(a.data[0], "base64");
  let reset = false;
  if (a.owner === ALT_PROGRAM && data.length >= ALT_META_SIZE && data.readUInt32LE(0) === 1) {
    data = Buffer.from(data);
    if (data.readBigUInt64LE(ALT_LAST_EXTENDED_SLOT) !== 0n) reset = true;
    data.writeBigUInt64LE(0n, ALT_LAST_EXTENDED_SLOT);
  }
  return {
    file: { pubkey, account: { lamports: a.lamports, data: [data.toString("base64"), "base64"], owner: a.owner, executable: a.executable === true, rentEpoch: 0, space: data.length } },
    reset,
  };
}

/** The features that set mainnet's lamports per byte, oldest first (solana feature status -um, 11 Nov 18:37Z:
 *  SIMD-0437-1 "Set lamports per byte to 6333" active since epoch 1028, SIMD-0437-2 "to 5080" since 1033). */
export const RENT_FEATURES = Object.freeze(["4a6f7o7iTcA8hRDCrPLkSatnt5Ykxiu36wo5p1Tt12wC", "61BtM7BkDEE8Yq5fskEVAQT9mYA8qCejJWoLe5apqg81"]);
export const FEATURE_PROGRAM = "Feature111111111111111111111111111111111111";
/** A feature account not yet active (bincode Option<u64> activated_at: None, in its 9 bytes): the bank activates it at
 *  the next epoch boundary and runs its change then. */
export const pendingFeature = (pubkey) => ({ pubkey, account: { lamports: 1_000_000, data: [Buffer.alloc(9).toString("base64"), "base64"], owner: FEATURE_PROGRAM, executable: false, rentEpoch: 0, space: 9 } });

/** The upgradeable loader's id: an executable account it owns is cloned with --clone-upgradeable-program. */
export const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

/**
 * The clone plan from one getMultipleAccounts read of `keys` (answers in the same order): programs of the upgradeable
 * loader (the validator clones each with its programdata), other accounts as files, and the keys mainnet holds no
 * account at (nothing to clone; the program creates them or they stay empty).
 */
export function clonePlan(keys, answers, builtins = []) {
  if (!Array.isArray(answers) || answers.length !== keys.length) throw new Error("the read does not answer every key");
  const programs = [];
  const files = [];
  const missing = [];
  const skipped = [];
  const resets = [];
  keys.forEach((k, i) => {
    const a = answers[i];
    if (a === null) return missing.push(k);
    if (a.executable && a.owner === UPGRADEABLE_LOADER) return programs.push(k);
    if (a.executable || builtins.includes(k)) return skipped.push(k);
    const { file, reset } = copyAccountFile(k, a);
    if (reset) resets.push(k);
    files.push(file);
  });
  return { programs, files, missing, skipped, resets };
}

const PUMP_SUFFIX = /pump$/;
/**
 * Candidate pump.fun coins from the helper's GET /v1/market/lists?chain=solana answer: every pump.fun-launched token
 * of its lists, each once, in list order (new and graduating first: they are still on the curve most often).
 */
export function listCandidates(answer) {
  const lists = answer?.lists;
  if (typeof lists !== "object" || lists === null) throw new Error("not a lists answer");
  const order = ["new", "graduating", ...Object.keys(lists).filter((k) => k !== "new" && k !== "graduating")];
  const seen = new Set();
  const out = [];
  for (const name of order) {
    for (const t of Array.isArray(lists[name]) ? lists[name] : []) {
      if (typeof t?.token !== "string" || seen.has(t.token)) continue;
      if (t.launchpad !== "pump.fun" && !PUMP_SUFFIX.test(t.token)) continue;
      seen.add(t.token);
      out.push({ mint: t.token, list: name, symbol: String(t.symbol ?? "") });
    }
  }
  return out;
}

/** The compute unit limit a message sets (ComputeBudget SetComputeUnitLimit, tag 2, u32), or null. Instruction data
 *  is base58 in getTransaction's json encoding; `decode` turns it into bytes. */
export const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
export function cuLimitOf(accountKeys, instructions, decode) {
  for (const ix of instructions ?? []) {
    if (accountKeys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
    const d = Buffer.from(decode(ix.data));
    if (d[0] === 2 && d.length >= 5) return d.readUInt32LE(1);
  }
  return null;
}
/** A transaction's compute unit price, micro-lamports (its SetComputeUnitPrice, tag 3), or null with none. */
export function cuPriceOf(accountKeys, instructions, decode) {
  for (const ix of instructions ?? []) {
    if (accountKeys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
    const d = Buffer.from(decode(ix.data));
    if (d[0] === 3 && d.length >= 9) return d.readBigUInt64LE(1);
  }
  return null;
}

/** A transaction's price and the priority it pays (the limit times the price, rounded up), as decimal strings. */
const priorityOf = (limit, price) => (price === null ? {} : { cuPrice: String(price), ...(limit === null ? {} : { priority: String((BigInt(limit) * price + 999_999n) / 1_000_000n) }) });

/**
 * One transaction's record from its getTransaction answer (json encoding: the message's account keys, loaded
 * addresses appended), for `coin` and `step`: the signature, whether it succeeded, its
 * error, the compute units used against the limit it set, its fee, the last log lines on a failure, and the lamport
 * change of each key in `watch` ({ name: address }).
 */
export function txRecord(coin, step, signature, tx, watch = {}, decode = (x) => Buffer.from(x, "base64")) {
  if (!tx) return { coin, step, signature, found: false };
  const m = tx.transaction?.message;
  const keys = [...(m?.accountKeys ?? []), ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
  const err = tx.meta?.err ?? null;
  const logs = tx.meta?.logMessages ?? [];
  const lamports = {};
  for (const [name, addr] of Object.entries(watch)) {
    const i = keys.indexOf(addr);
    if (i >= 0) lamports[name] = { before: tx.meta.preBalances[i], after: tx.meta.postBalances[i], change: tx.meta.postBalances[i] - tx.meta.preBalances[i] };
  }
  return {
    coin,
    step,
    signature,
    found: true,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    ok: err === null,
    err,
    cu: tx.meta?.computeUnitsConsumed ?? null,
    cuLimit: cuLimitOf(m?.accountKeys ?? [], m?.instructions, decode),
    ...priorityOf(cuLimitOf(m?.accountKeys ?? [], m?.instructions, decode), cuPriceOf(m?.accountKeys ?? [], m?.instructions, decode)),
    fee: tx.meta?.fee ?? null,
    accounts: keys.length,
    lookups: (m?.addressTableLookups ?? []).map((l) => l.accountKey),
    programs: (m?.instructions ?? []).map((ix) => keys[ix.programIdIndex]),
    ...(err === null ? {} : { logsTail: logs.slice(-12) }),
    ...(Object.keys(lamports).length ? { lamports } : {}),
  };
}

/** The last log lines of a failed simulation answer (simulateTransaction's value), or null when it succeeded. */
export function simFailure(value) {
  if (!value || value.err === null || value.err === undefined) return null;
  return { err: value.err, cu: value.unitsConsumed ?? null, logsTail: (value.logs ?? []).slice(-12) };
}

/** The copy's RPC list is this machine alone: every URL plain http on 127.0.0.1 or localhost. A run file naming any
 *  other host would send the run's transactions to a real cluster, so the copy refuses it before it installs its fetch. */
export function copyRpcsLocal(rpcs) {
  if (!Array.isArray(rpcs) || rpcs.length !== 2) return false;
  return rpcs.every((u) => {
    try {
      const x = new URL(String(u));
      return x.protocol === "http:" && (x.hostname === "127.0.0.1" || x.hostname === "localhost") && x.username === "" && x.password === "";
    } catch {
      return false;
    }
  });
}
