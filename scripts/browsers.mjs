// Card ci-browsers-safe: the one place a test browser starts. Every check and test calls launchBrowser() or
// launchDiskProfile(); scripts/ci/browser-launch.mjs fails on a launch anywhere else.
//
// Chromium runs as the installed Google Chrome (Playwright's channel "chrome", which Google keeps patched) with its
// sandbox on, never as Playwright's bundled build: that one is pinned to the Playwright release (1.63.0 bundles
// Chromium 153) and Playwright defaults chromiumSandbox to false. Each launch gets a fresh temporary profile, which
// Playwright deletes on close. This file never opens a user's own profile and never attaches to a running browser.
//
// Firefox and WebKit have no installed channel, so they keep Playwright's builds and print one warning line naming
// the build; they move to GitHub's runners (throwaway VMs with no keys) with the card ci-live-runners.
//
//   const browser = await launchBrowser("chromium", { args: [...] });  // options go to Playwright's launch()
//   browserLabel(browser)  // "Chrome 156.0.8078.80, sandbox on", for a PASS line
//   const { context, label, close } = await launchDiskProfile();       // a Chrome profile on disk, deleted by close()
//   node scripts/browsers.mjs                                          // proves the sandbox on this machine
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The four packages that run browsers pin one Playwright version; the terminal's copy is the one this resolves.
const requireTerminal = createRequire(new URL("../apps/terminal/package.json", import.meta.url));
const playwright = () => requireTerminal("playwright");

export const ENGINES = ["chromium", "firefox", "webkit"];
// The launch options a check may pass. Anything else could pick another build, weaken the sandbox, open a profile of
// the caller's choosing or attach to a browser that is already running, so it is refused rather than listed.
const ALLOWED_OPTIONS = ["headless", "args", "slowMo", "timeout"];
const SANDBOX_OFF = /--(no-sandbox|disable-setuid-sandbox|disable-gpu-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox)\b/;
const NOT_INSTALLED = "Google Chrome (the stable channel) is not installed, and the checks never fall back to Playwright's bundled Chromium";

const labels = new WeakMap();
const warned = new Set();

function refuse(options) {
  for (const k of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(k)) throw new Error(`browsers: launch option ${k} is refused (only ${ALLOWED_OPTIONS.join(", ")}; the launcher sets the build, the sandbox and the profile)`);
  }
  for (const a of options.args ?? []) {
    if (SANDBOX_OFF.test(String(a))) throw new Error(`browsers: launch arg ${a} is refused (it weakens the sandbox)`);
  }
}

const chromeOptions = (options) => ({ ...options, channel: "chrome", chromiumSandbox: true });

function launchFailure(e) {
  const msg = String(e?.message ?? e);
  return /distribution 'chrome' is not found|executable doesn't exist/i.test(msg) ? new Error(`browsers: ${NOT_INSTALLED}`, { cause: e }) : e;
}

/** The browser process's own command line, read over CDP: it must not carry a flag that turns the sandbox off. */
export async function sandboxFlagsOf(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    return (await session.send("SystemInfo.getInfo")).commandLine ?? "";
  } finally {
    await session.detach().catch(() => {});
  }
}

/**
 * Starts an engine. Chromium is the installed Google Chrome with the sandbox on (refused if its own command line says
 * otherwise); Firefox and WebKit are Playwright's builds and print one warning line.
 * @param {"chromium" | "firefox" | "webkit"} engine
 * @param {import("playwright").LaunchOptions} [options] headless, args, slowMo, timeout and the like
 */
export async function launchBrowser(engine = "chromium", options = {}) {
  if (!ENGINES.includes(engine)) throw new Error(`browsers: engine ${engine} is not one of ${ENGINES.join(", ")}`);
  refuse(options);
  const type = playwright()[engine];
  if (engine !== "chromium") {
    const browser = await type.launch(options);
    const name = engine === "firefox" ? "Firefox" : "WebKit";
    labels.set(browser, `${name} ${browser.version()}, Playwright's build`);
    if (!warned.has(engine)) {
      warned.add(engine);
      console.warn(`browsers: WARNING ${engine} runs Playwright's own build (${name} ${browser.version()}), not an installed self-updating browser; it moves to GitHub's runners with ci-live-runners`);
    }
    return browser;
  }
  let browser;
  try {
    browser = await type.launch(chromeOptions(options));
  } catch (e) {
    throw launchFailure(e);
  }
  const line = await sandboxFlagsOf(browser);
  if (SANDBOX_OFF.test(line)) {
    await browser.close();
    throw new Error("browsers: the launched Chrome's command line turns a sandbox off");
  }
  labels.set(browser, `Chrome ${browser.version()}, sandbox on`);
  return browser;
}

/**
 * Chrome with a profile on disk, so its HTTP cache behaves as a phone's does (a fresh context's cache is in memory).
 * The profile is a temporary directory the launcher makes and close() deletes; a caller cannot name one.
 */
export async function launchDiskProfile(options = {}) {
  refuse(options);
  const dir = mkdtempSync(join(tmpdir(), "blindfill-chrome-profile-"));
  let context;
  try {
    context = await playwright().chromium.launchPersistentContext(dir, chromeOptions(options));
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw launchFailure(e);
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const session = await context.newCDPSession(page);
  const { product } = await session.send("Browser.getVersion");
  await session.detach().catch(() => {});
  const label = `${product.replace("HeadlessChrome/", "Chrome ").replace("Chrome/", "Chrome ")}, sandbox on, profile on disk`;
  return {
    context,
    label,
    async close() {
      try {
        await context.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** What a PASS line says about the browser that ran: its name, its version and (Chrome) that the sandbox is on. */
export function browserLabel(browser) {
  return labels.get(browser) ?? `${browser.browserType().name()} ${browser.version()}`;
}

// ------------------------------------------------------------------------------------------------ the proof
const processes = () =>
  execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" })
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));

const descendants = (all, root) => {
  const out = [];
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const c of all) if (c.ppid === p) { out.push(c); queue.push(c.pid); }
  }
  return out;
};

const typeOf = (args) => /--type=([\w-]+)/.exec(args)?.[1] ?? "other";
const readProc = (pid, file) => {
  try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return null; }
};

/**
 * Starts the launcher's Chrome, opens a page and reads what ran: the version, then for each child process of the
 * browser its type, whether its own command line carries a flag that turns a sandbox off and, on Linux, the kernel's
 * seccomp mode (2 = a filter is installed) and the AppArmor profile the browser runs under. Returns lines and ok.
 */
export async function proveSandbox() {
  const browser = await launchBrowser("chromium");
  const lines = [];
  let ok = true;
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto("about:blank");
    await page.evaluate(() => navigator.userAgent);
    const session = await browser.newBrowserCDPSession();
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const root = processInfo.find((p) => p.type === "browser").id;
    const kids = descendants(processes(), root);
    const ua = await page.evaluate(() => navigator.userAgent);
    lines.push(`${browserLabel(browser)} (${ua.match(/(?:Headless)?Chrome\/[\d.]+/)?.[0]})`);
    const renderers = kids.filter((k) => typeOf(k.args) === "renderer");
    if (renderers.length === 0) { ok = false; lines.push("FAIL no renderer process found under the browser"); }
    const linux = process.platform === "linux";
    if (linux) {
      const profile = readProc(root, "attr/current")?.trim() ?? "unreadable";
      const userns = readProc("sys", "kernel/apparmor_restrict_unprivileged_userns") ?? "n/a";
      lines.push(`linux: browser pid ${root} AppArmor profile "${profile}"; kernel.apparmor_restrict_unprivileged_userns=${String(userns).trim()}`);
    }
    for (const k of kids.filter((x) => ["renderer", "gpu-process", "utility"].includes(typeOf(x.args)))) {
      const off = SANDBOX_OFF.test(k.args);
      let evidence = ""; // the platform's own evidence, appended to the line
      if (linux) {
        const m = /^Seccomp:\s*(\d)/m.exec(readProc(k.pid, "status") ?? "");
        evidence = `, seccomp ${m?.[1] ?? "unreadable"}`;
        if (typeOf(k.args) === "renderer" && m?.[1] !== "2") ok = false;
      }
      if (process.platform === "darwin" && typeOf(k.args) === "renderer") {
        // macOS starts a sandboxed renderer through its seatbelt profile and hands it this flag
        const m = /--seatbelt-client=(\d+)/.exec(k.args);
        evidence = m ? `, seatbelt client ${m[1]}` : ", no seatbelt client";
        if (!m) ok = false;
      }
      if (off) ok = false;
      lines.push(`${typeOf(k.args)} pid ${k.pid}: ${off ? "FAIL a flag turns the sandbox off" : "no sandbox-off flag on its command line"}${evidence}`);
    }
  } finally {
    await browser.close();
  }
  lines.push(`browsers: ${ok ? "PASS" : "FAIL"} the sandbox is on`);
  return { ok, lines };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  proveSandbox().then(
    ({ ok, lines }) => {
      for (const l of lines) console.log(l);
      process.exit(ok ? 0 : 1);
    },
    (e) => {
      console.error(`browsers: ERROR ${e?.stack ?? e}`);
      process.exit(2);
    },
  );
}
