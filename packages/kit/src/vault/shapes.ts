// The Blindfill vault's frozen shapes, version blindfill-vault-v1 (the vault paper, section 7.1, frozen Nov 1 06:00Z).
// Every app and package that talks to the vault builds on these: the note, the deposit message and its one carrier,
// the deposit preconditions, the withdrawal request and the bytes its `context` hashes, the callback, settle and
// ragequit, the proof format, the encodings, the events, the setup-file pins and the constants.
// This file has no imports and only erasable TypeScript, so it runs as is in a browser, in Node and in the live check.
// The hash is passed in (any keccak256, such as @noble/hashes' keccak_256): the shapes fix bytes, not a library.

// ---- Fields ----

/** p, BN254's scalar field: every note value, root, signal and encoding is a number below it (PP Constants.sol:5-6). */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** q, BN254's base field: every proof coordinate is below it, or the vault refuses the proof at parse. */
export const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// ---- Constants (the paper's 2.2: compiled into the vault, which has no setter, so none can change) ----

export const CONSTANTS = {
  /** Circle's native USDC on NEAR mainnet. A testnet vault names the testnet token, read before its deploy. */
  TOKEN: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", // gitleaks:allow (a public account id)
  MAX_TREE_DEPTH: 32,
  /** 1 USDC, in the token's base units (6 decimals). */
  MIN_DEPOSIT: 1_000_000n,
  /** Only a backstop: relay_fee × 10,000 ≤ withdrawn × MAX_RELAY_FEE_BPS. The device's own fee bound is the real one. */
  MAX_RELAY_FEE_BPS: 5_000,
  /** Rows per view call. */
  PAGE_MAX: 1_000,
  /** Refused as a recipient or fee recipient: a plain ft_transfer to it credits no one. Compared, never called. */
  INTENTS: "intents.near",
  GAS_FT_TRANSFER_TGAS: 15,
  GAS_STORAGE_DEPOSIT_TGAS: 10,
  GAS_ON_PAYOUT_TGAS: 30,
  /** What a deposit writes when no tree grows a level; the smallest storage_prepay. */
  DEPOSIT_STORAGE_BYTES: 756,
  /** What a refund note writes when no tree grows a level; reserved by every withdrawal and ragequit. */
  REFUND_RESERVE_BYTES: 389,
} as const;

/** near-sdk's storage_byte_cost(), yocto per byte. The vault never relies on it: NEAR refuses unpaid storage. */
export const STORAGE_BYTE_COST = 10_000_000_000_000_000_000n;
/** The code hash of mainnet USDC (Circle's FiatToken, read by view_code on 2026-10-25). A deposit waits if it changes. */
export const TOKEN_CODE_HASH = "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q"; // gitleaks:allow (a public code hash)
/** The tag every scope hashes (2.2). */
export const SCOPE_TAG = "blindfill-vault-v1";

// ---- The note (2.6; its secrets come from the 12 words, as the wallet paper freezes them) ----

/** A note's two secrets, field elements below P. */
export type NoteSecrets = { nullifier: bigint; secret: bigint };
/** A note: value and label come from the vault (the deposit's amount and its label, 2.5.1 rows 8-9). */
export type Note = NoteSecrets & {
  value: bigint;
  label: bigint;
  precommitment: bigint;
  commitment: bigint;
  nullifierHash: bigint;
};
/** Each hash's inputs, in order. Poseidon is circomlib's on BN254 (t = 2, 3, 4). */
export const NOTE_HASHES = {
  precommitment: ["nullifier", "secret"],
  commitment: ["value", "label", "precommitment"],
  nullifierHash: ["nullifier"],
} as const;
// A refund note is a note on the spend's refund_precommitment, with value and label written by settle (2.5.5).

// ---- The deposit message and its one carrier (2.5.1) ----

/** The one deposit message, the same for every path: these two fields, both required, nothing else. */
export const DEPOSIT_MESSAGE_FIELDS = ["precommitment", "depositor"] as const;
export const DEPOSIT_MESSAGE_MAX_BYTES = 1_024;
/** precommitment: one canonical decimal below P. depositor: the NEAR account a ragequit pays (the moving id itself). */
export type DepositMessage = { precommitment: string; depositor: string };

/**
 * The `msg` string, exactly {"precommitment":"<decimal>","depositor":"<account>"}. Refuses what the vault refuses.
 * With a precommitment below p (77 digits at most) and an id of 64 characters at most it is under 200 bytes.
 */
export function depositMessage(precommitment: bigint, depositor: string): string {
  if (typeof precommitment !== "bigint" || precommitment < 0n || precommitment >= P) throw new Error("precommitment: not below p");
  const msg: DepositMessage = { precommitment: precommitment.toString(), depositor: accountId(depositor, "depositor") };
  return JSON.stringify(msg);
}

/**
 * Every move into the vault: the moving NEAR account's own TOKEN.ft_transfer_call(vault, amount, msg), signed on the
 * device by that account's key as a NEP-366 DelegateAction (one FunctionCall action, receiver TOKEN) and sent by the
 * relayer, which pays the gas and cannot change the call. The relayer sends it only once its storage_prepay landed.
 */
export const DEPOSIT_CARRIER = {
  signed_as: "NEP-366 DelegateAction",
  sent_by: "relayer",
  receiver_id: "TOKEN",
  method: "ft_transfer_call",
  /** receiver_id is the vault; msg is depositMessage(P, the moving account). */
  args: ["receiver_id", "amount", "msg"],
  deposit_yocto: 1n,
  gas_tgas: 180,
  signed_by_kit: true,
} as const;

/** Who moves money into the vault, each by DEPOSIT_CARRIER from its own NEAR-implicit account (64 hex). */
export const DEPOSIT_SIGNERS = {
  /** the deposit's one-time id U_{s,i} */
  U: DEPOSIT_CARRIER,
  /** a return id R_{c,l,j}: 1Click delivers to its own NEAR account on the token */
  R: DEPOSIT_CARRIER,
  /** a refund id V_{l,j}, the same way */
  V: DEPOSIT_CARRIER,
} as const;

/**
 * The vault takes the same message from intents.near's ft_withdraw too (any sender may deposit), but the kit never
 * signs one: no id signs an ft_withdraw whose receiver is the vault, since intents.near refunds nothing when that
 * token call fails.
 */
export const VAULT_ALSO_ACCEPTS = [{ sender: "intents.near", method: "ft_withdraw", signed_by_kit: false }] as const;

// ---- Deposit preconditions (2.5.1, 2.8) ----

/** storage_prepay(precommitment), #[payable], by anyone (the relayer), before the deposit. No reclaim. */
export const STORAGE_PREPAY = {
  method: "storage_prepay",
  args: ["precommitment"],
  min_bytes: 756,
  /** what the kit prepays whenever a tree may grow a level */
  bytes_when_a_tree_may_grow: 904,
} as const;

/** Each must hold before a deposit is signed or sent; else it waits. */
export const DEPOSIT_PRECONDITIONS = [
  "storage_prepay(precommitment) has landed with at least min_bytes × STORAGE_BYTE_COST attached",
  "TOKEN.storage_balance_of(vault) is not null (the vault is registered on the token)",
  "TOKEN is not halted, and its code hash equals TOKEN_CODE_HASH",
] as const;

/** The NEAR a storage_prepay attaches. */
export function prepayYocto(aTreeMayGrow: boolean): bigint {
  return BigInt(aTreeMayGrow ? STORAGE_PREPAY.bytes_when_a_tree_may_grow : STORAGE_PREPAY.min_bytes) * STORAGE_BYTE_COST;
}

// ---- The withdrawal request (2.5.2) ----

/**
 * withdraw(withdrawal, proof, public_signals)'s first argument, as JSON. register_deposit and relay_fee: U128
 * decimals (relay_fee in the token's base units); refund_precommitment: a canonical decimal below P, not 0;
 * deadline_ms: the vault's block time in ms; salt: 16 random bytes as exactly 32 lowercase hex characters, fresh
 * from the device for each attempt.
 */
export type Withdrawal = {
  recipient: string;
  register_deposit: string;
  fee_recipient: string;
  relay_fee: string;
  refund_precommitment: string;
  deadline_ms: number;
  salt: string;
};

/** The Borsh bytes `context` hashes, in this order, with no padding, then scope as 32 big-endian bytes. */
export const CONTEXT_FIELDS = [
  ["processor", "account"],
  ["recipient", "account"],
  ["register_deposit", "u128"],
  ["fee_recipient", "account"],
  ["relay_fee", "u128"],
  ["refund_precommitment", "u256be"],
  ["deadline_ms", "u64"],
  ["salt", "bytes16"],
] as const;
// account: a 4-byte little-endian length, then the id's bytes. u128: 16 bytes LE. u256be: 32 raw big-endian bytes
// (a fixed array, no length). u64: 8 bytes LE. bytes16: 16 raw bytes (a fixed array, no length). 100 bytes plus the
// three ids, then 32 bytes of scope.

/** The context's inputs as numbers. processor is the vault's own account id. */
export type ContextInput = {
  processor: string;
  recipient: string;
  register_deposit: bigint;
  fee_recipient: string;
  relay_fee: bigint;
  refund_precommitment: bigint;
  deadline_ms: bigint;
  salt: string;
};

/** A Withdrawal read as context inputs, each field checked as the vault reads it (2.5.2 row 1). */
export function contextInput(processor: string, w: Withdrawal): ContextInput {
  if (!Number.isSafeInteger(w.deadline_ms) || w.deadline_ms < 0) throw new Error("deadline_ms: not a u64 JSON number");
  return {
    processor,
    recipient: w.recipient,
    register_deposit: decimal(w.register_deposit, "register_deposit"),
    fee_recipient: w.fee_recipient,
    relay_fee: decimal(w.relay_fee, "relay_fee"),
    refund_precommitment: decimal(w.refund_precommitment, "refund_precommitment"),
    deadline_ms: BigInt(w.deadline_ms),
    salt: w.salt,
  };
}

/** withdraw's attached NEAR: (710 + 389 (+ 148 when a tree may grow)) × 1e19 + register_deposit + 1 yocto per ft_transfer. */
export const WITHDRAW = {
  method: "withdraw",
  args: ["withdrawal", "proof", "public_signals"],
  storage_bytes: 710,
  tree_growth_bytes: 148,
  gas_tgas: 300,
} as const;

export function withdrawYocto(registerDeposit: bigint, relayFee: bigint, aTreeMayGrow: boolean): bigint {
  const bytes = WITHDRAW.storage_bytes + CONSTANTS.REFUND_RESERVE_BYTES + (aTreeMayGrow ? WITHDRAW.tree_growth_bytes : 0);
  const transfers = relayFee > 0n ? 2n : 1n;
  return BigInt(bytes) * STORAGE_BYTE_COST + registerDeposit + transfers;
}

/** 2.5.2 row 8's backstop: relay_fee × 10,000 ≤ withdrawn × MAX_RELAY_FEE_BPS, exact in bigint. */
export function relayFeeWithinBackstop(relayFee: bigint, withdrawn: bigint): boolean {
  return relayFee * 10_000n <= withdrawn * BigInt(CONSTANTS.MAX_RELAY_FEE_BPS);
}

// ---- The callback, settle and ragequit (2.5.3-2.5.5) ----

/** on_payout(spend_index, to_recipient, fee): #[private], only the vault's own promise calls it. */
export const ON_PAYOUT = {
  method: "on_payout",
  args: ["spend_index", "to_recipient", "fee"],
  private: true,
  /** promise results, in this order; the fee part only when fee > 0 */
  results: ["recipient part", "fee part"],
} as const;
export type OnPayoutArgs = { spend_index: number; to_recipient: string; fee: string };

/** settle(nullifier_hash), #[payable], by anyone once the payout's callback has run. */
export const SETTLE = { method: "settle", args: ["nullifier_hash"], caller: "anyone" } as const;
export type SettleArgs = { nullifier_hash: string };
/** A spend's status, as the spends view pages it. settle takes refund_pending or paid. */
export type SpendStatus = "in_flight" | "paid" | "refund_pending" | "settled";

/** ragequit(proof, public_signals, register_deposit, refund_precommitment), #[payable], from the depositor account. */
export const RAGEQUIT = {
  method: "ragequit",
  args: ["proof", "public_signals", "register_deposit", "refund_precommitment"],
  caller: "the deposit's depositor",
  /** spent 81 + spends 394 (2.3); with the refund reserve, as withdraw's storage rule */
  storage_bytes: 475,
} as const;
export type RagequitArgs = {
  proof: VaultProof;
  public_signals: RagequitSignals;
  register_deposit: string;
  refund_precommitment: string;
};

/** ragequit's attached NEAR: (475 + 389) × 1e19 + register_deposit + 1 yocto (one ft_transfer). */
export function ragequitYocto(registerDeposit: bigint): bigint {
  return BigInt(RAGEQUIT.storage_bytes + CONSTANTS.REFUND_RESERVE_BYTES) * STORAGE_BYTE_COST + registerDeposit + 1n;
}

// ---- The proof format (2.5.2, 2.5.3): snarkjs's, which the vault re-encodes for alt_bn128 ----

/** snarkjs groth16 JSON, affine (z = 1), decimal strings, Fq2 as [c0, c1]. */
export type SnarkjsProof = {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol?: "groth16";
  curve?: "bn128";
};
/** The vault's `proof` argument: snarkjs's points as written, without the z coordinate. */
export type VaultProof = { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };

/** snarkjs's public signals, in snarkjs order. */
export const WITHDRAW_SIGNALS = [
  "newCommitmentHash",
  "existingNullifierHash",
  "withdrawnValue",
  "stateRoot",
  "stateTreeDepth",
  "ASPRoot",
  "ASPTreeDepth",
  "context",
] as const;
export const RAGEQUIT_SIGNALS = ["commitment", "nullifierHash", "value", "label"] as const;
export type WithdrawSignals = [string, string, string, string, string, string, string, string];
export type RagequitSignals = [string, string, string, string];

/** snarkjs's proof as the vault's argument, every coordinate canonical and below q, as the vault parses it. */
export function vaultProof(p: SnarkjsProof): VaultProof {
  if (p.pi_a[2] !== "1" || p.pi_c[2] !== "1" || p.pi_b[2][0] !== "1" || p.pi_b[2][1] !== "0") {
    throw new Error("proof: not affine snarkjs JSON");
  }
  const x = (s: string): string => {
    if (decimal(s, "proof") >= Q) throw new Error("proof: a coordinate not below q");
    return s;
  };
  return {
    a: [x(p.pi_a[0]), x(p.pi_a[1])],
    b: [
      [x(p.pi_b[0][0]), x(p.pi_b[0][1])],
      [x(p.pi_b[1][0]), x(p.pi_b[1][1])],
    ],
    c: [x(p.pi_c[0]), x(p.pi_c[1])],
  };
}

// ---- Events (NEP-297, written as EVENT_JSON:{"standard","version","event","data"}) ----

export const EVENT_STANDARD = "blindfill-vault";
export const EVENT_VERSION = "1.0.0";
/** Each event's data fields. Field elements and amounts are decimal strings, indexes JSON numbers (0-based). */
export const EVENTS = {
  leaf_inserted: ["tree", "index", "leaf", "root"],
  deposited: ["depositor", "commitment", "label", "value", "precommitment"],
  storage_prepaid: ["precommitment", "payer", "amount"],
  withdrawn: ["processor", "value", "spent_nullifier", "new_commitment"],
  withdrawal_relayed: ["relayer", "recipient", "amount", "fee", "refund_precommitment"],
  ragequit: ["ragequitter", "commitment", "label", "value"],
  payout: ["nullifier_hash", "delivered", "returned"],
  refund_inserted: ["nullifier_hash", "commitment", "label", "value"],
} as const;
export type VaultEventName = keyof typeof EVENTS;
export type VaultEvent = {
  standard: typeof EVENT_STANDARD;
  version: typeof EVENT_VERSION;
  event: VaultEventName;
  data: Record<string, string | number>;
};

// ---- The setup files (2.6): Privacy Pools v1.3.0's, under packages/circuits/, reused byte for byte ----

export const SETUP_FILES = [
  { path: "build/withdraw/withdraw_js/withdraw.wasm", bytes: 2_607_967, sha256: "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10" },
  { path: "trusted-setup/final-keys/withdraw.zkey", bytes: 17_793_015, sha256: "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677" },
  { path: "trusted-setup/final-keys/withdraw.vkey", bytes: 4_208, sha256: "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e" },
  { path: "build/commitment/commitment_js/commitment.wasm", bytes: 2_380_442, sha256: "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8" },
  { path: "trusted-setup/final-keys/commitment.zkey", bytes: 901_233, sha256: "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3" },
  { path: "trusted-setup/final-keys/commitment.vkey", bytes: 3_477, sha256: "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8" },
] as const;

// ---- Encodings (2.2, 2.5.1 row 8, 2.5.2 row 3): keccak256 of these bytes, read big-endian, then mod p ----

export type Keccak256 = (data: Uint8Array) => Uint8Array;

/** borsh(("blindfill-vault-v1", vault, token)): three Borsh strings. */
export function scopePreimage(vault: string, token: string): Uint8Array {
  return concat([borshString(SCOPE_TAG), borshString(accountId(vault, "vault")), borshString(accountId(token, "token"))]);
}

/** scope as 32 bytes big-endian, then nonce as 32 bytes big-endian (PP's abi.encodePacked(SCOPE, nonce)). */
export function labelPreimage(scope: bigint, nonce: bigint): Uint8Array {
  if (scope < 0n || scope >= P) throw new Error("scope: not below p");
  return concat([be(scope, 32), be(uint(nonce, 64, "nonce"), 32)]);
}

/** CONTEXT_FIELDS' Borsh bytes in order, then scope as 32 bytes big-endian. */
export function contextPreimage(c: ContextInput, scope: bigint): Uint8Array {
  if (scope < 0n || scope >= P) throw new Error("scope: not below p");
  const parts: Uint8Array[] = [];
  for (const [name, kind] of CONTEXT_FIELDS) {
    const v = c[name];
    if (kind === "account") parts.push(borshString(accountId(v as string, name)));
    else if (kind === "u128") parts.push(le(uint(v as bigint, 128, name), 16));
    else if (kind === "u64") parts.push(le(uint(v as bigint, 64, name), 8));
    else if (kind === "u256be") {
      const n = v as bigint;
      if (n <= 0n || n >= P) throw new Error(`${name}: not in 1..p-1`);
      parts.push(be(n, 32));
    } else parts.push(salt(v as string));
  }
  parts.push(be(scope, 32));
  return concat(parts);
}

/** keccak256's 32 bytes read as a big-endian number, mod p. */
export function fieldOf(digest: Uint8Array): bigint {
  if (digest.length !== 32) throw new Error("digest: not 32 bytes");
  let n = 0n;
  for (const b of digest) n = (n << 8n) | BigInt(b);
  return n % P;
}

export const scopeOf = (keccak: Keccak256, vault: string, token: string): bigint => fieldOf(keccak(scopePreimage(vault, token)));
export const labelOf = (keccak: Keccak256, scope: bigint, nonce: bigint): bigint => fieldOf(keccak(labelPreimage(scope, nonce)));
export const contextOf = (keccak: Keccak256, c: ContextInput, scope: bigint): bigint => fieldOf(keccak(contextPreimage(c, scope)));

// ---- Reading values as the vault reads them ----

/** One canonical decimal: 1 to 78 ASCII digits, no sign, no leading zero (except 0), below 2^256 (2.5.2 row 1). */
export function decimal(s: string, what: string): bigint {
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(s)) throw new Error(`${what}: not one canonical decimal`);
  const n = BigInt(s);
  if (n >= 1n << 256n) throw new Error(`${what}: not below 2^256`);
  return n;
}

/** A NEAR account id: 2 to 64 characters of lowercase letters and digits, parts joined by - or _, split by dots. */
export function accountId(s: string, what: string): string {
  if (typeof s !== "string" || s.length < 2 || s.length > 64 || !/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s)) {
    throw new Error(`${what}: not a NEAR account id`);
  }
  return s;
}

function salt(s: string): Uint8Array {
  if (typeof s !== "string" || !/^[0-9a-f]{32}$/.test(s)) throw new Error("salt: not 32 lowercase hex characters");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function uint(n: bigint, bits: number, what: string): bigint {
  if (typeof n !== "bigint" || n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${what}: not a u${bits}`);
  return n;
}

function le(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
}

function be(n: bigint, len: number): Uint8Array {
  return le(n, len).reverse();
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function borshString(s: string): Uint8Array {
  const b = utf8(s);
  return concat([le(BigInt(b.length), 4), b]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
