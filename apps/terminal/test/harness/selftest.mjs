#!/usr/bin/env node
// The harness's self-test (card app-harness-hosts): in headless Chromium,
//   - each host serves: app.ct.test (the terminal's build under its own _headers), sign.ct.test (the signing page's build under its
//     own _headers),
//     evil.ct.test (same-site sibling) and app.other.test (cross-site), each at its own origin with no port, in a
//     secure context, with the headers its build's _headers file sets;
//   - the browser itself reads evil.ct.test as same-site and app.other.test as cross-site to sign.ct.test
//     (Sec-Fetch-Site on a request each makes there), and a name outside the harness is not found;
//   - an authenticator registers: a passkey made on sign.ct.test with PRF on, held by the virtual authenticator, and
//     two gets with one salt give the same 32-byte PRF output;
//   - the request log names every host, and the server's log too; the page log, the layout-shift recorder and the
//     screencast record.
// Needs the terminal's build (pnpm --filter terminal build) and Playwright's Chromium:
//   node apps/terminal/test/harness/selftest.mjs [--record <file>] [--shots <dir>]
//     [--plant no-authenticator | --plant no-sibling]      PASS exit 0, FAIL exit 1, error exit 2
// --plant breaks the harness on purpose, so the recorded bad answers come from real runs.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeadersFile } from "../../scripts/check-deploy.ts";
import { addAuthenticator, HOSTS, startHarness, startScreencast } from "./harness.mjs";
import { headersFor } from "./server.mjs";

const ROLES = Object.keys(HOSTS);
const CHECKED = ["content-security-policy", "permissions-policy", "integrity-policy"];
const OUTSIDE = "https://example.com/";

// ------------------------------------------------------------------------------------------------ the verdict
export function judge(rec) {
  const lines = [];
  const say = (ok, text) => lines.push(`${ok ? "ok " : "BAD"} ${text}`);

  for (const role of ROLES) {
    const h = rec.hosts?.find((x) => x.role === role);
    const name = HOSTS[role];
    if (!h) {
      say(false, `${role} ${name}: not visited`);
      continue;
    }
    const bad = [];
    if (h.status !== 200) bad.push(`status ${h.status ?? h.error}`);
    if (h.origin !== `https://${name}`) bad.push(`origin ${h.origin}`);
    if (h.secure !== true) bad.push("not a secure context");
    for (const k of CHECKED) if ((h.served?.[k] ?? null) !== (h.expected?.[k] ?? null)) bad.push(`${k} differs from its build's _headers`);
    say(bad.length === 0, `${role} ${name} serves${bad.length ? `: ${bad.join("; ")}` : `: 200 at https://${name}, secure, headers as its build's _headers (${Object.keys(h.expected ?? {}).length} checked)`}`);
  }

  const fs = rec.fetchSite ?? {};
  say(fs.sibling === "same-site", `${HOSTS.sibling} to ${HOSTS.sign} is ${fs.sibling ?? "not seen"} (want same-site)`);
  say(fs.cross === "cross-site", `${HOSTS.cross} to ${HOSTS.sign} is ${fs.cross ?? "not seen"} (want cross-site)`);
  const o = rec.outside ?? {};
  say(o.reached === false && /NAME_NOT_RESOLVED/.test(o.failure ?? ""), `${OUTSIDE} from the harness: ${o.reached === false ? `not reached (${o.failure})` : "REACHED"}`);

  const p = rec.passkey ?? {};
  say(p.created === true, `a passkey made on ${HOSTS.sign}${p.created ? "" : `: ${p.error ?? "no"}`}`);
  say(p.credentials === 1 && p.rpId === HOSTS.sign, `the virtual authenticator holds ${p.credentials ?? 0} credential(s) for ${p.rpId ?? "no rp"}`);
  say(p.prfEnabled === true, `PRF ${p.prfEnabled ? "enabled" : "not enabled"} on create`);
  say(p.heldAtEnd === 1, `the authenticator still holds ${p.heldAtEnd ?? 0} credential(s) at the end of the run`);
  say(p.prfBytes === 32 && p.prfEqual === true, `PRF output ${p.prfBytes ?? 0} bytes, ${p.prfEqual ? "equal" : "not equal"} on two gets`);

  const names = Object.values(HOSTS);
  const logged = new Set((rec.requests ?? []).map((r) => r.host));
  const served = new Set((rec.serverLog ?? []).map((r) => r.host));
  const missLog = names.filter((n) => !logged.has(n));
  const missSrv = names.filter((n) => !served.has(n));
  say(missLog.length === 0, `the request log names every host${missLog.length ? `: missing ${missLog.join(", ")}` : ` (${rec.requests.length} requests)`}`);
  say(missSrv.length === 0, `the server's log names every host${missSrv.length ? `: missing ${missSrv.join(", ")}` : ` (${rec.serverLog.length} requests)`}`);
  const sub = (rec.requests ?? []).filter((r) => !r.navigation);
  say(sub.length > 0 && sub.every((r) => names.includes(r.frameHost)), `every request a page made names the host it came from (${sub.length})`);

  const r = rec.recorders ?? {};
  say((r.pages ?? 0) >= 1, `page log: ${r.pages ?? 0} page(s)`);
  say(typeof r.shiftSum === "number", `layout-shift recorder on ${HOSTS.app}: ${typeof r.shiftSum === "number" ? `sum ${r.shiftSum.toFixed(4)} over ${r.shiftCount} shift(s)` : "not installed"}`);
  say((r.frames ?? 0) >= 1 && r.timestampsRise === true, `screencast: ${r.frames ?? 0} frame(s)${r.timestampsRise ? ", timestamps rising" : ""}`);
  return { ok: lines.every((l) => l.startsWith("ok ")), lines };
}

// ------------------------------------------------------------------------------------------------ the run
const expectedHeaders = (root) => {
  let text;
  try {
    text = readFileSync(path.join(root, "_headers"), "utf8");
  } catch {
    return {};
  }
  const all = headersFor(parseHeadersFile(text).rules, "/");
  return Object.fromEntries(CHECKED.filter((k) => all.has(k)).map((k) => [k, all.get(k)]));
};

export async function run({ plant = null, shots = null } = {}) {
  const h = await startHarness({ edit: (sites) => plant === "no-sibling" && delete sites[HOSTS.sibling] });
  const rec = { plant, browser: h.browser.version(), hosts: [], fetchSite: {}, outside: {}, passkey: {}, recorders: {} };
  try {
    const { context, rec: r } = await h.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cast = await startScreencast(page);
    const auth = plant === "no-authenticator" ? null : await addAuthenticator(page, { hasPrf: true });

    const visit = async (role) => {
      const name = HOSTS[role];
      const entry = { role, host: name, expected: h.sites[name] ? expectedHeaders(h.sites[name].root) : {} };
      rec.hosts.push(entry);
      try {
        const res = await page.goto(`https://${name}/`, { waitUntil: "load" });
        const all = res?.headers() ?? {};
        entry.status = res?.status() ?? null;
        entry.served = Object.fromEntries(CHECKED.filter((k) => k in all).map((k) => [k, all[k]]));
        Object.assign(entry, await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext })));
        if (shots) await page.screenshot({ path: path.join(shots, `${role}.png`) });
      } catch (e) {
        entry.error = String(e.message).split("\n")[0];
      }
      return !entry.error;
    };

    // APP_HOST first, a little settle time for the layout-shift recorder
    if (await visit("app")) {
      await page.waitForTimeout(1000);
      const s = await r.shifts(page);
      rec.recorders.shiftSum = s?.sum ?? null;
      rec.recorders.shiftCount = s?.list.length ?? null;
    }

    if (await visit("sign")) {
      rec.passkey = await page.evaluate(async (rpId) => {
        const salt = new Uint8Array(32).fill(7);
        const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
        const out = {};
        try {
          const cred = await navigator.credentials.create({
            publicKey: {
              rp: { id: rpId, name: "harness" },
              user: { id: rand(16), name: "harness", displayName: "harness" },
              challenge: rand(32),
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
              authenticatorSelection: { residentKey: "required", userVerification: "required" },
              timeout: 5000,
              extensions: { prf: {} },
            },
          });
          out.created = true;
          out.prfEnabled = cred.getClientExtensionResults().prf?.enabled === true;
          const prf = async () => {
            const a = await navigator.credentials.get({
              publicKey: { rpId, challenge: rand(32), allowCredentials: [{ type: "public-key", id: cred.rawId }], userVerification: "required", timeout: 5000, extensions: { prf: { eval: { first: salt } } } },
            });
            const f = a.getClientExtensionResults().prf?.results?.first;
            return f ? new Uint8Array(f) : null;
          };
          const [x, y] = [await prf(), await prf()];
          out.prfBytes = x?.length ?? 0;
          out.prfEqual = !!x && !!y && x.length === y.length && x.every((b, i) => b === y[i]);
        } catch (e) {
          out.created = out.created ?? false;
          out.error = `${e.name}: ${e.message}`;
        }
        return out; // lengths and equality only: the PRF output itself is never recorded
      }, HOSTS.sign);
      const creds = auth ? await auth.credentials() : [];
      rec.passkey.credentials = creds.length;
      rec.passkey.rpId = creds[0]?.rpId ?? null;
    }

    // each other host makes one request to SIGN_HOST; the server records how the browser labelled it
    for (const role of ["sibling", "cross"]) {
      if (!(await visit(role))) continue;
      const before = h.serverLog.length;
      await page.evaluate((u) => fetch(u, { mode: "no-cors" }).catch(() => null), `https://${HOSTS.sign}/?from=${role}`);
      rec.fetchSite[role] = h.serverLog.slice(before).find((e) => e.host === HOSTS.sign)?.fetchSite ?? null;
    }

    // a name outside the harness is not found: no test ever reaches a real host
    const failure = await page.evaluate((u) => fetch(u, { mode: "no-cors" }).then(() => null, (e) => String(e)), OUTSIDE);
    await page.waitForTimeout(200);
    const outReq = r.requests.find((x) => x.url === OUTSIDE);
    rec.outside = { reached: failure === null || (outReq?.status ?? null) !== null, failure: outReq?.failure ?? failure };

    await page.waitForTimeout(300);
    await cast.stop();
    // the authenticator outlives the other hosts' visits and the screencast's stop (cdpFor in harness.mjs)
    rec.passkey.heldAtEnd = auth ? (await auth.credentials()).length : 0;
    rec.recorders.pages = r.pages.length;
    rec.recorders.frames = cast.frames.length;
    rec.recorders.timestampsRise = cast.frames.length > 0 && cast.frames.every((f, i) => i === 0 || f.timestamp >= cast.frames[i - 1].timestamp);
    rec.requests = r.requests;
    rec.serverLog = h.serverLog.map(({ host, method, path: p, status, fetchSite }) => ({ host, method, path: p, status, fetchSite }));
    await auth?.remove();
    await context.close();
  } finally {
    await h.close();
  }
  return rec;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  try {
    const shots = opt("--shots", null);
    if (shots) mkdirSync(shots, { recursive: true });
    const rec = await run({ plant: opt("--plant", null), shots });
    const { ok, lines } = judge(rec);
    for (const l of lines) console.log(l);
    const file = opt("--record", null);
    if (file) writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`${ok ? "PASS" : "FAIL"} app-harness-hosts self-test (Chromium ${rec.browser}${rec.plant ? `, planted ${rec.plant}` : ""})`);
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error(`ERROR app-harness-hosts self-test: ${e.stack ?? e}`);
    process.exit(2);
  }
}
