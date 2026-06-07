import { describe, expect, test } from "bun:test";
import { decodeEvent, encodeBcsEvent, encodeEvent, eventHeaderToBcsEvent, hashBytes, hashEvent } from "../src/index.ts";

const actor = { role: "agent" as const, id: "agent-1", address: "0xagent" };

describe("event codec", () => {
  test("decodes light JSON envelopes without losing actor or timestamp metadata", () => {
    const header = {
      eventId: "evt_light",
      sessionId: "ses_1",
      traceId: "tr_1",
      eventType: "conversation.agent_message.v1" as const,
      actor,
      previousEventHash: "0xprev",
      idempotencyKey: "idem_light",
      createdAtMs: 1_700_000_000_000
    };
    const envelope = encodeEvent({ encoding: "json-v1", header, payload: { content: "hello" } });
    const decoded = decodeEvent(envelope);

    expect(decoded.header.actor).toEqual(actor);
    expect(decoded.header.createdAtMs).toBe(header.createdAtMs);
    expect(decoded.header.idempotencyKey).toBe(header.idempotencyKey);
    expect(envelope.eventHash).toBeDefined();
    expect(hashEvent(envelope)).toBe(envelope.eventHash!);
  });

  test("encodes heavy events as BCS inside a JSON envelope", () => {
    const header = {
      eventId: "evt_1",
      sessionId: "ses_1",
      traceId: "tr_1",
      eventType: "decision.sui_ptb_action.v1" as const,
      actor,
      previousEventHash: "0xprev",
      idempotencyKey: "idem_1",
      createdAtMs: 1_700_000_000_000
    };
    const payload = { actionType: "sui.ptb.v1", value: "10" };
    const envelope = encodeEvent({ encoding: "bcs-v1", header, payload });

    expect(envelope.encoding).toBe("bcs-v1");
    expect(envelope.eventHash).toStartWith("0x");

    const decoded = decodeEvent(envelope);
    expect(decoded.header.eventId).toBe(header.eventId);
    expect(decoded.header.actor).toEqual(actor);
    expect(decoded.payload).toEqual(payload);
  });

  test("rejects envelope fields that do not match BCS payload", () => {
    const header = {
      eventId: "evt_2",
      sessionId: "ses_1",
      traceId: "tr_1",
      eventType: "decision.policy_decision.v1" as const,
      actor,
      createdAtMs: 1
    };
    const envelope = encodeEvent({ encoding: "bcs-v1", header, payload: { decision: "approved" } });
    expect(() => decodeEvent({ ...envelope, sessionId: "ses_tampered" })).toThrow("BCS envelope mismatch");
  });

  test("same BCS event bytes produce a stable hash", () => {
    const header = {
      eventId: "evt_3",
      sessionId: "ses_1",
      traceId: "tr_1",
      eventType: "outcome.audit_event.v1" as const,
      actor,
      createdAtMs: 1
    };
    const payload = { z: "last", a: "first" };
    const first = encodeBcsEvent(eventHeaderToBcsEvent(header, payload));
    const second = encodeBcsEvent(eventHeaderToBcsEvent(header, payload));
    expect(hashBytes(first)).toBe(hashBytes(second));
  });

  test("BCS event codec round-trips nested JSON payloads", () => {
    const header = {
      eventId: "evt_nested",
      sessionId: "ses_1",
      traceId: "tr_1",
      eventType: "outcome.audit_event.v1" as const,
      actor,
      createdAtMs: 1
    };
    const payload = {
      ok: true,
      count: 3,
      nested: [{ key: "value" }, null, ["a", "b"]]
    };

    const envelope = encodeEvent({ encoding: "bcs-v1", header, payload });

    expect(decodeEvent(envelope).payload).toEqual(payload);
  });
});
