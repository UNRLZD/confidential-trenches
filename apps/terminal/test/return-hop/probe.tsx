// The return-hop browser run's build (run.mjs): the app's own start, shell, signing page client and hop, with a probe
// screen on every route in place of the empty screens: a sheet, a field and one control per open kind, each opening its
// kind through useReturnHop() exactly as a screen does. Its state is in data attributes for the run to read. Test only.
import "@blindfill/kit";
import type { Chain } from "@blindfill/kit";
import { useState } from "react";
import type { RouteId } from "../../src/routes/routes.ts";
import { useReturnHop } from "../../src/shell/ReturnHop.tsx";
import type { HopStart } from "../../src/shell/ReturnHop.tsx";
import { start } from "../../src/shell/start.tsx";
import "./probe.css";

type Hop = ReturnType<typeof useReturnHop>["hop"];
const SOLANA: Chain = "solana";
const CONTROLS = [
  { control: "hop-signin", go: (h: Hop, v: HopStart) => h("signin.open", { way: "passkey" }, v) },
  { control: "hop-backup", go: (h: Hop, v: HopStart) => h("backup.open", {}, v) },
  { control: "hop-export", go: (h: Hop, v: HopStart) => h("export.open", { chain: SOLANA, address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }, v) },
  { control: "hop-signout", go: (h: Hop, v: HopStart) => h("signout", {}, v) },
  { control: "hop-withdraw", go: (h: Hop, v: HopStart) => h("withdraw.open", {}, v) },
];

function Probe({ id }: { id: RouteId }) {
  const { hop, locked, restored } = useReturnHop();
  const r = restored?.route === id ? restored : null;
  const [sheet, setSheet] = useState<string | null>(r?.sheet ?? null);
  const [note, setNote] = useState(r?.fields.note ?? "");
  const [error, setError] = useState("");
  return (
    <main className="screen probe" data-route={id} data-sheet={sheet ?? ""} data-note={note} data-locked={locked ?? ""} data-restored={r?.control ?? ""} data-error={error}>
      <button type="button" data-open-sheet onClick={() => setSheet("probe-sheet")}>
        sheet
      </button>
      {sheet && <input data-note-input value={note} onChange={(e) => setNote(e.target.value)} />}
      {/* the controls sit below the fold, so a tap on one is made with the page scrolled */}
      <div className="tall" />
      {CONTROLS.map((c) => (
        <button
          key={c.control}
          type="button"
          data-control={c.control}
          disabled={locked === c.control}
          onClick={async () => {
            const o = await c.go(hop, { route: id, sheet, control: c.control, fields: sheet ? { note } : {} });
            if (o && !o.ok) setError(o.error.code);
          }}
        >
          {c.control}
        </button>
      ))}
      <div className="tall" />
    </main>
  );
}

start(Probe);
