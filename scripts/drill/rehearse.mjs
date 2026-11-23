#!/usr/bin/env node
// The unplug drill's rehearsal record (card vault-drill-rehearsal-mainnet-copy): what scripts/drill/rehearse.sh left in
// its out dir, read into one record and judged step by step.
//   node scripts/drill/rehearse.mjs record <out dir>      writes <out dir>/record.json and judges it
//   node scripts/drill/rehearse.mjs --dry <record.json>   judges a recorded run
// PASS exit 0, FAIL exit 1, error exit 2; one line per step and one verdict line.
// The steps, each judged on what the run read, never on a line of its own saying so:
//   1. stack up: /v1/health answered 200 and unplug.sh status read the helper and Caddy running;
//   2. deposits: exit_every_kind patched the mainnet vault's copy (its "copy:" line, no access key) and seeded the
//      words' notes ("seeded on label");
//   3. unplug off: unplug.sh off exit 0 and its own "off, no server of the stack runs" line; a run that left it out
//      (--leave-on) fails here;
//   4. servers down: servers-down.mjs's judge on the read it recorded, against the stack's own ports, exit 0;
//   5. exit from the words: the cut ran after the deposits and before the first line of the exit command, the
//      command's "near: done: sent <n>, left 0", the test passed, and the balances it read on chain after it: the
//      payout account holds every kind's value and the vault is back at mainnet's;
//   6. nothing of ours asked: every request of the test's node processes (net-guard.mjs's list) was to a host not ours,
//      and at least one was written down, so the guard was loaded.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { judge as judgeDown } from "./servers-down.mjs";

/** The test's lines a record keeps: what each step is judged on. The rest of the log (cargo's build) stays out. */
export const KEEP = /^(copy: |the mainnet vault's copy answers|seeded on label |drill: |exit: |chain: |x\.usdc: |the words alone: |pending refund: |move note: |return note: |U second arrival: |A second arrival: |test the_words_alone_bring_every_kind_home |test result: |unplug: |servers-down: |ok |BAD |rehearse: )/;

/** One record from a rehearse.sh out dir. */
export function build(dir) {
  const read = (f) => (existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, "utf8").trim() : null);
  const lines = (f) => (read(f) ?? "").split("\n").filter((l) => l !== "");
  const int = (f) => (read(f) === null ? null : Number(read(f)));
  const json = (f) => (read(f) === null ? null : JSON.parse(read(f)));
  const [http, https] = (read("ports") ?? "").split(" ").map(Number);
  return {
    at: new Date().toISOString(),
    commit: read("commit"),
    leave_on: read("mode") === "--leave-on",
    stack: { ports: { http, https }, health: int("health"), status: lines("stack.txt") },
    cut: {
      at: read("cut.at"),
      unplug: { rc: int("unplug.rc"), lines: lines("unplug.txt") },
      servers_down: { rc: int("servers-down.rc"), read: json("servers-down.json"), lines: lines("servers-down.txt") },
    },
    exit: { rc: int("exit.rc"), lines: lines("exit.log").filter((l) => KEEP.test(l)) },
    requests: lines("requests.jsonl").map((l) => JSON.parse(l)),
  };
}

/** PASS or FAIL, one line per step. */
export function judge(r) {
  const out = [];
  const step = (n, name, ok, what) => out.push(`${ok ? "ok" : "BAD"} ${n}. ${name}: ${what}`);
  if (r === null || typeof r !== "object") return { pass: false, lines: ["BAD nothing to judge: no record"] };
  const ex = Array.isArray(r.exit?.lines) ? r.exit.lines : [];
  const idx = (re) => ex.findIndex((l) => re.test(l));

  // 1. stack up
  const st = Array.isArray(r.stack?.status) ? r.stack.status : [];
  const running = ["helper", "caddy"].filter((s) => st.includes(`unplug: ${s} running`));
  step(1, "stack up", r.stack?.health === 200 && running.length === 2, `health ${r.stack?.health ?? "not read"}, running: ${running.join(" ") || "none"}`);

  // 2. deposits on the mainnet vault's copy
  const copy = ex.find((l) => l.startsWith("copy: ")) ?? "";
  const seeded = ex.find((l) => l.startsWith("seeded on label ")) ?? "";
  step(2, "deposits", /access keys \[\]$/.test(copy) && seeded !== "", copy && seeded ? `${copy.slice(0, 120)}; ${seeded.slice(0, 120)}` : `no ${copy ? "seed" : "mainnet vault copy"} read`);

  // 3. unplug off
  const u = r.cut?.unplug ?? {};
  const offLine = (u.lines ?? []).includes("unplug: off, no server of the stack runs");
  step(3, "unplug off", !r.leave_on && u.rc === 0 && offLine, r.leave_on ? "left out (--leave-on)" : `exit ${u.rc ?? "none"}${offLine ? ", no server of the stack runs" : ", no off line"}`);

  // 4. servers down, read against the stack's own ports
  const sd = r.cut?.servers_down ?? {};
  const v = sd.read ? judgeDown(sd.read) : { pass: false, lines: ["no read"] };
  const ports = Object.keys(sd.read?.helper?.tcp ?? {}).map(Number).sort((a, b) => a - b);
  const want = [r.stack?.ports?.http, r.stack?.ports?.https].sort((a, b) => a - b);
  const samePorts = ports.length === 2 && ports.every((p, i) => p === want[i]) && sd.read?.helper?.host === "127.0.0.1";
  const bad = v.lines.filter((l) => l.startsWith("BAD")).join("; ");
  step(4, "servers down", v.pass && samePorts && sd.rc === 0, !sd.read ? `not read, exit ${sd.rc ?? "none"}` : `${v.pass ? "PASS" : "FAIL"} on ${sd.read.helper?.host}:${ports.join(",")}${samePorts ? "" : " (not the stack's ports)"}${bad ? ` (${bad})` : ""}, exit ${sd.rc ?? "none"}`);

  // 5. the exit from the words, after the cut, and the balances read after it
  const [iSeed, iCut, iExit] = [idx(/^seeded on label /), idx(/^drill: cut passed before the exit command/), idx(/^exit: /)];
  const ordered = iSeed >= 0 && iCut > iSeed && iExit > iCut;
  const done = ex.find((l) => /^exit: near: done: sent \d+, left 0/.test(l));
  const bal = ex.map((l) => l.match(/^x\.usdc: (\d+) \(want (\d+)\); the vault: (\d+) \(mainnet's (\d+)\)$/)).find(Boolean);
  const paid = bal && bal[1] === bal[2] && BigInt(bal[1]) > 0n && bal[3] === bal[4];
  const passed = ex.some((l) => /^test result: ok\. 1 passed; 0 failed/.test(l)) && r.exit?.rc === 0;
  step(5, "exit from the words", ordered && !!done && !!paid && passed,
    `${ordered ? "after the cut" : "not after a passed cut"}; ${done ? done.slice(6) : "no done line"}; ${bal ? `payout account ${bal[1]} of ${bal[2]}, vault ${bal[3]} (mainnet's ${bal[4]})` : "no balance read"}; test ${passed ? "passed" : `exit ${r.exit?.rc ?? "none"}`}`);

  // 6. nothing of ours asked
  const reqs = Array.isArray(r.requests) ? r.requests : [];
  const ours = reqs.filter((q) => q?.ours !== false);
  step(6, "nothing of ours asked", reqs.length > 0 && ours.length === 0, `${reqs.length} request(s) written down, ${ours.length} to a host of ours${ours.length ? `: ${ours.slice(0, 3).map((q) => q?.url).join(" ")}` : ""}`);

  return { pass: !out.some((l) => l.startsWith("BAD")), lines: out };
}

function main(argv) {
  try {
    let r;
    if (argv[0] === "record" && argv[1]) {
      r = build(argv[1]);
      writeFileSync(`${argv[1]}/record.json`, `${JSON.stringify(r, null, 2)}\n`);
    } else if (argv[0] === "--dry" && argv[1]) r = JSON.parse(readFileSync(argv[1], "utf8"));
    else throw new Error("usage: rehearse.mjs record <out dir> | --dry <record.json>");
    const v = judge(r);
    for (const l of v.lines) console.log(l);
    console.log(`rehearse: ${v.pass ? "PASS" : "FAIL"}${r.leave_on ? " (unplug left on)" : ""} at ${r.commit ?? "no commit"}`);
    return v.pass ? 0 : 1;
  } catch (e) {
    console.log(`rehearse: ERROR ${e.message}`);
    return 2;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
