import { bps as bpsOf, held, nearCents, pct, units, usd } from "../portfolio/model.ts";
import type { Row } from "../portfolio/model.ts";
import { busy } from "../trade/model.ts";
import { pctLabel, QUICK, sellAmount, WHOLE } from "./model.ts";
import type { Sell } from "./source.tsx";
import { W } from "./W.tsx";
import "./positions.css";

// Your position (A2.4, app.md:1449 at research; 09-design-brief S8 "Your position": the PnL hero with a % pill,
// `Holding`, `Bought`, `Sold`, `Realized`, quick sells `25%` `50%` `All` `Initials`, `Share`), drawn after R5's panel
// (design/proto at design-lock-r5: assets/token.js U.position; unrlzd.css .tk-pos*, .tk-quick, .tk-share). Its rows are
// Portfolio's own Row (src/screens/portfolio/model.ts: the kit's amount and cost with the market's price and this
// browser's bought, sold and realized), so the token page and Portfolio show one number. A quick sell runs the same
// `useSell` as the trade box's sell side: one click, no confirm, one request for a double tap; the box's main button
// shows its state and the one that fired stays lit while it runs. Share goes to the mount.

const ShareIc = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 10V2M5 5l3-3 3 3M3 9v4.5h10V9" /></svg>
);

/** A USD price per token, display only: up to 4 significant digits, never an exponent ("$0.0001823", "$1.25"). */
function price(costCents: bigint, amount: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const p = Number(costCents) / 100 / n;
  return `$${p.toLocaleString("en-US", { maximumSignificantDigits: 4, maximumFractionDigits: 20 })}`;
}

/** A tone from an exact figure (its sign, never the rounded cents): an exact zero neutral (no tone). */
const tone = (x: bigint | null) => (x === null || x === 0n ? undefined : String(x > 0n));

export function PositionPanel({ row, s, now, onShare }: { row: Row; s: Sell; now: number; onShare?: () => void }) {
  // the row's decimals, the signing page's, never the helper's (card app-sell-mount re-check 2)
  const decimals = row.decimals;
  const running = busy(s.phase);
  const noRoute = row.mark === "noRoute";
  // the PnL and the realized part, exact, to the nearest cent; its percent from the exact figures
  const totalX = row.valueX === null || row.costX === null ? null : row.valueX - row.costX + row.realizedX;
  const total = totalX === null ? null : nearCents(totalX);
  const totalBps = totalX === null || row.costX === null ? null : bpsOf(totalX, row.costX);
  const up = tone(row.pnlSign);

  return (
    <div className="tk-panel tk-position" data-testid="position-panel" data-state={s.phase.k}>
      <div className="tk-posHead">
        <span><W id="yourPosition" /></span>
      </div>
      <div className="tk-posHero" data-up={up}>
        <div className="tk-posHeroTop">
          <span className="tk-posLabel"><W id="unrealizedPnl" /></span>
          {onShare && (
            <button type="button" className="tk-share" data-testid="position-share" onClick={onShare}>
              <ShareIc />
              <W id="share" />
            </button>
          )}
        </div>
        <div className="tk-posHeroMain">
          <span className="tk-posHeroVal" data-testid="position-pnl">{row.pnl === null ? "—" : usd(row.pnl, true)}</span>
          <span className="tk-posHeroPct">{pct(row.pnlBps)}</span>
        </div>
        <span className="tk-posHeroUsd">{row.value === null ? "—" : usd(row.value)}</span>
      </div>
      <div className="tk-posRows">
        <div className="tk-posRow" data-testid="pos-bought"><span className="tk-posLabel"><W id="bought" /></span><span className="tk-posVal">{row.bought === null ? "—" : usd(row.bought)}</span><span className="tk-posUsd" /></div>
        <div className="tk-posRow" data-testid="pos-sold"><span className="tk-posLabel"><W id="sold" /></span><span className="tk-posVal">{usd(row.sold)}</span><span className="tk-posUsd" /></div>
        <div className="tk-posRow" data-testid="pos-holding"><span className="tk-posLabel"><W id="holding" /></span><span className="tk-posVal" data-unread={row.value === null || undefined}>{row.value === null ? "—" : usd(row.value)}</span><span className="tk-posUsd">{units(row.units)} {row.symbol}</span></div>
        <div className="tk-posRow" data-testid="pos-realized"><span className="tk-posLabel"><W id="realized" /></span><span className="tk-posVal" data-tone={tone(row.realizedX)}>{usd(row.realized, true)}</span><span className="tk-posUsd" /></div>
        <div className="tk-posRule" />
        <div className="tk-posRow" data-testid="pos-total"><span className="tk-posLabel"><W id="totalPnl" /></span><span className="tk-posVal" data-tone={tone(totalX)}>{total === null ? "—" : usd(total, true)}</span><span className="tk-posUsd">{pct(totalBps)}</span></div>
      </div>
      <div className="tk-posMeta">
        <div data-testid="pos-entry"><span className="tk-posLabel"><W id="avgEntry" /></span><span className="tk-posMetaVal">{row.cost === null ? "—" : price(row.cost, row.units)}</span></div>
        <div data-testid="pos-held"><span className="tk-posLabel"><W id="heldFor" /></span><span className="tk-posMetaVal">{row.openedAt === null ? "—" : held(now - row.openedAt)}</span></div>
      </div>
      <div className="tk-quick" data-testid="position-quick">
        {QUICK.map((q) => {
          // Initials from the exact cost and value (rowOf), never from the rounded cents: it is the share the device signs
          const b = q === "initials" ? row.initials : q;
          const amount = b === null ? null : sellAmount(row.units, b, decimals);
          const live = running && b !== null && s.bps === b;
          const off = !s.ready || running || noRoute || amount === null;
          return (
            <button
              key={String(q)}
              type="button"
              data-quick={q === "initials" ? "initials" : q}
              data-bps={b ?? undefined}
              data-live={live || undefined}
              disabled={off}
              onClick={() => !off && s.sell(amount, b!, decimals)}
            >
              {q === "initials" ? <W id="initials" /> : q === WHOLE ? <W id="all" /> : pctLabel(q)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
