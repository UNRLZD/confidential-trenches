// The welcome's art (shell/Welcome.tsx): the 5 Nov "meet Blindfill" loop the owner posted on X, in the app. The drawing is
// the research repo's docs/growth/day5-blindfill-loop/page3.js (its README proves that rebuild against the posted video),
// variant b: pools only where they are built (Solana, Base, Robinhood), as Verify shows; Bitcoin, Ethereum, Sui and the
// "and more" cluster are chains NEAR Intents reaches. Two more scenes speak the same language for slides 3 and 4: money
// in from any chain, through Cash on NEAR, out to any chain; and twelve word slots. Paper dots on ink, no words.
// Everything is drawn in a 1600 x 900 frame scaled to the canvas, periodic in L, so the loop has no seam. The chain and
// venue marks are web3icons' mono set (MIT, ./NOTICE) and the terminal's own pad logos (screens/market/logos, pads.ts).
import aerodrome from "./aerodrome.png";
import arbitrum from "./arbitrum-one.svg";
import avalanche from "./avalanche.svg";
import base from "./base.svg";
import bsc from "./binance-smart-chain.svg";
import bitcoin from "./bitcoin.svg";
import ethereum from "./ethereum.svg";
import uniswap from "./exchanges-mono-uniswap.svg";
import monad from "./monad.svg";
import near from "./near-protocol.svg";
import robinhood from "./robinhood.svg";
import solana from "./solana.svg";
import sui from "./sui.svg";
import jupiter from "./tok-JUP.svg";
import raydium from "./tok-RAY.svg";
import bags from "../../screens/market/logos/bags.png";
import flaunch from "../../screens/market/logos/flaunch.svg";
import meteora from "../../screens/market/logos/meteora.png";
import pons from "../../screens/market/logos/pons.png";
import pumpfun from "../../screens/market/logos/pumpfun.png";
import stonkfun from "../../screens/market/logos/stonkfun.png";
import virtuals from "../../screens/market/logos/virtuals.png";

export type Scene = "network" | "flow" | "words";
type Logo = { src: string; fit: number; ink?: "bg"; crisp?: number; grid?: number; cut?: number; span?: number };
type Cell = { i: number; j: number; a: number; r: number };
type Cells = Cell[] & { g?: number };
type Pt = { x: number; y: number };
type Path = { T: number; pts: Pt[]; at: (q: number) => Pt };

/* the posted piece's logo table (arch-loop3.mjs LOGOS), plus the chains slide 3 adds */
const LOGOS: Record<string, Logo> = {
  near: { src: near, fit: 0.8 }, bitcoin: { src: bitcoin, fit: 0.84 }, ethereum: { src: ethereum, fit: 0.9 },
  solana: { src: solana, fit: 0.82 }, base: { src: base, fit: 0.54 }, sui: { src: sui, fit: 0.84 }, robinhood: { src: robinhood, fit: 0.86 },
  arbitrum: { src: arbitrum, fit: 0.86 }, bsc: { src: bsc, fit: 0.86 }, avalanche: { src: avalanche, fit: 0.86 }, monad: { src: monad, fit: 0.84 },
  uniswap: { src: uniswap, fit: 0.9, grid: 24 }, raydium: { src: raydium, fit: 0.86, grid: 24 }, jupiter: { src: jupiter, fit: 0.86, grid: 24 },
  pumpfun: { src: pumpfun, fit: 0.92, grid: 24, ink: "bg" }, flaunch: { src: flaunch, fit: 0.8, grid: 24 },
  bags: { src: bags, fit: 0.84, grid: 24, ink: "bg" }, meteora: { src: meteora, fit: 0.86, grid: 24 },
  stonkfun: { src: stonkfun, fit: 0.86, grid: 24, ink: "bg", cut: 40, span: 50 }, pons: { src: pons, fit: 0.84, grid: 24, ink: "bg" },
  virtuals: { src: virtuals, fit: 0.86, grid: 24, ink: "bg" }, aerodrome: { src: aerodrome, fit: 0.9, grid: 24 },
};
const NEED: Record<Scene, string[]> = {
  network: ["near", "bitcoin", "ethereum", "solana", "base", "sui", "robinhood", "uniswap", "raydium", "jupiter", "pumpfun", "flaunch", "bags", "meteora", "stonkfun", "pons", "virtuals", "aerodrome"],
  flow: ["near", "bitcoin", "ethereum", "solana", "base", "sui", "arbitrum", "bsc", "avalanche", "monad", "robinhood"],
  words: [],
};

const W = 1600, H = 900, L = 10, PAPER = "#f4f4f2", SOFT = "#a3a3a3", TAU = Math.PI * 2;
const clamp = (v: number) => Math.min(1, Math.max(0, v));
const ease = (u: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(u));
const mod = (a: number, n: number) => ((a % n) + n) % n;
const hash = (a: number, b: number, c: number) => { const s = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return s - Math.floor(s); };
const bump = (tau: number, t0: number, w: number) => { const d = Math.min(Math.abs(tau - t0), L - Math.abs(tau - t0)); return d >= w ? 0 : ease(1 - d / w); };
const canvas2d = (n: number) => { const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(n, n) : Object.assign(document.createElement("canvas"), { width: n, height: n }); return c; };
const ctx2d = (c: OffscreenCanvas | HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/* ---------- dot cells: every mark on a 16 x 16 grid, one paper dot per cell sized by its ink (page3.js) */
const G = 16, SS = 8;
const cellsFrom = (inkAt: (x: number, y: number) => number, crisp?: number, g = G): Cells => {
  const cells: Cells = [];
  for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
    let sum = 0;
    for (let v = 0; v < SS; v++) for (let u = 0; u < SS; u++) sum += inkAt(i * SS + u, j * SS + v);
    const cov = sum / (SS * SS);
    if (crisp) { if (cov >= crisp) cells.push({ i, j, a: 1, r: 0.46 }); }
    else if (cov >= 0.06) cells.push({ i, j, a: 0.35 + 0.65 * clamp(cov * 1.6), r: 0.46 * clamp(cov * 1.8) ** 0.5 });
  }
  return cells;
};
const SHAPES: Record<string, { paths?: string[]; circles?: [number, number, number][] }> = {
  phone: { paths: ["M8.2 2.2h7.6a2.2 2.2 0 0 1 2.2 2.2v15.2a2.2 2.2 0 0 1-2.2 2.2H8.2A2.2 2.2 0 0 1 6 19.6V4.4a2.2 2.2 0 0 1 2.2-2.2z", "M12 11.4v5.8", "M12 15.2h2"], circles: [[12, 8.9, 2.3]] },
  ring: { circles: [[12, 12, 8.6]] },
};
const CELLS: Record<string, Cells> = {};
function shapeCells() {
  if (CELLS.phone) return;
  const N = G * SS, gc = canvas2d(N), gx = ctx2d(gc);
  for (const [k, gl] of Object.entries(SHAPES)) {
    gx.setTransform(1, 0, 0, 1, 0, 0); gx.clearRect(0, 0, N, N); gx.setTransform(N / 24, 0, 0, N / 24, 0, 0);
    gx.strokeStyle = "#fff"; gx.lineWidth = 2; gx.lineCap = gx.lineJoin = "round";
    for (const p of gl.paths ?? []) gx.stroke(new Path2D(p));
    for (const [cx, cy, r] of gl.circles ?? []) { gx.beginPath(); gx.arc(cx, cy, r, 0, 7); gx.stroke(); }
    const px = gx.getImageData(0, 0, N, N).data;
    CELLS[k] = cellsFrom((x, y) => (px[(y * N + x) * 4 + 3] ?? 0) / 255);
  }
}
/* a logo: drawn large, its ink found ("bg": a colour icon's mark against its own background), cropped, fit to the grid */
const loading: Record<string, Promise<void>> = {};
function logoCells(k: string): Promise<void> {
  const lg = LOGOS[k];
  if (!lg) return Promise.resolve();
  loading[k] ??= new Promise<void>((done) => {
    const img = new Image();
    img.onload = () => {
      try {
        const { fit, ink, crisp, grid, cut = 72, span = 110 } = lg;
        const S = 512, big = canvas2d(S), bx = ctx2d(big);
        bx.drawImage(img, 0, 0, S, S);
        const im = bx.getImageData(0, 0, S, S), d = im.data;
        if (ink === "bg") {
          const tally: Record<string, number> = {};
          for (let t = 0; t < 128; t++) {
            const a = (t / 128) * TAU, q = (Math.round(S / 2 + S * 0.42 * Math.sin(a)) * S + Math.round(S / 2 + S * 0.42 * Math.cos(a))) * 4;
            if ((d[q + 3] ?? 0) >= 128) { const key = [(d[q] ?? 0) >> 4, (d[q + 1] ?? 0) >> 4, (d[q + 2] ?? 0) >> 4].join(); tally[key] = (tally[key] || 0) + 1; }
          }
          const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
          const bg = (top ? top[0] : "0,0,0").split(",").map((v) => Number(v) * 16 + 8);
          for (let q = 0; q < d.length; q += 4) {
            d[q + 3] = (d[q + 3] ?? 0) * clamp((Math.abs((d[q] ?? 0) - (bg[0] ?? 0)) + Math.abs((d[q + 1] ?? 0) - (bg[1] ?? 0)) + Math.abs((d[q + 2] ?? 0) - (bg[2] ?? 0)) - cut) / span);
            d[q] = d[q + 1] = d[q + 2] = 255;
          }
          bx.putImageData(im, 0, 0);
        }
        let x0 = S, y0 = S, x1 = 0, y1 = 0;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if ((d[(y * S + x) * 4 + 3] ?? 0) > 24) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        const g = grid || G, n = g * SS, lc = canvas2d(n), lx = ctx2d(lc);
        const w = x1 - x0 + 1, h = y1 - y0 + 1, s = (n * fit) / Math.max(w, h);
        lx.drawImage(big, x0, y0, w, h, (n - w * s) / 2, (n - h * s) / 2, w * s, h * s);
        const px = lx.getImageData(0, 0, n, n).data;
        const cells = cellsFrom((x, y) => (px[(y * n + x) * 4 + 3] ?? 0) / 255, crisp, g);
        cells.g = g;
        CELLS[k] = cells;
      } catch {
        // a canvas that cannot be read draws this mark as nothing; the rest of the loop still runs
      }
      done();
    };
    img.onerror = () => done();
    img.src = lg.src;
  });
  return loading[k];
}

/* ---------- paths, measured by arc length */
const measure = (f: (u: number) => Pt): Path => {
  const n = 160, pts: Pt[] = [], len = [0];
  for (let i = 0; i <= n; i++) pts.push(f(i / n));
  for (let i = 1; i <= n; i++) len.push((len[i - 1] ?? 0) + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  const T = len[n] ?? 0;
  return { T, pts, at: (q: number) => {
    const s = clamp(q) * T; let lo = 0, hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if ((len[m] ?? 0) < s) lo = m; else hi = m; }
    const k = (s - (len[lo] ?? 0)) / ((len[hi] ?? 0) - (len[lo] ?? 0) || 1), a = pts[lo]!, b = pts[hi]!;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  } };
};
const line = (a: Pt, b: Pt) => measure((u) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }));
const quad = (a: Pt, c: Pt, b: Pt) => measure((u) => ({ x: (1 - u) ** 2 * a.x + 2 * u * (1 - u) * c.x + u * u * b.x, y: (1 - u) ** 2 * a.y + 2 * u * (1 - u) * c.y + u * u * b.y }));
const toward = (p: Pt, q: Pt, d: number): Pt => { const l = Math.hypot(q.x - p.x, q.y - p.y); return { x: p.x + ((q.x - p.x) / l) * d, y: p.y + ((q.y - p.y) / l) * d }; };

type Crowd = { r: number; th: number; m: number; k: number; ph: number; amp: number; s: number; a: number };
const crowdOf = (k0: number, n: number, r0: number, r1: number): Crowd[] => Array.from({ length: n }, (_, k) => {
  const h = (s: number) => hash(k + 1, k0, s), m = h(1) < 0.5 ? 1 : h(1) < 0.78 ? -1 : 2;
  return { r: r0 + (r1 - r0) * h(2), th: TAU * h(3), m, k: 1 + Math.floor(h(4) * 3), ph: TAU * h(5), amp: 2 + 3 * h(6), s: 1.6 + 0.9 * h(7), a: 0.28 + 0.45 * h(8) };
});
const crowdAt = (c: Pt, d: Crowd, t: number): Pt => { const th = d.th + (TAU * d.m * t) / L, r = d.r + d.amp * Math.sin((TAU * d.k * t) / L + d.ph); return { x: c.x + r * Math.cos(th), y: c.y + r * Math.sin(th) }; };
type Live = { path: Path; q: number; rev?: boolean; kind: "money" | "token" };

/* the drawing kit over one context in the 1600 x 900 frame */
function kit(ctx: CanvasRenderingContext2D) {
  const glyph = (kind: string, cx: number, cy: number, size: number, a: number, dot?: (i: number, j: number, x: number, y: number) => { x?: number; y?: number; a?: number; s?: number } | null) => {
    const cells = CELLS[kind]; if (!cells) return;
    const p = size / (cells.g || G);
    ctx.fillStyle = PAPER;
    for (const c of cells) {
      let x = cx - size / 2 + (c.i + 0.5) * p, y = cy - size / 2 + (c.j + 0.5) * p, al = c.a * a, rr = c.r * p;
      if (dot) { const d = dot(c.i, c.j, x, y); if (!d) continue; x = d.x ?? x; y = d.y ?? y; al *= d.a ?? 1; rr *= d.s ?? 1; }
      if (al <= 0.004 || rr <= 0.05) continue;
      ctx.globalAlpha = Math.min(1, al); ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  const dot = (x: number, y: number, r: number, a: number, col = PAPER) => { if (a <= 0.004) return; ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; };
  const ringDot = (x: number, y: number, a = 1) => { ctx.globalAlpha = a; ctx.strokeStyle = PAPER; ctx.lineWidth = 1.9; ctx.beginPath(); ctx.arc(x, y, 4.6, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; };
  /* dotted lines, brighter just behind anything moving on them */
  const dotted = (live: Live[], path: Path, base: number, r = 1.6, col = PAPER, gap = 9) => {
    const n = Math.max(2, Math.floor(path.T / gap));
    ctx.fillStyle = col;
    for (let k = 0; k <= n; k++) {
      const s = (k / n) * path.T; let lit = 0;
      for (const m of live) {
        if (m.path !== path) continue;
        const d = m.rev ? s - m.q * path.T : m.q * path.T - s;
        if (d >= 0 && d < 70) lit = Math.max(lit, (1 - d / 70) ** 2);
      }
      const p = path.at(k / n);
      ctx.globalAlpha = base + (0.8 - base) * lit;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * (1 + 0.35 * lit), 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  return { glyph, dot, ringDot, dotted };
}

/* ---------- slide 2: the posted loop, variant b (page3.js, unchanged but for the frame it draws into) */
function network(ctx: CanvasRenderingContext2D) {
  const { glyph, dot, ringDot, dotted } = kit(ctx);
  const C = { x: 800, y: 405 }, RX = 395, RY = 272, PH = { x: 800, y: 752 };
  const HUB = { size: 136, crowd: [78, 112] as const, n: 44 }, POOL = { size: 96, crowd: [54, 74] as const, n: 26 };
  const WOFF = 175, MOFF = 305, WS = 50, DY = 58, WR = 21, VS = 52, VSTEP = 64;
  const VENUES: Record<string, string[]> = { solana: ["pumpfun", "jupiter", "raydium", "meteora", "stonkfun"], base: ["uniswap", "aerodrome", "flaunch", "virtuals"], robinhood: ["uniswap", "bags", "pons"] };
  const SOL0 = C.y - 2 * VSTEP, VCOL: Record<string, { x: number; y0: number }> = { solana: { x: 104, y0: SOL0 }, base: { x: 104, y0: SOL0 + 5.6 * VSTEP } };
  type Spot = { id: string; deg: number; logo?: string; r?: number; side?: number; batch?: [number, number]; x: number; y: number; pool: boolean; v: { logo: string; x: number; y: number }[] };
  const NODES: Spot[] = ([
    { id: "bitcoin", deg: 270, logo: "bitcoin", r: 50 },
    { id: "ethereum", deg: 220, logo: "ethereum", r: 50 },
    { id: "solana", deg: 180, logo: "solana", side: -1, batch: [0.6, 3] },
    { id: "base", deg: 140, logo: "base", side: -1, batch: [7.2, 3] },
    { id: "sui", deg: 320, logo: "sui", r: 50 },
    { id: "robinhood", deg: 0, logo: "robinhood", side: 1, batch: [3.9, 3] },
    { id: "more", deg: 40, r: 60 },
  ] as Omit<Spot, "x" | "y" | "pool" | "v">[]).map((n) => {
    const a = (n.deg * Math.PI) / 180, x = C.x + RX * Math.cos(a), y = C.y + RY * Math.sin(a), pool = n.side !== undefined;
    const r = pool ? POOL.crowd[1] : n.r;
    const c = pool ? VCOL[n.id] ?? { x: x + (n.side ?? 1) * MOFF, y0: y - (((VENUES[n.id]?.length ?? 1) - 1) / 2) * VSTEP } : null;
    const v = c ? (VENUES[n.id] ?? []).map((logo, i) => ({ logo, x: c.x, y: c.y0 + i * VSTEP })) : [];
    return { ...n, r, x, y, pool, v };
  });
  const POOLS = NODES.filter((n) => n.pool);
  const SPOKE = Object.fromEntries(NODES.map((n) => [n.id, line(toward(C, n, HUB.crowd[1] + 12), toward(n, C, (n.r ?? 50) + 12))])) as Record<string, Path>;
  type Wallet = { n: Spot; w: Pt; ven: { logo: string; x: number; y: number }; seed: number; t0: number; toW: Path; toM: Path; ph: Record<string, [number, number]>; mk: number };
  const WALLETS: Wallet[] = [];
  POOLS.forEach((n, pi) => {
    const [b, k] = n.batch ?? [0, 2], dys = k === 3 ? [-DY, 0, DY] : [-DY / 2 - 6, DY / 2 + 6];
    dys.forEach((dy, i) => {
      const w = { x: n.x + (n.side ?? 1) * WOFF, y: n.y + dy }, h = (s: number) => hash(pi + 1, i + 1, s);
      const t0 = b - 0.45, buy = 0.75 + 0.3 * h(1), sell = 3.6 + 1.7 * h(2);
      const nv = n.v.length, ven = n.v[nv === 1 ? 0 : Math.round((i * (nv - 1)) / (dys.length - 1))]!;
      WALLETS.push({ n, w, ven, seed: pi * 3 + i + 1, t0, mk: 0,
        toW: line(toward(n, w, (n.r ?? 0) + 12), toward(w, n, WS / 2 + 8)), toM: line(toward(w, ven, WS / 2 + 8), toward(ven, w, VS / 2 + 6)),
        ph: { build: [0, 0.45], chunk: [0.35, 0.75], buy: [buy, buy + 0.3], fill: [buy + 0.3, buy + 0.6], sell: [sell, sell + 0.3], back: [sell + 0.3, sell + 0.6], home: [sell + 0.6, sell + 1.1], gone: [sell + 0.65, sell + 1.35] } });
    });
  });
  /* the phone's reach: a clear line to NEAR and a faint bow to every pool, the bow furthest from every other part */
  const KEEP = [{ id: "hub", x: C.x, y: C.y, r: HUB.crowd[1] + 5 }, ...NODES.map((n) => ({ id: n.id, x: n.x, y: n.y, r: (n.r ?? 0) + 5 })),
    ...WALLETS.map((v) => ({ id: v.n.id, ...v.w, r: WR + 4 })), ...POOLS.flatMap((n) => n.v.map((m) => ({ id: n.id, x: m.x, y: m.y, r: VS / 2 + 4 })))];
  const p0 = { x: PH.x, y: PH.y - 92 };
  const FAN: Path[] = [line(p0, { x: C.x, y: C.y + HUB.crowd[1] + 12 })];
  for (const n of POOLS) {
    const p1 = toward(n, p0, (n.r ?? 0) + 10), mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    const l = Math.hypot(p1.x - p0.x, p1.y - p0.y), nx = -(p1.y - p0.y) / l, ny = (p1.x - p0.x) / l;
    let best: { path: Path; clear: number } | null = null;
    for (const bow of [0, 40, -40, 70, -70]) {
      const path = quad(p0, { x: mx + nx * bow, y: my + ny * bow }, p1);
      let clear = 1e9;
      for (const k of KEEP) if (k.id !== n.id) for (const p of path.pts) clear = Math.min(clear, Math.hypot(p.x - k.x, p.y - k.y) - k.r);
      if (!best || clear > best.clear + 4) best = { path, clear };
    }
    if (best) FAN.push(best.path);
  }
  const CROWD: Record<string, Crowd[]> = { hub: crowdOf(1, HUB.n, ...HUB.crowd), more: crowdOf(9, 16, 24, 58) };
  POOLS.forEach((n, i) => { CROWD[n.id] = crowdOf(i + 2, POOL.n, ...POOL.crowd); });
  const TRIPS = [{ from: "ethereum", to: "solana", a: 0.75 }, { from: "bitcoin", to: "robinhood", a: 3.75 }, { from: "solana", to: "more", a: 5.5 }, { from: "sui", to: "base", a: 7.05 }, { from: "robinhood", to: "ethereum", a: 8.6 }];
  const TIN = 0.9, TOUT = 1.35, TEND = 2.25;

  return (t: number) => {
    t = mod(t, L);
    const live: Live[] = [], glow: Record<string, number> = Object.fromEntries(NODES.map((n) => [n.id, 0]));
    const PR = L / 4, ph = mod(t, PR) / PR, kp = ph < 0.8 ? 0 : Math.sin((Math.PI * (ph - 0.8)) / 0.2) ** 2;
    glow.hub = 0.6 * kp;
    for (const v of WALLETS) {
      const tau = mod(t - v.t0, L), P = v.ph, on = (k: string) => tau >= P[k]![0] && tau <= P[k]![1], u = (k: string) => ease((tau - P[k]![0]) / (P[k]![1] - P[k]![0]));
      if (on("chunk")) live.push({ path: v.toW, q: u("chunk"), kind: "money" });
      if (on("buy")) live.push({ path: v.toM, q: u("buy"), kind: "money" });
      if (on("fill")) live.push({ path: v.toM, q: 1 - u("fill"), rev: true, kind: "token" });
      if (on("sell")) live.push({ path: v.toM, q: u("sell"), kind: "token" });
      if (on("back")) live.push({ path: v.toM, q: 1 - u("back"), rev: true, kind: "money" });
      if (on("home")) live.push({ path: v.toW, q: 1 - u("home"), rev: true, kind: "money" });
      glow[v.n.id] = Math.max(glow[v.n.id] ?? 0, bump(tau, P.chunk![0], 0.4), bump(tau, P.home![1], 0.4));
      v.mk = Math.max(bump(tau, P.buy![1], 0.3), bump(tau, P.sell![1], 0.3));
    }
    for (const tr of TRIPS) {
      const s = mod(t - tr.a, L);
      if (s < TIN) live.push({ path: SPOKE[tr.from]!, q: 1 - ease(s / TIN), rev: true, kind: "money" });
      else if (s >= TOUT && s < TEND) live.push({ path: SPOKE[tr.to]!, q: ease((s - TOUT) / (TEND - TOUT)), kind: "money" });
      glow.hub = Math.max(glow.hub ?? 0, bump(s, TIN, 0.45), bump(s, TOUT, 0.45));
      glow[tr.from] = Math.max(glow[tr.from] ?? 0, bump(s, 0, 0.4));
      glow[tr.to] = Math.max(glow[tr.to] ?? 0, bump(s, TEND, 0.4));
    }
    dotted(live, FAN[0]!, 0.62 + 0.38 * kp, 2.2 + 0.4 * kp, PAPER, 8);
    for (const f of FAN.slice(1)) dotted(live, f, 0.1, 1.3, SOFT, 12);
    for (const n of NODES) dotted(live, SPOKE[n.id]!, 0.24);
    for (const v of WALLETS) { dotted(live, v.toW, 0.13, 1.4); dotted(live, v.toM, 0.13, 1.4); }
    glyph("phone", PH.x, PH.y, 118, 0.9 + 0.1 * kp);
    for (let k = 0; k < 48; k++) {
      const f = k / 48, th = -Math.PI / 2 + TAU * f, lit = clamp((ph / 0.8 - f) * 48), fade = ph < 0.8 ? 1 : 1 - ease((ph - 0.8) / 0.2);
      dot(PH.x + 80 * Math.cos(th), PH.y + 80 * Math.sin(th), 1.7, 0.12 + 0.55 * lit * fade);
    }
    for (const d of CROWD.hub!) { const p = crowdAt(C, d, t); dot(p.x, p.y, d.s, d.a * (1 + 0.45 * (glow.hub ?? 0))); }
    glyph("near", C.x, C.y, HUB.size, 0.88 + 0.12 * (glow.hub ?? 0));
    for (const n of NODES) {
      const gl = glow[n.id] ?? 0;
      if (n.pool) for (const d of CROWD[n.id]!) { const p = crowdAt(n, d, t); dot(p.x, p.y, d.s, d.a * (1 + 0.5 * gl)); }
      if (n.logo) glyph(n.logo, n.x, n.y, n.pool ? POOL.size : 88, 0.84 + 0.16 * gl);
      if (n.id === "more") {
        for (const d of CROWD.more!) { const p = crowdAt(n, d, t); dot(p.x, p.y, d.s * 0.8, d.a * 0.75 * (1 + 0.5 * gl)); }
        for (let k = -1; k <= 1; k++) dot(n.x + k * 19, n.y, 5.6, 0.8 + 0.2 * gl);
      }
    }
    for (const n of POOLS) for (const m of n.v) glyph(m.logo, m.x, m.y, VS, 0.6 + 0.4 * Math.max(0, ...WALLETS.filter((v) => v.ven === m).map((v) => v.mk)));
    for (const v of WALLETS) {
      const tau = mod(t - v.t0, L), P = v.ph, { x, y } = v.w;
      if (tau > P.gone![1]) continue;
      if (tau < P.build![1] + 0.12) glyph("ring", x, y, WS, 0.95, (i, j) => { const u = clamp((tau - hash(i, j, v.seed) * 0.33) / 0.12); return u <= 0 ? null : { a: u, s: 0.6 + 0.4 * u }; });
      else if (tau < P.gone![0]) glyph("ring", x, y, WS, 0.95);
      else glyph("ring", x, y, WS, 0.95, (i, j, gx, gy) => {
        const u = clamp((tau - P.gone![0] - hash(j, i, v.seed) * 0.25) / 0.45), e = ease(u);
        return { x: gx + (gx - x) * 0.7 * e, y: gy + (gy - y) * 0.7 * e, a: (1 - u) ** 1.6, s: 1 - 0.45 * e };
      });
      if ((tau >= P.chunk![1] && tau < P.buy![0]) || (tau >= P.back![1] && tau < P.home![0])) dot(x, y, 5.2, 1);
      else if (tau >= P.fill![1] && tau < P.sell![0]) ringDot(x, y);
    }
    for (const m of live) { const p = m.path.at(m.q); if (m.kind === "money") dot(p.x, p.y, 5.2, 1); else ringDot(p.x, p.y); }
  };
}

/* ---------- slide 3: any chain in, Cash on NEAR, any chain out. Each move goes in along one spoke, rests in the crowd,
   and leaves along another, the network's own trip */
function flow(ctx: CanvasRenderingContext2D) {
  const { glyph, dot, dotted } = kit(ctx);
  const C = { x: 800, y: 450 }, HUB = { size: 136, crowd: [78, 112] as const, n: 44 }, SIZE = 80, R = 46;
  // the columns stay left of x 1370 at the top, the corner the close button covers (the frame's top right, every width)
  const col = (ids: string[], x: number) => ids.map((id, i) => ({ id, x, y: 170 + i * 112, logo: id === "more" ? undefined : id }));
  const IN = col(["bitcoin", "ethereum", "solana", "base", "sui", "more"], 280), OUT = col(["arbitrum", "bsc", "robinhood", "avalanche", "monad", "more"], 1320);
  const ALL = [...IN.map((n) => ({ ...n, key: `in-${n.id}` })), ...OUT.map((n) => ({ ...n, key: `out-${n.id}` }))];
  const SPOKE = Object.fromEntries(ALL.map((n) => [n.key, line(toward(C, n, HUB.crowd[1] + 12), toward(n, C, R + 12))])) as Record<string, Path>;
  const CROWD = { hub: crowdOf(1, HUB.n, ...HUB.crowd), mi: crowdOf(9, 14, 22, 50), mo: crowdOf(10, 14, 22, 50) };
  const TRIPS = [["bitcoin", "robinhood", 0.2], ["ethereum", "arbitrum", 1.85], ["solana", "bsc", 3.5], ["base", "avalanche", 5.15], ["sui", "monad", 6.8], ["more", "more", 8.45]] as const;
  const TIN = 0.9, TOUT = 1.35, TEND = 2.25;
  return (t: number) => {
    t = mod(t, L);
    const live: Live[] = [], glow: Record<string, number> = { hub: 0 };
    for (const [from, to, a] of TRIPS) {
      const s = mod(t - a, L), fk = `in-${from}`, tk = `out-${to}`;
      if (s < TIN) live.push({ path: SPOKE[fk]!, q: 1 - ease(s / TIN), rev: true, kind: "money" });
      else if (s >= TOUT && s < TEND) live.push({ path: SPOKE[tk]!, q: ease((s - TOUT) / (TEND - TOUT)), kind: "money" });
      glow.hub = Math.max(glow.hub ?? 0, bump(s, TIN, 0.45), bump(s, TOUT, 0.45));
      glow[fk] = Math.max(glow[fk] ?? 0, bump(s, 0, 0.4));
      glow[tk] = Math.max(glow[tk] ?? 0, bump(s, TEND, 0.4));
    }
    for (const n of ALL) dotted(live, SPOKE[n.key]!, 0.24);
    for (const d of CROWD.hub) { const p = crowdAt(C, d, t); dot(p.x, p.y, d.s, d.a * (1 + 0.45 * (glow.hub ?? 0))); }
    glyph("near", C.x, C.y, HUB.size, 0.88 + 0.12 * (glow.hub ?? 0));
    for (const n of ALL) {
      const gl = glow[n.key] ?? 0;
      if (n.logo) glyph(n.logo, n.x, n.y, SIZE, 0.84 + 0.16 * gl);
      else {
        for (const d of n.key.startsWith("in") ? CROWD.mi : CROWD.mo) { const p = crowdAt(n, d, t); dot(p.x, p.y, d.s * 0.8, d.a * 0.75 * (1 + 0.5 * gl)); }
        for (let k = -1; k <= 1; k++) dot(n.x + k * 17, n.y, 5, 0.8 + 0.2 * gl);
      }
    }
    for (const m of live) { const p = m.path.at(m.q); dot(p.x, p.y, 5.2, 1); }
  };
}

/* ---------- slide 4: twelve word slots filled in turn, the way a backup is written down; never a real word. Sized to
   read on the 520 px desktop card (the frame at about a third): slots fill the frame's width, outlines and numbers bold */
function words(ctx: CanvasRenderingContext2D, font: string) {
  const { dot } = kit(ctx);
  // the grid starts below y 225, clear of the close button in the frame's top right
  const SW = 344, SH = 140, GX = 34, GY = 32, X0 = (W - (4 * SW + 3 * GX)) / 2, Y0 = (H - (3 * SH + 2 * GY)) / 2 + 36;
  const SLOTS = Array.from({ length: 12 }, (_, k) => ({ k, x: X0 + (k % 4) * (SW + GX), y: Y0 + Math.floor(k / 4) * (SH + GY), n: 4 + Math.floor(hash(k + 1, 3, 7) * 5) }));
  const START = 0.5, STEP = 0.62, WRITE = 0.5, HOLD = 9.0, FADE = 0.8;
  const outline = (x: number, y: number, w: number, h: number, a: number) => {
    const r = 24, gap = 13, per = 2 * (w + h - 4 * r) + TAU * r, n = Math.floor(per / gap);
    for (let k = 0; k < n; k++) {
      let s = (k / n) * per, px = 0, py = 0;
      const seg = [w - 2 * r, (Math.PI / 2) * r, h - 2 * r, (Math.PI / 2) * r, w - 2 * r, (Math.PI / 2) * r, h - 2 * r, (Math.PI / 2) * r];
      let i = 0; while (i < seg.length && s > seg[i]!) { s -= seg[i]!; i++; }
      const arc = (cx: number, cy: number, a0: number) => { const an = a0 + s / r; px = cx + r * Math.cos(an); py = cy + r * Math.sin(an); };
      if (i === 0) { px = x + r + s; py = y; } else if (i === 1) arc(x + w - r, y + r, -Math.PI / 2);
      else if (i === 2) { px = x + w; py = y + r + s; } else if (i === 3) arc(x + w - r, y + h - r, 0);
      else if (i === 4) { px = x + w - r - s; py = y + h; } else if (i === 5) arc(x + r, y + h - r, Math.PI / 2);
      else if (i === 6) { px = x; py = y + h - r - s; } else arc(x + r, y + r, Math.PI);
      dot(px, py, 2.8, a);
    }
  };
  return (t: number) => {
    t = mod(t, L);
    const fade = t < HOLD ? 1 : 1 - ease((t - HOLD) / FADE);
    ctx.font = `400 44px ${font}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (const s of SLOTS) {
      const t0 = START + s.k * STEP, u = t >= HOLD + FADE ? 0 : clamp((t - t0) / WRITE), writing = u > 0 && u < 1;
      outline(s.x, s.y, SW, SH, writing ? 0.9 : u >= 1 ? 0.45 * fade + 0.3 * (1 - fade) : 0.3);
      ctx.globalAlpha = 0.62; ctx.fillStyle = SOFT; ctx.fillText(String(s.k + 1).padStart(2, "0"), s.x + 34, s.y + SH / 2 + 2); ctx.globalAlpha = 1;
      for (let i = 0; i < s.n; i++) {
        const on = clamp(u * s.n - i), x = s.x + 128 + i * 26, y = s.y + SH / 2;
        dot(x, y, 3.2, 0.2);
        if (on > 0) dot(x, y, 3.2 + 3.4 * ease(on), ease(on) * fade);
      }
    }
  };
}

/** Draws `scene` into `canvas` until the returned stop is called. `still`: one frame, no motion (reduced motion). */
export function startLoop(canvas: HTMLCanvasElement, scene: Scene, { still = false }: { still?: boolean } = {}): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let stopped = false, raf = 0, draw: ((t: number) => void) | null = null, k = 1, ox = 0, oy = 0, visible = true;
  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    k = Math.min(canvas.width / W, canvas.height / H); ox = (canvas.width - W * k) / 2; oy = (canvas.height - H * k) / 2;
  };
  const paint = (t: number) => {
    if (!draw) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, ox, oy); draw(t);
  };
  // the still frame (reduced motion): the loop mid-trip; on slide 4, all twelve slots written
  const t0 = performance.now(), STILL_AT = scene === "words" ? 8.4 : 4.6;
  const tick = (now: number) => { if (stopped) return; if (visible && !document.hidden) paint((now - t0) / 1000); raf = requestAnimationFrame(tick); };
  const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { fit(); if (still) paint(STILL_AT); }) : null;
  ro?.observe(canvas);
  const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }) : null;
  io?.observe(canvas);
  fit();
  shapeCells();
  void Promise.all(NEED[scene].map(logoCells)).then(() => {
    if (stopped) return;
    const font = getComputedStyle(canvas).getPropertyValue("--font-num").trim() || "ui-monospace, monospace";
    draw = scene === "network" ? network(ctx) : scene === "flow" ? flow(ctx) : words(ctx, font);
    // the first frame at once, on screen or not, so a canvas never shows empty while its observer settles
    if (still) paint(STILL_AT);
    else {
      paint((performance.now() - t0) / 1000);
      raf = requestAnimationFrame(tick);
    }
  });
  return () => { stopped = true; cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect(); };
}
