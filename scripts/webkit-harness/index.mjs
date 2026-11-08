// Card signpage-shell: run pages on the Mac's own WebKit.framework (Safari's engine) with both hosts served locally.
//   const driver = await launchWebKit({ serve, width, height })  (the view in CSS px; 800 x 600 when not given)
// serve(host, pathAndQuery, method, body) -> { status, headers, body } | null (404), called for every request to
// SIGN_HOST or APP_HOST. WebKit reaches them through an HTTP CONNECT proxy on 127.0.0.1 that tunnels only those two
// hosts to a local HTTPS server and refuses (and logs) every other host, so nothing reaches the network. The TLS
// certificate is made per run with openssl in a fresh temp dir, which close() deletes; the Swift driver accepts
// exactly that certificate for exactly those two hosts.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';

export const SIGN_HOST = 'confidential.unrealized.trade';
export const APP_HOST = 'ct-app.unrealized.trade';
const HOSTS = new Set([SIGN_HOST, APP_HOST]);
const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 8 * 1024 * 1024;
const CMD_TIMEOUT_MS = 30_000;

const listen = (server) => new Promise((ok, no) => {
  server.once('error', no);
  server.listen(0, '127.0.0.1', () => ok(server.address().port));
});

export async function launchWebKit({ serve, width = 800, height = 600 }) {
  if (process.platform !== 'darwin') throw new Error('webkit-harness: needs macOS (WebKit.framework)');
  if (typeof serve !== 'function') throw new Error('webkit-harness: serve must be a function');
  const dir = mkdtempSync(join(tmpdir(), 'wk-harness-'));
  const servers = [];
  let child;
  const cleanup = () => {
    try { child?.kill('SIGKILL'); } catch {}
    for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    // 1. A certificate for both hosts, made now, kept only in the temp dir.
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=webkit-harness',
      '-addext', `subjectAltName=${[...HOSTS].map((h) => `DNS:${h}`).join(',')}`,
      '-addext', 'extendedKeyUsage=serverAuth'], { stdio: ['ignore', 'ignore', 'pipe'] });

    // 2. The HTTPS server: every request to either host goes to serve().
    const requests = [];
    const site = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
      const host = String(req.headers.host ?? '').replace(/:443$/, '').toLowerCase();
      if (!HOSTS.has(host)) { res.writeHead(421).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > MAX_BODY) { res.writeHead(413).end(); return; }
        chunks.push(c);
      }
      requests.push({ host, path: req.url, method: req.method, t: Date.now() });
      let r;
      try { r = await serve(host, req.url, req.method, Buffer.concat(chunks)); } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e?.stack ?? e)); return;
      }
      if (r == null) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(r.status ?? 200, r.headers ?? {});
      res.end(r.body ?? '');
    });
    servers.push(site);
    const sitePort = await listen(site);

    // 3. The CONNECT proxy: the two hosts on 443 go to the local server; any other request is refused and logged.
    const refused = [];
    const tunnels = [];
    const proxy = http.createServer((req, res) => {
      refused.push({ kind: 'http', target: String(req.url).slice(0, 300), t: Date.now() });
      res.writeHead(403).end();
    });
    proxy.on('connect', (req, socket, head) => {
      const target = String(req.url);
      const m = /^([a-z0-9.-]+):(\d+)$/i.exec(target);
      if (!m || !HOSTS.has(m[1].toLowerCase()) || m[2] !== '443') {
        refused.push({ kind: 'connect', target: target.slice(0, 300), t: Date.now() });
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      tunnels.push({ target, t: Date.now() });
      const up = net.connect(sitePort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    servers.push(proxy);
    const proxyPort = await listen(proxy);

    // 4. The Swift driver, compiled once per run into the temp dir.
    const bin = join(dir, 'wkdriver');
    execFileSync('swiftc', ['-O', '-o', bin, join(HERE, 'driver.swift')], { stdio: ['ignore', 'ignore', 'pipe'] });
    child = spawn(bin, [String(proxyPort), cert, ...HOSTS, String(width), String(height)], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdin.on('error', () => {}); // a write after the driver exits; the exit handler rejects what is pending

    const messages = [];
    const trustRefused = [];
    const pending = new Map();
    let nextId = 1;
    let version;
    let exited = null;
    let readyOk;
    let readyNo;
    const ready = new Promise((ok, no) => { readyOk = ok; readyNo = no; });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        if (o.event === 'ready') { version = o.version; readyOk(); }
        else if (o.event === 'message') {
          let data;
          try { data = JSON.parse(o.data); } catch { data = o.data; }
          messages.push({ frame: { host: o.host, main: o.main }, data, t: o.t });
        } else if (o.event === 'trust-refused') trustRefused.push(o.host);
        else if (o.id != null && pending.has(o.id)) {
          const p = pending.get(o.id);
          pending.delete(o.id);
          clearTimeout(p.timer);
          if (o.ok) {
            try { p.ok(JSON.parse(o.value)); } catch { p.ok(o.value); }
          } else p.no(new Error(o.error));
        }
      }
    });
    child.on('exit', (code, sig) => {
      exited = `driver exited (${code ?? sig})`;
      readyNo(new Error(exited));
      for (const p of pending.values()) { clearTimeout(p.timer); p.no(new Error(exited)); }
      pending.clear();
    });
    const send = (cmd, fields = {}, timeoutMs = CMD_TIMEOUT_MS) => new Promise((ok, no) => {
      if (exited) { no(new Error(exited)); return; }
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); no(new Error(`${cmd} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      pending.set(id, { ok, no, timer });
      child.stdin.write(JSON.stringify({ id, cmd, ...fields }) + '\n');
    });
    await ready;

    let closed = false;
    return {
      version,
      goto: (url) => send('goto', { url: String(url) }),
      reload: () => send('reload'),
      evaluate: (js) => send('evaluate', { js: String(js) }),
      evaluateFrame: (host, js) => send('evaluateFrame', { host: String(host), js: String(js) }),
      click: (selector) => send('click', { selector: String(selector) }),
      // native keyDown/keyUp per character, delayMs apart, to whatever holds the page's focus
      type: (text, delayMs = 30) => send('type', { text: String(text), delayMs: Number(delayMs) }, 30_000 + String(text).length * (Number(delayMs) + 50)),
      messages: () => messages.slice(),
      requests: () => requests.slice(),
      refused: () => refused.slice(),
      tunnels: () => tunnels.slice(),
      trustRefused: () => trustRefused.slice(),
      async close() {
        if (closed) return;
        closed = true;
        if (!exited) {
          const gone = new Promise((ok) => child.once('exit', ok));
          send('close').catch(() => {});
          await Promise.race([gone, new Promise((ok) => setTimeout(ok, 3000))]);
        }
        cleanup();
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
