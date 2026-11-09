// H-app (app.md 5.0): the app's browser tests run on named https hosts, a virtual authenticator and recorders.
//
// Hosts. One https server (server.mjs) serves every host from its own build dir under that dir's own _headers file.
// Chromium reaches them by --host-resolver-rules: the harness names map to that server (port included, so an origin is
// https://app.ct.test with no port, as a CSP source written without a port expects) and every other name fails as
// not found, so no test ever reaches a real host. The certificate is made at run time (certs.mjs) and trusted by its
// SPKI pin in this browser only. ct.test is the registrable domain (.test is not a public suffix), so sign.ct.test and
// evil.ct.test are same-site with app.ct.test and app.other.test is cross-site.
//
// Passkey. CDP WebAuthn and one internal virtual authenticator per page, options as probe P-A2 (app.md:1208); CDP
// sessions exist on Chromium only, one per page (cdpFor).
//
// Recorders. A request log of every request of the context with the host of the document that made it (BAR-10,
// AX-09), the pages the context opened (BAR-01), layout shifts summed from a PerformanceObserver with no input
// exclusion (BAR-04), and a CDP screencast with timestamps (BAR-03). BAR-11's clock is Playwright's own page.clock.
import { copyFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "../../../../scripts/browsers.mjs";
import { signBuilt } from "../../../../scripts/signpage-built.mjs";
import { makeCert } from "./certs.mjs";
import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TERMINAL = path.resolve(HERE, "../..");
export const SIGNPAGE = path.resolve(TERMINAL, "../../packages/signpage");

export const HOSTS = {
  app: "app.ct.test", // APP_HOST
  sign: "sign.ct.test", // SIGN_HOST, same site as APP_HOST
  sibling: "evil.ct.test", // a same-site sibling
  cross: "app.other.test", // a cross-site host
};
// the domains the certificate covers and the browser maps to the harness; any other name is not found
export const MAPPED = ["*.ct.test", "*.other.test"];

// The real names. The shipped _headers name them (APP_HOST's frame-src, SIGN_HOST's frame-ancestors), so a test of the
// iframe or of passkey scope runs on them with startHarness({ realNames: true }): they map to this harness too, the
// builds and headers stay byte-exact, and the same-site layout is the real one (decided 01:50Z Nov 1).
export const REAL = {
  app: "ct-app.unrealized.trade",
  sign: "confidential.unrealized.trade",
  api: "ct-api.unrealized.trade",
};

/** The real names' sites: APP_HOST's and SIGN_HOST's builds as the harness names serve them; the API has none yet. */
export function realSites(sites) {
  return { [REAL.app]: sites[HOSTS.app], [REAL.sign]: sites[HOSTS.sign] };
}

/**
 * SIGN_HOST's served files for the harness: index.html and all of public/ copied into a fresh folder, read as files, not
 * imported (the terminal's code never imports a Blindfill package past the kit's entry). Not the deploy's build:
 * packages/signpage/scripts/deploy.mjs build() copies only the files git tracks (an ignored file such as public/.env.local
 * never ships) and adds the prover's setup files; this copy takes whatever is in public/. The caller removes the folder.
 */
export function buildSignpage() {
  const out = mkdtempSync(path.join(tmpdir(), "ct-harness-sign-"));
  signBuilt(); // index.html and public/'s app.js and prover files, built from this tree's sources first (card signpage-generated-merge-free)
  copyFileSync(path.join(SIGNPAGE, "index.html"), path.join(out, "index.html"));
  cpSync(path.join(SIGNPAGE, "public"), out, { recursive: true });
  return out;
}

/** Each host's build: the terminal's build (pnpm --filter terminal build) and the signing page's, each with its own _headers.
 * Both are Pages projects with no 404.html, so a path with no file answers the index (spa): SIGN_HOST answers
 * /favicon.ico, /_headers and /no-such-path 200 text/html, its index (read live 8 Nov 07:31Z; card terminal-harness-sign-spa,
 * as sign-harness-like-live made every live-check harness). */
export function defaultSites(signRoot) {
  return {
    [HOSTS.app]: { root: path.join(TERMINAL, "dist"), spa: true },
    [HOSTS.sign]: { root: signRoot, spa: true },
    [HOSTS.sibling]: { root: path.join(HERE, "sites/plain") },
    [HOSTS.cross]: { root: path.join(HERE, "sites/plain") },
  };
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return null;
  }
};

/**
 * Starts the server and Chromium. Close with close(); it deletes the certificate and the signing page's build.
 * @param {{ edit?: (sites: Record<string, { root: string, spa?: boolean }>) => void, headless?: boolean, realNames?: boolean }} [opts]
 *   edit changes the default sites before the server starts; realNames maps REAL's names too, served after edit
 */
export async function startHarness(opts = {}) {
  const mapped = opts.realNames ? [...MAPPED, ...Object.values(REAL)] : MAPPED;
  const cert = makeCert(mapped);
  const signRoot = buildSignpage();
  const sites = defaultSites(signRoot);
  opts.edit?.(sites);
  if (opts.realNames) Object.assign(sites, realSites(sites));
  const cleanup = () => {
    cert.remove();
    rmSync(signRoot, { recursive: true, force: true });
  };
  let server;
  let browser;
  try {
    server = await startServer({ cert: cert.cert, key: cert.key, sites });
    const rules = [...mapped.map((d) => `MAP ${d} 127.0.0.1:${server.port}`), "MAP * ~NOTFOUND"].join(", ");
    browser = await launchBrowser("chromium", {
      headless: opts.headless ?? true,
      args: [`--host-resolver-rules=${rules}`, `--ignore-certificate-errors-spki-list=${cert.spki}`],
    });
  } catch (e) {
    await browser?.close();
    await server?.close();
    cleanup();
    throw e;
  }
  return {
    browser,
    sites,
    serverLog: server.log,
    /** A new context with the request log, the page log and the layout-shift recorder attached. */
    async newContext(contextOpts = {}) {
      const context = await browser.newContext(contextOpts);
      return { context, rec: await attachRecorders(context) };
    },
    async close() {
      try {
        await browser.close();
      } finally {
        await server.close();
        cleanup();
      }
    },
  };
}

/** The context's recorders: request log, page log, layout shifts. */
export async function attachRecorders(context) {
  const t0 = Date.now();
  /** @type {{ t: number, url: string, host: string|null, method: string, type: string, navigation: boolean, frameHost: string|null, status: number|null, failure: string|null }[]} */
  const requests = [];
  const byReq = new Map();
  context.on("request", (r) => {
    let frameHost = null;
    try {
      frameHost = hostOf(r.frame().url()); // for a navigation, the document the frame is leaving
    } catch {
      frameHost = r.serviceWorker() ? "service-worker" : null;
    }
    const e = { t: Date.now() - t0, url: r.url(), host: hostOf(r.url()), method: r.method(), type: r.resourceType(), navigation: r.isNavigationRequest(), frameHost, status: null, failure: null };
    byReq.set(r, e);
    requests.push(e);
  });
  context.on("response", (res) => {
    const e = byReq.get(res.request());
    if (e) e.status = res.status();
  });
  context.on("requestfailed", (r) => {
    const e = byReq.get(r);
    if (e) e.failure = r.failure()?.errorText ?? "failed";
  });
  /** @type {{ t: number, url: string }[]} */
  const pages = [];
  context.on("page", (p) => pages.push({ t: Date.now() - t0, url: p.url() }));
  // every shift counted, hadRecentInput not excluded (BAR-04); runs before any page script, outside the page's CSP
  await context.addInitScript(() => {
    const shifts = [];
    Object.defineProperty(window, "__ctShifts", { value: shifts });
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) shifts.push({ t: e.startTime, value: /** @type {any} */ (e).value });
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // no layout-shift entries in this engine (WebKit, Firefox): the array stays empty
    }
  });
  return {
    requests,
    pages,
    /** the layout shifts recorded on `page` so far, and their sum */
    async shifts(page) {
      const list = await page.evaluate(() => /** @type {any} */ (window).__ctShifts ?? null);
      return list && { list, sum: list.reduce((s, x) => s + x.value, 0) };
    },
  };
}

// One CDP session per page, shared by the screencast and the authenticator and never detached by them: detaching any
// CDP session of a page turns off that page's virtual authenticator environment (seen on Chromium 153: after a second
// session's detach, WebAuthn.getCredentials answers "The Virtual Authenticator Environment has not been enabled for
// this session"). A test that needs CDP on a page takes this session too.
const sessions = new WeakMap();
export function cdpFor(page) {
  if (!sessions.has(page)) sessions.set(page, page.context().newCDPSession(page));
  return sessions.get(page);
}

/** A CDP screencast of `page`: frames with their capture timestamps (seconds), each acknowledged. */
export async function startScreencast(page, { onFrame } = {}) {
  const cdp = await cdpFor(page);
  /** @type {{ timestamp: number, bytes: number }[]} */
  const frames = [];
  const onScreencastFrame = (f) => {
    frames.push({ timestamp: f.metadata.timestamp ?? 0, bytes: f.data.length });
    onFrame?.(f);
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  };
  cdp.on("Page.screencastFrame", onScreencastFrame);
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      cdp.off("Page.screencastFrame", onScreencastFrame);
      await cdp.send("Page.stopScreencast");
    },
  };
}

/** One internal CTAP2.1 virtual authenticator on `page`'s tab, PRF on unless hasPrf is false (P-A2's options). */
export async function addAuthenticator(page, { hasPrf = true } = {}) {
  const cdp = await cdpFor(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  return {
    id: authenticatorId,
    /** the credentials it holds: ids and rp ids only, never the private keys */
    async credentials() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials.map((c) => ({ credentialId: c.credentialId, rpId: c.rpId, isResidentCredential: c.isResidentCredential }));
    },
    async remove() {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    },
  };
}
