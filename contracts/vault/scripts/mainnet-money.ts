// SPDX-License-Identifier: Apache-2.0
// The mainnet money run's refusals, not written yet (card vault-mainnet-money): mainnet-money.test.ts fails here.
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECORD = path.join(HERE, "..", "deployments", "mainnet-v1.json");
export const PIN = path.join(HERE, "..", "deployments", "mainnet-v1.pin.json");
export const AMOUNT = 5_000_000n;
export const runProblems = (_a: unknown): string[] => [];
export const feeProblems = (_a: unknown): string[] => [];
export const vaultReadProblems = (_r: unknown, _x: unknown): string[] => [];
