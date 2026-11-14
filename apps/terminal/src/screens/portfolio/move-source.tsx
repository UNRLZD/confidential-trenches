import type { SignpageKind } from "@blindfill/kit";
import { createContext, useContext, useMemo } from "react";
import { useSignpage } from "../../shell/signpage-frame.tsx";
import { MOVE_DRY_KIND, MOVE_KIND, moveShips, readDry, readLimits } from "./move.ts";
import type { MoveDry, MoveLimits, MoveParams } from "./move.ts";

// What the move sheet asks of the signing page (card portfolio-moves-money-between-chains): pool.move.dry's price and
// pool.move itself, whose op then comes in state.ops under the request's id. The screen's tests pass recorded answers
// through MoveSourceProvider; the live app's source is the kit's client, and only once the kit names both kinds
// (moveShips): until then `ships` is false and Portfolio draws no Move.

// An amount the move cannot send is answered with what it can (kit 1.16, card move-sends-what-it-shows): `limits`.
export type DryAnswer = { kind: "ok"; value: MoveDry } | { kind: "limits"; value: MoveLimits } | { kind: "refused"; code: string };

export interface MoveSource {
  ships: boolean;
  dry(p: MoveParams): Promise<DryAnswer>;
  /** Starts the move: its op id at once; `refused` the page's code when it would not start it. */
  start(p: MoveParams): { id: string; outcome: Promise<string | null> };
}

const Fixture = createContext<MoveSource | null>(null);
export const MoveSourceProvider = Fixture.Provider;

const OFF: MoveSource = {
  ships: false,
  dry: async () => ({ kind: "refused", code: "not_allowed" }),
  start: () => ({ id: "", outcome: Promise.resolve("not_allowed") }),
};

export function useMoveSource(): MoveSource {
  const fixture = useContext(Fixture);
  const { client } = useSignpage();
  return useMemo(() => {
    if (fixture) return fixture;
    if (!client || !moveShips()) return OFF;
    // the kinds are the kit's once moveShips() holds; the cast only names them before the kit's types do
    const ask = (kind: string, p: MoveParams) => client.request(kind as SignpageKind, p as never);
    return {
      ships: true,
      dry: async (p) => {
        const o = await ask(MOVE_DRY_KIND, p).outcome;
        if (!o.ok) return { kind: "refused", code: o.error.code };
        const v = readDry(o.result);
        if (v) return { kind: "ok", value: v };
        const l = readLimits(o.result);
        return l ? { kind: "limits", value: l } : { kind: "refused", code: "quote_check_failed" };
      },
      start: (p) => {
        const h = ask(MOVE_KIND, p);
        return { id: h.id, outcome: h.outcome.then((o) => (o.ok ? null : o.error.code)) };
      },
    } satisfies MoveSource;
  }, [fixture, client]);
}
