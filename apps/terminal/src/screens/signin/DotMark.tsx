import { BOX, DOTS, glow, SWEEP_S } from "./dots.ts";
import type { RestoreMark } from "./model.ts";

// The restore notice's mark (dots.ts): running, a lit arc sweeps the disc dot by dot (each dot runs one keyframe loop
// started at its place, so the arc never cuts a dot in half); with reduced motion the arc rests where it starts. Done,
// the dots along the tick swell and turn green, drawn at once (no transition). Nothing found, the disc rests grey.
// Offline, the sweep stops: the disc and its resting arc turn amber.
const key = (x: number, y: number) => `${x},${y}`;

export function DotMark({ kind }: { kind: RestoreMark }) {
  const arc = kind === "run" || kind === "off";
  return (
    <span className={`rn-mark ${kind}`} data-mark={kind} aria-hidden="true">
      <svg viewBox={`0 0 ${BOX} ${BOX}`}>
        <g className="rn-base">{DOTS.map((p) => (kind === "done" && p.tick ? null : <circle key={key(p.x, p.y)} cx={p.x} cy={p.y} r={p.r} />))}</g>
        {kind === "done" && (
          <g className="rn-tick">
            {DOTS.filter((p) => p.tick).map((p) => (
              <circle key={key(p.x, p.y)} cx={p.x} cy={p.y} r={p.tick} />
            ))}
          </g>
        )}
        {arc && (
          <g className="rn-arc">
            {DOTS.map((p) => (
              <circle key={key(p.x, p.y)} cx={p.x} cy={p.y} r={Math.min(1.7, p.r * 1.7)} style={{ opacity: glow(p.phase), animationDelay: `${(-p.phase * SWEEP_S).toFixed(3)}s` }} />
            ))}
          </g>
        )}
      </svg>
    </span>
  );
}
