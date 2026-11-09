// Verify's rows from its reads (app.md A7, CH-090 to CH-097, CH-120; 09-design-brief S18). Two rows: Code (the vault's
// keys, its code hash against the release) and Funds (config().asset is the token read, the vault registered on it,
// the token's code hash against its pin, the balance against deposited - spent + returned). A check is judged only on
// an answer both RPCs gave at the one block with the same block hash and the same value; an answer one RPC did not
// give is Unverified on its check (S18.3), two different answers are RPCs disagree (S18.4, both rows amber at least).
// Amounts are exact bigint arithmetic. The view holds what was read, shortened for the screen, and no claim.
import { VERIFY_READS } from "./read.ts";
import type { VerifyPins, VerifyReadId, VerifyReads } from "./read.ts";

export type VerifyStatus = "ok" | "warn" | "danger";
export type VerifyValueKey = "keys" | "codeHash" | "release" | "asset" | "registration" | "balance" | "deposited" | "spent" | "returned" | "surplus" | "authority" | "owner" | "proxy";
/** One value the panel read; `rpc` names the RPC when the two did not give one answer. */
export type VerifyValue = { k: VerifyValueKey; v: string; rpc?: string };
export type VerifyCheckId = "keys" | "code" | "asset" | "registration" | "tokenCode" | "balance";
export type VerifyCheck = { id: VerifyCheckId; status: VerifyStatus; word: "unverified" | "disagree" | null; values: VerifyValue[] };
export type VerifyRow = { status: VerifyStatus; checks: VerifyCheck[] };
export type VerifyView =
  | { state: "loading" }
  | { state: "read" | "disagree" | "unverified"; code: VerifyRow; funds: VerifyRow; height: string; blockHash: string | null; rpcs: string[] };

type Totals = { deposited: bigint; spent: bigint; returned: bigint };
type Decoded = { keys: unknown[]; account: string; config: string; totals: Totals; balance: bigint; registration: bigint | null; token: string };
type Read<K extends VerifyReadId = VerifyReadId> = { ok: true; value: Decoded[K]; key: string; hash: string } | { ok: false };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,39}$/.test(v) ? BigInt(v) : null);

function viewJson(r: Record<string, unknown>): unknown {
  const b = r.result;
  if (!Array.isArray(b) || !b.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(b as number[])));
  } catch {
    return undefined;
  }
}

/** One answer decoded, or not read: an error, another block, or a value not of the view's shape. */
function decode<K extends VerifyReadId>(id: K, a: unknown, height: number): Read<K> {
  if (!isObj(a) || a.error !== undefined || !isObj(a.result)) return { ok: false };
  const r = a.result;
  if (r.error !== undefined || r.block_height !== height || typeof r.block_hash !== "string" || r.block_hash === "") return { ok: false };
  let value: unknown;
  if (id === "keys") value = Array.isArray(r.keys) ? r.keys : undefined;
  else if (id === "account" || id === "token") value = typeof r.code_hash === "string" && r.code_hash !== "" ? r.code_hash : undefined;
  else {
    const j = viewJson(r);
    if (id === "config") value = isObj(j) && typeof j.asset === "string" ? j.asset : undefined;
    else if (id === "balance") value = whole(j) ?? undefined;
    else if (id === "registration") value = j === null ? null : isObj(j) ? (whole(j.total) ?? undefined) : undefined;
    else if (id === "totals" && isObj(j)) {
      const [d, s, t] = [whole(j.deposited), whole(j.spent), whole(j.returned)];
      value = d !== null && s !== null && t !== null ? { deposited: d, spent: s, returned: t } : undefined;
    }
  }
  if (value === undefined) return { ok: false };
  const key = JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v));
  return { ok: true, value: value as Decoded[K], key, hash: r.block_hash };
}

/** A hash or an id shortened in the middle (S18: Chivo 12, shortened in the middle). */
export const short = (s: string) => (s.length > 20 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);
const group = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** An integer amount in its token's units, exact: 9000000 at 6 decimals is "9", -1 is "-0.000001". */
export function units(n: bigint, decimals: number): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${group(int)}${frac ? `.${frac}` : ""}`;
}

type Judged = { status: VerifyStatus; values: VerifyValue[] };
type Rule = { id: VerifyCheckId; reads: VerifyReadId[]; judge: (d: Decoded, p: VerifyPins) => Judged };
const RULES: { code: Rule[]; funds: Rule[] } = {
  code: [
    { id: "keys", reads: ["keys"], judge: (d) => ({ status: d.keys.length === 0 ? "ok" : "danger", values: [{ k: "keys", v: String(d.keys.length) }] }) },
    {
      id: "code",
      reads: ["account"],
      judge: (d, p) => ({ status: d.account === p.release ? "ok" : "danger", values: [{ k: "codeHash", v: short(d.account) }, { k: "release", v: short(p.release) }] }),
    },
  ],
  funds: [
    { id: "asset", reads: ["config"], judge: (d, p) => ({ status: d.config === p.asset ? "ok" : "danger", values: [{ k: "asset", v: short(d.config) }] }) },
    {
      id: "registration",
      reads: ["registration"],
      judge: (d) => ({
        status: d.registration !== null && d.registration > 0n ? "ok" : "danger",
        values: [{ k: "registration", v: d.registration === null ? "—" : `${units(d.registration, 24)} NEAR` }],
      }),
    },
    {
      id: "tokenCode",
      reads: ["token"],
      judge: (d, p) => ({ status: d.token === p.assetRelease ? "ok" : "danger", values: [{ k: "codeHash", v: short(d.token) }, { k: "release", v: short(p.assetRelease) }] }),
    },
    {
      id: "balance",
      reads: ["totals", "balance"],
      judge: (d, p) => {
        const t = d.totals;
        const surplus = d.balance - (t.deposited - t.spent + t.returned);
        const u = (n: bigint) => `${units(n, p.assetDecimals)} ${p.assetSymbol}`;
        return {
          status: surplus >= 0n ? "ok" : "danger",
          values: [
            { k: "balance", v: u(d.balance) },
            { k: "deposited", v: u(t.deposited) },
            { k: "spent", v: u(t.spent) },
            { k: "returned", v: u(t.returned) },
            { k: "surplus", v: u(surplus) },
          ],
        };
      },
    },
  ],
};

const RANK: Record<VerifyStatus, number> = { ok: 0, warn: 1, danger: 2 };
const worst = (s: VerifyStatus[]) => s.reduce<VerifyStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

/** The panel's view of two RPCs' reads; null is still reading (S18.1). */
export function verifyView(reads: VerifyReads | null, pins: VerifyPins): VerifyView {
  if (reads === null) return { state: "loading" };
  const { height, rpcs } = reads;
  const got = rpcs.map((r) => Object.fromEntries(VERIFY_READS.map((id) => [id, decode(id, r.answers[id], height)])) as { [K in VerifyReadId]: Read<K> });
  const pair = (id: VerifyReadId): "unverified" | "disagree" | null => {
    const [a, b] = [got[0][id], got[1][id]];
    if (!a.ok || !b.ok) return "unverified";
    return a.key === b.key && a.hash === b.hash ? null : "disagree";
  };
  const values = (i: number) => Object.fromEntries(VERIFY_READS.map((id) => [id, got[i][id].ok ? (got[i][id] as { value: unknown }).value : undefined])) as Decoded;
  let disagree = false;
  const judge = (rule: Rule): VerifyCheck => {
    const states = rule.reads.map(pair);
    const word = states.includes("unverified") ? "unverified" : states.includes("disagree") ? "disagree" : null;
    if (word === null) return { id: rule.id, word, ...rule.judge(values(0), pins) };
    if (word === "disagree") disagree = true;
    // what each RPC that read every answer of this check gave, named by the RPC
    const shown = [0, 1].filter((i) => rule.reads.every((id) => got[i][id].ok)).flatMap((i) => rule.judge(values(i), pins).values.map((v) => ({ ...v, rpc: rpcs[i].name })));
    return { id: rule.id, status: "warn", word, values: shown };
  };
  const code = RULES.code.map(judge);
  const funds = RULES.funds.map(judge);
  const row = (checks: VerifyCheck[]): VerifyRow => ({ status: worst([...checks.map((c) => c.status), disagree ? "warn" : "ok"]), checks });
  const hashes = new Set(got.flatMap((g) => VERIFY_READS.flatMap((id) => (g[id].ok ? [(g[id] as { hash: string }).hash] : []))));
  return {
    state: disagree ? "disagree" : "read",
    code: row(code),
    funds: row(funds),
    height: group(String(height)),
    blockHash: hashes.size === 1 ? short([...hashes][0]) : null,
    rpcs: rpcs.map((r) => r.name),
  };
}

/**
 * The panel when nothing was read: a pair the rule refuses, no final height on either RPC, or no vault named on this
 * network. Every check is Unverified (S18.3) with no value, both rows amber, no block; `rpcs` are the RPCs it asked,
 * none when it asked none (the panel then draws "—").
 */
export function unverifiedView(rpcs: readonly string[]): VerifyView {
  const row = (rules: Rule[]): VerifyRow => ({ status: "warn", checks: rules.map((r) => ({ id: r.id, status: "warn", word: "unverified", values: [] })) });
  return { state: "unverified", code: row(RULES.code), funds: row(RULES.funds), height: "—", blockHash: null, rpcs: [...rpcs] };
}
