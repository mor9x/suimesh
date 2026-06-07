import { fromHex, toHex } from "@mysten/bcs";
import { blake2b } from "@noble/hashes/blake2.js";
import type { JsonValue } from "../../protocol/src/index.ts";
import { utf8ToBytes } from "./base64url.ts";

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${toHex(bytes)}`;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error("Invalid hex length");
  }
  return fromHex(clean);
}

export function hashBytes(bytes: Uint8Array): string {
  return bytesToHex(blake2b(bytes, { dkLen: 32 }));
}

export function stableStringify(value: JsonValue): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function hashJson(value: JsonValue): string {
  return hashBytes(utf8ToBytes(stableStringify(value)));
}
