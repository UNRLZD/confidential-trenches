import type { ComponentType } from "react";
import { TokenRoute } from "../screens/token/TokenPage.tsx";
import type { RouteId } from "./routes.ts";

// The route map: the screen each route draws. A route its card has not filled yet draws an empty main.
const SCREENS: Partial<Record<RouteId, ComponentType>> = {
  token: TokenRoute,
};

export function Screen({ id }: { id: RouteId }) {
  const S = SCREENS[id];
  return (
    <main className="screen" data-route={id}>
      {S && <S />}
    </main>
  );
}
