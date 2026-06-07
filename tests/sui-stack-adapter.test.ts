import { describe, expect, test } from "bun:test";
import {
  InMemoryEventTransport,
  SuiStackEventTransport,
  encodeEvent,
  parseEnvelopeText,
  serializeEnvelope,
  type EventEnvelope,
  type OfficialSuiStackMessagingClient
} from "../src/index.ts";
import type { DecryptedMessage, GetMessagesOptions, SendMessageOptions, SubscribeOptions } from "@mysten/sui-stack-messaging";
import { createSuiStackMessagingClient, HTTPRelayerTransport } from "@mysten/sui-stack-messaging";

const signer = {
  toSuiAddress: () => "0xalice",
  signPersonalMessage: async () => ({ bytes: "", signature: "" }),
  signTransaction: async () => ({ bytes: "", signature: "" }),
  signTransactionBlock: async () => ({ bytes: "", signature: "" })
};

function event(sessionId = "ses_stack"): EventEnvelope {
  return encodeEvent({
    encoding: "json-v1",
    header: {
      eventId: "evt_stack",
      sessionId,
      eventType: "conversation.user_message.v1",
      actor: { role: "user", id: "alice", address: "0xalice" },
      createdAtMs: 1
    },
    payload: { content: "hello" }
  });
}

class FakeOfficialClient implements OfficialSuiStackMessagingClient {
  sent: string[] = [];

  async sendMessage(input: SendMessageOptions): Promise<{ messageId: string }> {
    this.sent.push(input.text ?? "");
    return { messageId: `msg_${this.sent.length}` };
  }

  async getMessages(_input: GetMessagesOptions): Promise<{ messages: DecryptedMessage[]; hasNext: boolean }> {
    return {
      messages: this.sent.map((text, index) => message(text, index + 1)),
      hasNext: false
    };
  }

  async *subscribe(_input: SubscribeOptions): AsyncIterable<DecryptedMessage> {
    for (const [index, text] of this.sent.entries()) {
      yield message(text, index + 1);
    }
  }

  disconnect(): void {}
}

function message(text: string, order: number): DecryptedMessage {
  return {
    messageId: `msg_${order}`,
    groupId: "group",
    order,
    text,
    senderAddress: "0xalice",
    createdAt: order,
    updatedAt: order,
    isEdited: false,
    isDeleted: false,
    attachments: [],
    senderVerified: true
  };
}

describe("sui-stack-messaging adapter", () => {
  test("loads the real @mysten/sui-stack-messaging package", () => {
    expect(typeof createSuiStackMessagingClient).toBe("function");
    expect(typeof HTTPRelayerTransport).toBe("function");
  });

  test("serializes and parses SuiMesh envelopes as message text", () => {
    const envelope = event();
    expect(parseEnvelopeText(serializeEnvelope(envelope))).toEqual(envelope);
    expect(parseEnvelopeText("not-json")).toBeUndefined();
    expect(parseEnvelopeText(JSON.stringify({ protocol: "other" }))).toBeUndefined();
  });

  test("wraps the official client send/getMessages flow", async () => {
    const official = new FakeOfficialClient();
    const adapter = new SuiStackEventTransport({
      client: official,
      signer: signer as never
    });
    const envelope = event();

    await adapter.send(envelope);
    const restored = await adapter.list("ses_stack");

    expect(official.sent).toHaveLength(1);
    expect(restored).toEqual([envelope]);
  });

  test("keeps in-memory adapter available for offline tests", async () => {
    const adapter = new InMemoryEventTransport();
    const envelope = event("ses_memory");
    await adapter.send(envelope);
    expect(await adapter.list("ses_memory")).toEqual([envelope]);
  });
});
