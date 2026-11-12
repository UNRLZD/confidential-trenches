// A token's own links (its site, X and Telegram) as its list source gives them: Jupiter's `website`, `twitter` and
// `telegram` on Solana. The token page's answer carries them (`links`, solana/token.ts toPage), each only when the
// source has it, never made up. A link is a stranger's text (the token's creator writes it): taken only as an http(s)
// URL to a DNS name with no credentials, at most LINK_MAX characters, X only on x.com or twitter.com and Telegram only
// on t.me or telegram.me. The helper never fetches one; the app draws it as a link its user may open.
export const LINK_MAX = 300;
export const LINKS_MAX = 20_000;
export type Links = { site?: string; x?: string; telegram?: string };

function url(raw: unknown, hosts?: readonly string[]): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > LINK_MAX) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username !== "" || u.password !== "") return undefined;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return undefined; // a DNS name, never an IP literal
  if (hosts !== undefined && !hosts.some((h) => host === h || host === `www.${h}`)) return undefined;
  return u.href.length > LINK_MAX ? undefined : u.href;
}

/** The links a source row gives, each checked, only those that pass. */
export function linksOf(site: unknown, x: unknown, telegram: unknown): Links {
  const out: Links = {};
  const s = url(site);
  const t = url(x, ["x.com", "twitter.com"]);
  const g = url(telegram, ["t.me", "telegram.me"]);
  if (s !== undefined) out.site = s;
  if (t !== undefined) out.x = t;
  if (g !== undefined) out.telegram = g;
  return out;
}

/** The helper's one registry: the list builders and the token page's search row remember a token's links. */
export function createLinks() {
  const held = new Map<string, Links>();
  return {
    remember(chain: string, token: string, l: Links): void {
      const k = `${chain}:${token}`;
      held.delete(k);
      if (Object.keys(l).length === 0) return;
      if (held.size >= LINKS_MAX) held.delete(held.keys().next().value!);
      held.set(k, l);
    },
    of(chain: string, token: string): Links {
      return { ...(held.get(`${chain}:${token}`) ?? {}) };
    },
  };
}
export const LINKS = createLinks();
