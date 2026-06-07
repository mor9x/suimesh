import { describe, expect, test } from "bun:test";
import {
  membershipEventTypesFromSuiStackClient,
  SuiStackSessionDiscovery,
  type SuiEventLike,
  type SuiEventQueryClient,
  type SuiEventQueryInput,
  type SuiEventQueryPage,
  type SuiStackGroupMetadataView
} from "../src/index.ts";

const eventTypes = {
  memberAdded: "0xgroups::permissioned_group::MemberAdded<0xmsg::messaging::Messaging>",
  memberRemoved: "0xgroups::permissioned_group::MemberRemoved<0xmsg::messaging::Messaging>",
  permissionsGranted: "0xgroups::permissioned_group::PermissionsGranted<0xmsg::messaging::Messaging>",
  permissionsRevoked: "0xgroups::permissioned_group::PermissionsRevoked<0xmsg::messaging::Messaging>"
};

class FakeSuiEvents implements SuiEventQueryClient {
  readonly calls: SuiEventQueryInput[] = [];
  readonly eventsByType = new Map<string, SuiEventLike[]>();

  add(type: string, parsedJson: Record<string, unknown>, id: string): void {
    const events = this.eventsByType.get(type) ?? [];
    events.push({
      id: { txDigest: id, eventSeq: "0" },
      type,
      parsedJson,
      timestampMs: `${events.length + 1}`
    });
    this.eventsByType.set(type, events);
  }

  async queryEvents(input: SuiEventQueryInput): Promise<SuiEventQueryPage> {
    this.calls.push(input);
    const events = this.eventsByType.get(input.query.MoveEventType) ?? [];
    const offset = typeof input.cursor === "number" ? input.cursor : 0;
    const limit = input.limit ?? 50;
    const data = events.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor: nextOffset,
      hasNextPage: nextOffset < events.length
    };
  }
}

class FakeMetadataView implements SuiStackGroupMetadataView {
  requestedGroupIds: string[] = [];

  async groupsMetadata(input: { groupIds: string[]; refresh?: boolean }) {
    this.requestedGroupIds.push(...input.groupIds);
    return Object.fromEntries(
      input.groupIds.map((groupId) => [
        groupId,
        {
          uuid: `uuid_${groupId}`,
          name: `Session ${groupId}`
        }
      ])
    );
  }
}

describe("sui-stack session discovery", () => {
  test("discovers sessions for the target actor and hydrates group metadata", async () => {
    const suiClient = new FakeSuiEvents();
    const metadataView = new FakeMetadataView();
    suiClient.add(eventTypes.memberAdded, { group_id: "0xgroup1", member: "0xAgent" }, "tx1");
    suiClient.add(eventTypes.memberAdded, { group_id: "0xgroup2", member: "0xother" }, "tx2");

    const discovery = new SuiStackSessionDiscovery({
      actorAddress: "0xagent",
      suiClient,
      eventTypes,
      metadataView
    });

    const result = await discovery.poll();

    expect(result.events.map((event) => event.groupId)).toEqual(["0xgroup1"]);
    expect(result.addedSessions).toEqual([
      {
        groupId: "0xgroup1",
        uuid: "uuid_0xgroup1",
        name: "Session 0xgroup1",
        discoveredAtMs: expect.any(Number),
        lastEventId: JSON.stringify({ txDigest: "tx1", eventSeq: "0" })
      }
    ]);
    expect(result.activeSessions.map((session) => session.groupId)).toEqual(["0xgroup1"]);
    expect(metadataView.requestedGroupIds).toEqual(["0xgroup1"]);
  });

  test("uses cursors and seen event IDs to avoid duplicate notifications", async () => {
    const suiClient = new FakeSuiEvents();
    suiClient.add(eventTypes.memberAdded, { group_id: "0xgroup1", member: "0xagent" }, "tx1");

    const discovery = new SuiStackSessionDiscovery({
      actorAddress: "0xagent",
      suiClient,
      eventTypes: { memberAdded: eventTypes.memberAdded, memberRemoved: eventTypes.memberRemoved },
      pageSize: 1
    });

    const first = await discovery.poll();
    const second = await discovery.poll();

    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(0);
    expect(second.addedSessions).toHaveLength(0);
    expect(second.activeSessions.map((session) => session.groupId)).toEqual(["0xgroup1"]);
  });

  test("removes active sessions when the actor is removed from a group", async () => {
    const suiClient = new FakeSuiEvents();
    suiClient.add(eventTypes.memberAdded, { group_id: "0xgroup1", member: "0xagent" }, "tx1");

    const discovery = new SuiStackSessionDiscovery({
      actorAddress: "0xagent",
      suiClient,
      eventTypes: { memberAdded: eventTypes.memberAdded, memberRemoved: eventTypes.memberRemoved }
    });

    await discovery.poll();
    suiClient.add(eventTypes.memberRemoved, { group_id: "0xgroup1", member: "0xagent" }, "tx2");
    const result = await discovery.poll();

    expect(result.events.map((event) => event.kind)).toEqual(["member_removed"]);
    expect(result.removedGroupIds).toEqual(["0xgroup1"]);
    expect(result.activeSessions).toEqual([]);
  });

  test("captures permission grant and revoke events without requiring an indexer", async () => {
    const suiClient = new FakeSuiEvents();
    suiClient.add(
      eventTypes.permissionsGranted,
      { group_id: "0xgroup1", member: "0xagent", permissions: ["MessagingReader", "MessagingSender"] },
      "tx1"
    );
    suiClient.add(
      eventTypes.permissionsRevoked,
      { group_id: "0xgroup1", member: "0xagent", permissions: ["MessagingSender"] },
      "tx2"
    );

    const discovery = new SuiStackSessionDiscovery({
      actorAddress: "0xagent",
      suiClient,
      eventTypes
    });

    const result = await discovery.poll();

    expect(result.events.map((event) => event.kind)).toEqual(["permissions_granted", "permissions_revoked"]);
    expect(result.events[0]?.permissions).toEqual(["MessagingReader", "MessagingSender"]);
    expect(result.events[1]?.permissions).toEqual(["MessagingSender"]);
  });

  test("can read official sui-stack-messaging BCS event type names from the client shape", () => {
    expect(
      membershipEventTypesFromSuiStackClient({
        groups: {
          bcs: {
            MemberAdded: { name: eventTypes.memberAdded },
            MemberRemoved: { name: eventTypes.memberRemoved },
            PermissionsGranted: { name: eventTypes.permissionsGranted },
            PermissionsRevoked: { name: eventTypes.permissionsRevoked }
          }
        }
      })
    ).toEqual(eventTypes);
  });
});
