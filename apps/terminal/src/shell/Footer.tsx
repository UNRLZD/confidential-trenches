import { useEffect, useState } from "react";
import { Link } from "react-router";
import { WORDS } from "../screens/verify/words.ts";
import { buildNetwork } from "../screens/verify/release.ts";
import eth from "./coins/eth.svg";
import sol from "./coins/sol.svg";
import { BLOCK_EVERY_MS, FOOTER_LINKS, FOOTER_WORDS, fmtBlock, fmtUsd, footerRpcs, footerTicks, nextConn, readFinalBlock, type Conn } from "./footer.ts";
import { useSignpage } from "./signpage-frame.tsx";

// The desktop footer as R5 draws it (design/proto/assets/app.js:375-385 at design-lock-r5): the prices, the connection
// and the block, the page links, the Verify pill (09-design-brief S1.19, S18; it names the panel, not a state, card
// app-verify-mount). What each shows and where it is read is footer.ts (card app-footer-bar). R5's Anon pill is retired
// (M184, M185).
const LOGO = { SOL: sol, ETH: eth } as const;
const w = (k: keyof typeof FOOTER_WORDS) => {
  const word = FOOTER_WORDS[k];
  return word.draft ? <span data-draft-copy>{word.text}</span> : word.text;
};

/** The block read every BLOCK_EVERY_MS while the page shows, on the build's network's pair. */
function useConnection(): Conn {
  const [conn, setConn] = useState<Conn>({ kind: "wait" });
  useEffect(() => {
    const rpcs = footerRpcs(buildNetwork());
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) {
        const read = await readFinalBlock(rpcs);
        if (!alive) return;
        setConn((c) => nextConn(c, read));
      }
      if (alive) timer = setTimeout(tick, BLOCK_EVERY_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return conn;
}

export function Footer() {
  const { snapshot } = useSignpage();
  const conn = useConnection();
  // drawn again on each block read, so a price past its bound leaves within one read
  const ticks = footerTicks(snapshot.state?.pools, Date.now());
  const height = conn.kind === "wait" ? null : conn.height;
  return (
    <footer className="ft">
      <span className="ticks">
        {ticks.map((t) => (
          <span key={t.sym} className="tick" data-tick={t.sym}>
            <img src={LOGO[t.sym]} alt="" />
            {t.sym} {fmtUsd(t.usd)}
          </span>
        ))}
      </span>
      {conn.kind !== "wait" && (
        <span className={conn.kind === "on" ? "health" : "health off"} data-conn={conn.kind}>
          <span className="d" />
          {conn.kind === "on" ? w("stable") : w("offline")}
        </span>
      )}
      <span className="conn">
        {w("connection")} {conn.kind === "on" ? `${conn.ms} ms` : "—"}
      </span>
      <span className="links">
        <span data-block={height ?? ""}>
          {w("block")} {height === null ? "—" : fmtBlock(height)}
        </span>
        <Link to={FOOTER_LINKS.terms}>{w("terms")}</Link>
        <Link to={FOOTER_LINKS.privacy}>{w("privacy")}</Link>
      </span>
      <Link to={FOOTER_LINKS.verify} className="pill" data-control="verify">{WORDS.title.text}</Link>
    </footer>
  );
}
