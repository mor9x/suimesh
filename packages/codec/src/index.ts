import {
  actorFromString,
  actorToString,
  SUIMESH_PROTOCOL,
  SUIMESH_VERSION,
  type BcsEnvelope,
  type Encoding,
  type EventEnvelope,
  type EventHeader,
  type JsonEnvelope,
  type JsonValue
} from "../../protocol/src/index.ts";
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from "./base64url.ts";
import { bcsEventActor, decodeBcsEvent, encodeBcsEvent, eventHeaderToBcsEvent } from "./bcs.ts";
import { hashBytes, hashJson, stableStringify } from "./hash.ts";

export * from "./base64url.ts";
export * from "./bcs.ts";
export * from "./hash.ts";

export interface EncodeEventInput {
  header: EventHeader;
  payload: JsonValue;
  encoding: Encoding;
  signature?: string;
}

export interface DecodedEvent {
  header: EventHeader;
  payload: JsonValue;
  envelope: EventEnvelope;
  bcsBytes?: Uint8Array;
}

function normalizeJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = normalizeJsonValue(entry);
      }
    }
    return out;
  }
  return String(value);
}

export function encodeEvent(input: EncodeEventInput): EventEnvelope {
  const payload = normalizeJsonValue(input.payload);
  if (input.encoding === "json-v1") {
    const eventHash = hashBytes(
      utf8ToBytes(
        stableStringify({
          header: {
            eventId: input.header.eventId,
            sessionId: input.header.sessionId,
            traceId: input.header.traceId ?? "",
            eventType: input.header.eventType,
            actor: actorToString(input.header.actor),
            previousEventHash: input.header.previousEventHash ?? "",
            idempotencyKey: input.header.idempotencyKey ?? "",
            createdAtMs: input.header.createdAtMs
          },
          payload
        })
      )
    );
    const envelope: JsonEnvelope = {
      protocol: SUIMESH_PROTOCOL,
      version: SUIMESH_VERSION,
      encoding: "json-v1",
      eventType: input.header.eventType,
      eventId: input.header.eventId,
      sessionId: input.header.sessionId,
      traceId: input.header.traceId,
      actor: actorToString(input.header.actor),
      eventHash,
      previousEventHash: input.header.previousEventHash,
      idempotencyKey: input.header.idempotencyKey,
      createdAtMs: input.header.createdAtMs,
      payload,
      signature: input.signature
    };
    return envelope;
  }

  const bcsEvent = eventHeaderToBcsEvent(input.header, payload);
  const bcsBytes = encodeBcsEvent(bcsEvent);
  const eventHash = hashBytes(bcsBytes);
  const envelope: BcsEnvelope = {
    protocol: SUIMESH_PROTOCOL,
    version: SUIMESH_VERSION,
    encoding: "bcs-v1",
    eventType: input.header.eventType,
    eventId: input.header.eventId,
    sessionId: input.header.sessionId,
    traceId: input.header.traceId,
    actor: actorToString(input.header.actor),
    eventHash,
    previousEventHash: input.header.previousEventHash,
    idempotencyKey: input.header.idempotencyKey,
    createdAtMs: input.header.createdAtMs,
    payload: {
      bcs: bytesToBase64Url(bcsBytes)
    },
    signature: input.signature
  };
  return envelope;
}

export function decodeEvent(envelope: EventEnvelope): DecodedEvent {
  if (envelope.protocol !== SUIMESH_PROTOCOL || envelope.version !== SUIMESH_VERSION) {
    throw new Error("Unsupported SuiMesh envelope");
  }

  if (envelope.encoding === "json-v1") {
    return {
      header: {
        eventId: envelope.eventId,
        sessionId: envelope.sessionId,
        traceId: envelope.traceId,
        eventType: envelope.eventType,
        actor: actorFromString(envelope.actor),
        previousEventHash: envelope.previousEventHash,
        idempotencyKey: envelope.idempotencyKey,
        createdAtMs: envelope.createdAtMs ?? 0
      },
      payload: envelope.payload,
      envelope
    };
  }

  const bcsBytes = base64UrlToBytes(envelope.payload.bcs);
  const event = decodeBcsEvent(bcsBytes);
  const eventHash = hashBytes(bcsBytes);
  const actor = bcsEventActor(event);

  const mismatches = [
    ["protocol", envelope.protocol, event.protocol],
    ["version", envelope.version, event.version],
    ["eventId", envelope.eventId, event.eventId],
    ["sessionId", envelope.sessionId, event.sessionId],
    ["traceId", envelope.traceId ?? "", event.traceId],
    ["eventType", envelope.eventType, event.eventType],
    ["actor", envelope.actor, actorToString(actor)],
    ["eventHash", envelope.eventHash, eventHash],
    ["previousEventHash", envelope.previousEventHash ?? "", event.previousEventHash]
  ].filter(([, left, right]) => left !== right);

  if (mismatches.length > 0) {
    throw new Error(`BCS envelope mismatch: ${mismatches.map(([key]) => key).join(", ")}`);
  }

  return {
    header: {
      eventId: event.eventId,
      sessionId: event.sessionId,
      traceId: event.traceId || undefined,
      eventType: event.eventType as EventHeader["eventType"],
      actor,
      previousEventHash: event.previousEventHash || undefined,
      idempotencyKey: event.idempotencyKey || undefined,
      createdAtMs: event.createdAtMs
    },
    payload: event.payload,
    envelope,
    bcsBytes
  };
}

export function hashEvent(envelope: EventEnvelope): string {
  if (envelope.encoding === "bcs-v1") {
    return hashBytes(base64UrlToBytes(envelope.payload.bcs));
  }
  return envelope.eventHash ?? hashJson(envelope.payload);
}
