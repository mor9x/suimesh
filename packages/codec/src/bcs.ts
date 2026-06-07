import { bcs } from "@mysten/bcs";
import type { BcsType } from "@mysten/bcs";
import type { Actor, EventHeader, JsonValue } from "../../protocol/src/index.ts";

export interface BcsProtocolEvent {
  protocol: string;
  version: string;
  eventId: string;
  sessionId: string;
  traceId: string;
  eventType: string;
  actorRole: string;
  actorId: string;
  actorAddress: string;
  previousEventHash: string;
  idempotencyKey: string;
  createdAtMs: number;
  payload: JsonValue;
}

type BcsJsonValue =
  | { Null: null }
  | { Bool: boolean }
  | { String: string }
  | { Number: string }
  | { Array: BcsJsonValue[] }
  | { Object: [string, BcsJsonValue][] };

const BcsJsonValue: BcsType<any, any> = bcs.enum("SuiMeshJsonValue", {
  Null: null,
  Bool: bcs.bool(),
  String: bcs.string(),
  Number: bcs.string(),
  Array: bcs.vector(bcs.lazy(() => BcsJsonValue)),
  Object: bcs.vector(bcs.tuple([bcs.string(), bcs.lazy(() => BcsJsonValue)]))
});

const BcsProtocolEvent = bcs.struct("SuiMeshProtocolEvent", {
  protocol: bcs.string(),
  version: bcs.string(),
  eventId: bcs.string(),
  sessionId: bcs.string(),
  traceId: bcs.string(),
  eventType: bcs.string(),
  actorRole: bcs.string(),
  actorId: bcs.string(),
  actorAddress: bcs.string(),
  previousEventHash: bcs.string(),
  idempotencyKey: bcs.string(),
  createdAtMs: bcs.u64(),
  payload: BcsJsonValue
});

export function eventHeaderToBcsEvent(header: EventHeader, payload: JsonValue): BcsProtocolEvent {
  return {
    protocol: "suimesh",
    version: "0.1",
    eventId: header.eventId,
    sessionId: header.sessionId,
    traceId: header.traceId ?? "",
    eventType: header.eventType,
    actorRole: header.actor.role,
    actorId: header.actor.id,
    actorAddress: header.actor.address ?? "",
    previousEventHash: header.previousEventHash ?? "",
    idempotencyKey: header.idempotencyKey ?? "",
    createdAtMs: header.createdAtMs,
    payload
  };
}

export function bcsEventActor(event: BcsProtocolEvent): Actor {
  return {
    role: event.actorRole as Actor["role"],
    id: event.actorId,
    address: event.actorAddress || undefined
  };
}

export function encodeBcsEvent(event: BcsProtocolEvent): Uint8Array {
  return BcsProtocolEvent.serialize({
    ...event,
    payload: jsonValueToBcs(event.payload),
    createdAtMs: event.createdAtMs
  }).toBytes();
}

export function decodeBcsEvent(bytes: Uint8Array): BcsProtocolEvent {
  const event = BcsProtocolEvent.parse(bytes);
  return {
    protocol: event.protocol,
    version: event.version,
    eventId: event.eventId,
    sessionId: event.sessionId,
    traceId: event.traceId,
    eventType: event.eventType,
    actorRole: event.actorRole,
    actorId: event.actorId,
    actorAddress: event.actorAddress,
    previousEventHash: event.previousEventHash,
    idempotencyKey: event.idempotencyKey,
    createdAtMs: Number(event.createdAtMs),
    payload: bcsToJsonValue(event.payload as BcsJsonValue)
  };
}

function jsonValueToBcs(value: JsonValue): BcsJsonValue {
  if (value === null) {
    return { Null: null };
  }
  if (typeof value === "boolean") {
    return { Bool: value };
  }
  if (typeof value === "string") {
    return { String: value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot BCS encode non-finite number");
    }
    return { Number: String(value) };
  }
  if (Array.isArray(value)) {
    return { Array: value.map((entry) => jsonValueToBcs(entry)) };
  }
  return {
    Object: Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, jsonValueToBcs(entry)])
  };
}

function bcsToJsonValue(value: BcsJsonValue): JsonValue {
  if ("Null" in value) {
    return null;
  }
  if ("Bool" in value) {
    return value.Bool;
  }
  if ("String" in value) {
    return value.String;
  }
  if ("Number" in value) {
    const decoded = value.Number;
    const number = Number(decoded);
    return Number.isSafeInteger(number) || `${number}` === decoded ? number : decoded;
  }
  if ("Array" in value) {
    return value.Array.map((entry) => bcsToJsonValue(entry));
  }
  if ("Object" in value) {
    return Object.fromEntries(value.Object.map(([key, entry]) => [key, bcsToJsonValue(entry)]));
  }
  throw new Error("Unknown BCS JSON value variant");
}
