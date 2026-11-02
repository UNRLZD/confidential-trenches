// The NEAR network a build names (card app-verify-mount): VITE_NEAR_NETWORK as Vite resolves it (the environment or a
// .env file), mainnet when unset, any other value stops the build. The app reads it as
// import.meta.env.VITE_NEAR_NETWORK (src/screens/verify/release.ts). A testnet build's _headers lets the page reach
// the testnet pair Verify reads in place of the mainnet RPCs, so its policy names only the RPCs of the network it
// reads; a mainnet build's _headers is public/_headers byte for byte. test/verify-mount.test.ts holds TESTNET_RPCS to
// the release's testnet pair.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const NETWORKS = ["mainnet", "testnet"];
export const MAINNET_RPCS = "https://rpc.mainnet.fastnear.com https://rpc.mainnet.near.org https://near.drpc.org";
export const TESTNET_RPCS = "https://test.rpc.fastnear.com https://near-testnet.drpc.org";

export function networkOf(value) {
  const v = value === undefined || value === "" ? "mainnet" : value;
  if (!NETWORKS.includes(v)) throw new Error(`VITE_NEAR_NETWORK must be one of ${NETWORKS.join(", ")}: ${v}`);
  return v;
}

/** The _headers text for a network's build: the connect-src RPCs swapped once for a testnet build, or the error. */
export function headersFor(network, text) {
  if (network === "mainnet") return text;
  const parts = text.split(` ${MAINNET_RPCS};`);
  if (parts.length !== 2) throw new Error("_headers: the mainnet RPCs are not in connect-src exactly once");
  return parts.join(` ${TESTNET_RPCS};`);
}

/**
 * The plugin. The network is read from Vite's resolved env (c.env: the environment and every .env file Vite loads,
 * the same values import.meta.env.VITE_NEAR_NETWORK is replaced with), so a .env file cannot name a network the
 * headers do not follow, and a value that is not a network stops the build.
 */
export function nearNetwork() {
  let network = "mainnet";
  let outDir = "dist";
  return {
    name: "near-network",
    configResolved(c) {
      network = networkOf(c.env?.VITE_NEAR_NETWORK);
      outDir = path.resolve(c.root, c.build.outDir);
    },
    writeBundle() {
      const file = path.join(outDir, "_headers");
      writeFileSync(file, headersFor(network, readFileSync(file, "utf8")));
    },
  };
}
