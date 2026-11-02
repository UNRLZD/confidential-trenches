// Verify's live read (card app-verify-mount): readVerify on the release's pair for the build's network, then verifyView of
// what this call read. Nothing is kept between calls, so the panel never draws an earlier read as live. A pair the rule
// refuses (or the other network's pair), no final height on either RPC, or no vault named on the network draws every
// check Unverified (unverifiedView); a refusal's or a failure's reason goes to the console only.
import { nearPairNetwork, nearPairRule, type VaultSyncRpc } from "@blindfill/kit";
import { unverifiedView, verifyView, type VerifyView } from "./model.ts";
import { readVerify } from "./read.ts";
import type { VerifyRelease } from "./release.ts";

/** How long one read may take; a read past it fails like any other (its check is Unverified). The kit's nearRpc's. */
export const VERIFY_READ_MS = 10_000;

/** One NEAR RPC by its URL: a JSON-RPC `query`; a status other than 200, a body that is not JSON or no answer in time throws. */
export function verifyRpc(url: string, fetchFn: typeof fetch = fetch): VaultSyncRpc {
  return {
    name: url,
    async query(params, signal) {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method: "query", params }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(VERIFY_READ_MS)]) : AbortSignal.timeout(VERIFY_READ_MS),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    },
  };
}

export async function liveVerify(release: VerifyRelease, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<VerifyView> {
  const rpcs = [verifyRpc(release.rpcs[0], fetchFn), verifyRpc(release.rpcs[1], fetchFn)] as const;
  // no vault named on this network yet: nothing to read, nothing asked and nothing failed
  if (release.pins === null) return unverifiedView([]);
  // a pair the rule refuses is never asked, so the panel names no RPC
  if (nearPairNetwork(rpcs) !== release.network) {
    console.error(nearPairRule(release.network));
    return unverifiedView([]);
  }
  try {
    return verifyView(await readVerify(rpcs, release.pins, signal), release.pins);
  } catch (e) {
    if (!signal?.aborted) console.error(e instanceof Error ? e.message : String(e));
    return unverifiedView(release.rpcs);
  }
}
