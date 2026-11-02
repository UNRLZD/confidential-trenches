import type { Plugin } from "vite";
export const NETWORKS: string[];
export const MAINNET_RPCS: string;
export const TESTNET_RPCS: string;
export function networkOf(value: string | undefined): "mainnet" | "testnet";
export function headersFor(network: string, text: string): string;
export function nearNetwork(): Plugin;
