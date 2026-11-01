import type { RouteId } from "./routes.ts";

// An empty screen: its card draws what goes in it.
export function Screen({ id }: { id: RouteId }) {
  return <main className="screen" data-route={id} />;
}
