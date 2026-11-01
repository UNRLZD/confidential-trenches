// One route per screen (master v21, App lead lanes). Each is empty until its own card fills it; `id` is what the
// screen's <main data-route> carries, so a check can tell a route that rendered from the fallback.
export type RouteId = "token" | "discover" | "portfolio" | "orders" | "profile" | "verify" | "privacy" | "terms";

export const ROUTES: readonly { id: RouteId; path: string }[] = [
  { id: "token", path: "/" },
  { id: "discover", path: "/discover" },
  { id: "portfolio", path: "/portfolio" },
  { id: "orders", path: "/orders" },
  { id: "profile", path: "/profile" },
  { id: "verify", path: "/verify" },
  { id: "privacy", path: "/privacy" },
  { id: "terms", path: "/terms" },
];
