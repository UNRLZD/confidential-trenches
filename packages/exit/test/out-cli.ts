// The exit tool's moves out of the one-time ids and arming accounts (src/out.ts) as one CLI run, for
// contracts/vault/tests/exit_out.rs (near-sandbox, card exit-ids-out): reads one JSON object on stdin, runs the tool's
// own steps against a local near-sandbox and prints one JSON line.
//   stdin:  { rpc: "http://127.0.0.1:<port>", accounts: [{ kind: "U", s, i } | { kind: "V", l, j } | { kind: "A", l, j }],
//             to?: the typed account, legs?: [[("token" | "register" | "intents"), ...] per account], send?: false }
//           (s and l decimal strings). With no `to` it prints the accounts' ids alone and reads nothing.
//   stdout: { ids, recipient, holdings, built: [{ account, leg, hash, amount, nonce, receiver, calls, signed? }],
//             results: [{ hash, status }] }   (every number a decimal string)
// The steps, as the tool runs them: exitRecipient(to), exitHoldings(ids), then per account and leg the wallet's read
// (readMoveOutFor for "token" and "register", readWithdrawOut for "intents"), exitBuildMove, and the signed bytes sent
// by send_tx wait_until FINAL; with send false nothing is sent and each built move carries its signed bytes (public: a
// signed transaction), for the test to send later (a move the device signed before USDC halted).
// The two RPCs are NAMED as the mainnet release pair (EXIT_NETWORKS.mainnet.rpcs), the pair exitHoldings and
// exitRecipient accept, and both query the one sandbox URL. The URL must be a loopback one, so this never sends to a
// real network. The seed is the published all-zero vector's (packages/wallet/test/vectors/a8.json: entropy 16 zero
// bytes, no passphrase; as test/out.test.ts), held here and never taken from stdin, so no real key can reach it; no key
// is printed, and the seed is zeroed before the process ends.
import { readFileSync } from "node:fs";
import { entropyToWords, moveOutRpc, readMoveOutFor, readWithdrawOut, wordsToSeed64, type MoveOutRpc } from "@blindfill/kit/core";
import { EXIT_NETWORKS } from "../src/rpc.ts";
import { EXIT_TOKENS } from "../src/scan.ts";
import { exitBuildMove, exitHoldings, exitKey, exitRecipient, exitStorageMin, type ExitAccount, type ExitMove } from "../src/out.ts";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
const fail = (why: string): never => {
  throw new Error(`out-cli: ${why}`);
};

const input: unknown = JSON.parse(readFileSync(0, "utf8"));
if (!isObj(input)) fail("stdin is not a JSON object");
const { rpc, accounts: given, to, legs, send } = input as Obj;
if (!Array.isArray(given) || given.length < 1 || given.length > 8) fail("accounts: 1 to 8 of them");
const DEC = /^(0|[1-9][0-9]{0,77})$/;
const index = (x: unknown, what: string): number => (Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < 2 ** 31 ? (x as number) : fail(`${what}: a counter`));
const field = (x: unknown, what: string): bigint => (typeof x === "string" && DEC.test(x) ? BigInt(x) : fail(`${what}: a decimal string`));
const accounts: ExitAccount[] = (given as unknown[]).map((a, k) => {
  if (!isObj(a)) return fail(`accounts[${k}]: not an object`);
  if (a.kind === "U") return { kind: "U", s: field(a.s, `accounts[${k}].s`), i: index(a.i, `accounts[${k}].i`) };
  if (a.kind === "V" || a.kind === "A") return { kind: a.kind, l: field(a.l, `accounts[${k}].l`), j: index(a.j, `accounts[${k}].j`) };
  return fail(`accounts[${k}].kind: U, V or A`);
});

const seed64 = wordsToSeed64(entropyToWords(new Uint8Array(16)));
const network = "mainnet" as const;
const token = EXIT_TOKENS[network];
try {
  const ids = accounts.map((a) => {
    const k = exitKey(seed64, a);
    k.secretKey.fill(0);
    return k.id;
  });
  if (to === undefined) {
    console.log(JSON.stringify({ ids }));
  } else {
    if (typeof rpc !== "string") fail("rpc: a URL");
    const url = new URL(rpc as string);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) fail("rpc: a loopback http URL (the sandbox), never a real network");
    const steps = legs === undefined ? accounts.map(() => []) : legs;
    if (!Array.isArray(steps) || steps.length !== accounts.length) fail("legs: one list per account");
    const plan = (steps as unknown[]).map((l, k) => (Array.isArray(l) && l.length <= 3 && l.every((x) => x === "token" || x === "register" || x === "intents") ? (l as ("token" | "register" | "intents")[]) : fail(`legs[${k}]: token, register or intents, at most 3`)));
    const doSend = send === undefined ? true : send === false ? false : fail("send: false, or absent");
    const rpcs = EXIT_NETWORKS[network].rpcs.map((name): MoveOutRpc => ({ ...moveOutRpc(url.href), name })) as unknown as readonly [MoveOutRpc, MoveOutRpc];
    const call = async (method: string, params: unknown): Promise<Obj> => {
      const a = await rpcs[0].call(method, params);
      return isObj(a) ? a : fail(`${method}: not a JSON-RPC answer`);
    };
    const checked = await exitRecipient(to, network, rpcs);
    if (!checked.ok) {
      console.log(JSON.stringify({ ids, recipient: { ok: false, code: checked.code } }));
    } else {
      const holdings = (await exitHoldings({ network, ids, rpcs })).holdings;
      // the token's storage minimum, the tool's own read (exitStorageMin, both RPCs), read only for a leg on the
      // token: while USDC is halted every view of it fails, and a holdings-only run must still read
      const storageMinRead = (): Promise<bigint> => exitStorageMin(network, rpcs);
      const built: Obj[] = [];
      const results: Obj[] = [];
      for (const [k, account] of accounts.entries()) {
        const u = ids[k]!;
        for (const leg of plan[k]!) {
          let move: ExitMove;
          if (leg === "intents") {
            const read = await readWithdrawOut(u, checked.recipient.account, token, rpcs);
            move = { leg, read: read ?? fail(`${u} ${leg}: the read is null (unread, or USDC halted)`) };
          } else {
            const read = await readMoveOutFor(u, checked.recipient.account, token, rpcs);
            move = { leg, read: read ?? fail(`${u} ${leg}: the read is null (unread, or USDC halted)`), storageMin: await storageMinRead() };
          }
          const m = exitBuildMove({ seed64, account, network, to: checked.recipient, move });
          built.push({ account: k, leg, hash: m.hash, amount: m.amount, nonce: m.nonce, receiver: m.receiver, calls: m.calls, ...(doSend ? {} : { signed: m.signed }) });
          if (!doSend) continue;
          const sent = await call("send_tx", { signed_tx_base64: m.signed, wait_until: "FINAL" });
          if (sent.error !== undefined) fail(`send_tx ${m.hash}: ${JSON.stringify(sent.error).slice(0, 300)}`);
          const status = isObj(sent.result) ? sent.result.status : undefined;
          results.push({ hash: m.hash, status: isObj(status) && status.SuccessValue !== undefined ? "success" : isObj(status) && status.Failure !== undefined ? "failure" : "unknown" });
        }
      }
      console.log(JSON.stringify({ ids, recipient: { ok: true, account: checked.recipient.account }, holdings, built, results }, str));
    }
  }
} finally {
  seed64.fill(0);
}
