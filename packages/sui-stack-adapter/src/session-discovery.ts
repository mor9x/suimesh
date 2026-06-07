import type { AuthorizedSession } from "../../transport/src/index.ts";

export type SuiStackSessionDiscoveryEventKind =
  | "member_added"
  | "member_removed"
  | "permissions_granted"
  | "permissions_revoked";

export interface SuiEventQueryInput {
  query: { MoveEventType: string };
  cursor?: unknown;
  limit?: number;
  order?: "ascending" | "descending";
}

export interface SuiEventQueryPage {
  data: SuiEventLike[];
  nextCursor?: unknown;
  hasNextPage: boolean;
}

export interface SuiEventQueryClient {
  queryEvents(input: SuiEventQueryInput): Promise<SuiEventQueryPage>;
}

export interface SuiEventLike {
  id?: unknown;
  type: string;
  parsedJson?: unknown;
  timestampMs?: string;
}

export interface SuiStackMembershipEventTypes {
  memberAdded: string;
  memberRemoved: string;
  permissionsGranted?: string;
  permissionsRevoked?: string;
}

export interface SuiStackGroupMetadata {
  groupId: string;
  uuid?: string;
  name?: string;
}

export type SuiStackGroupMetadataResult =
  | SuiStackGroupMetadata[]
  | Record<string, Omit<SuiStackGroupMetadata, "groupId"> | undefined>;

export interface SuiStackGroupMetadataView {
  groupsMetadata(input: { groupIds: string[]; refresh?: boolean }): Promise<SuiStackGroupMetadataResult>;
}

export interface SuiStackSessionDiscoveryOptions {
  actorAddress: string;
  suiClient: SuiEventQueryClient;
  eventTypes: SuiStackMembershipEventTypes;
  metadataView?: SuiStackGroupMetadataView;
  pageSize?: number;
  maxPagesPerEventType?: number;
  pollIntervalMs?: number;
  initialCursorByEventType?: Record<string, unknown>;
}

export interface SuiStackSessionDiscoveryEvent {
  kind: SuiStackSessionDiscoveryEventKind;
  eventType: string;
  eventId: string;
  groupId: string;
  member: string;
  permissions: string[];
  timestampMs?: string;
  raw: SuiEventLike;
}

export interface SuiStackAuthorizedSession {
  groupId: string;
  uuid?: string;
  name?: string;
  discoveredAtMs: number;
  lastEventId: string;
}

export interface SuiStackSessionDiscoveryResult {
  events: SuiStackSessionDiscoveryEvent[];
  addedSessions: SuiStackAuthorizedSession[];
  removedGroupIds: string[];
  activeSessions: SuiStackAuthorizedSession[];
  cursorByEventType: Record<string, unknown>;
}

export type SuiStackSessionDiscoveryHandler = (result: SuiStackSessionDiscoveryResult) => void | Promise<void>;

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES_PER_EVENT_TYPE = 5;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export class SuiStackSessionDiscovery {
  private readonly actorAddress: string;
  private readonly suiClient: SuiEventQueryClient;
  private readonly eventTypes: SuiStackMembershipEventTypes;
  private readonly metadataView?: SuiStackGroupMetadataView;
  private readonly pageSize: number;
  private readonly maxPagesPerEventType: number;
  private readonly pollIntervalMs: number;
  private readonly cursorByEventType = new Map<string, unknown>();
  private readonly seenEventIds = new Set<string>();
  private readonly activeSessions = new Map<string, SuiStackAuthorizedSession>();

  constructor(options: SuiStackSessionDiscoveryOptions) {
    this.actorAddress = normalizeAddress(options.actorAddress);
    this.suiClient = options.suiClient;
    this.eventTypes = options.eventTypes;
    this.metadataView = options.metadataView;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPagesPerEventType = options.maxPagesPerEventType ?? DEFAULT_MAX_PAGES_PER_EVENT_TYPE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    for (const [eventType, cursor] of Object.entries(options.initialCursorByEventType ?? {})) {
      this.cursorByEventType.set(eventType, cursor);
    }
  }

  async poll(): Promise<SuiStackSessionDiscoveryResult> {
    const events: SuiStackSessionDiscoveryEvent[] = [];
    const removedGroupIds: string[] = [];
    const newlyDiscoveredGroupIds = new Set<string>();

    for (const definition of this.eventDefinitions()) {
      let cursor = this.cursorByEventType.get(definition.eventType);
      let pages = 0;

      while (pages < this.maxPagesPerEventType) {
        const page = await this.suiClient.queryEvents({
          query: { MoveEventType: definition.eventType },
          cursor,
          limit: this.pageSize,
          order: "ascending"
        });

        for (const raw of page.data) {
          const parsed = parseMembershipEvent(raw, definition.kind);
          if (!parsed || normalizeAddress(parsed.member) !== this.actorAddress) {
            continue;
          }

          const eventId = stableEventId(raw);
          if (this.seenEventIds.has(eventId)) {
            continue;
          }
          this.seenEventIds.add(eventId);

          const event: SuiStackSessionDiscoveryEvent = {
            ...parsed,
            eventType: definition.eventType,
            eventId,
            timestampMs: raw.timestampMs,
            raw
          };
          events.push(event);

          if (event.kind === "member_removed") {
            this.activeSessions.delete(event.groupId);
            removedGroupIds.push(event.groupId);
            continue;
          }

          const alreadyActive = this.activeSessions.has(event.groupId);
          this.activeSessions.set(event.groupId, {
            ...this.activeSessions.get(event.groupId),
            groupId: event.groupId,
            discoveredAtMs: Date.now(),
            lastEventId: event.eventId
          });
          if (!alreadyActive) {
            newlyDiscoveredGroupIds.add(event.groupId);
          }
        }

        cursor = page.nextCursor;
        if (cursor !== undefined) {
          this.cursorByEventType.set(definition.eventType, cursor);
        }

        pages += 1;
        if (!page.hasNextPage) {
          break;
        }
      }
    }

    const addedSessions = await this.hydrateSessions([...newlyDiscoveredGroupIds]);

    return {
      events,
      addedSessions,
      removedGroupIds,
      activeSessions: [...this.activeSessions.values()],
      cursorByEventType: Object.fromEntries(this.cursorByEventType)
    };
  }

  async discoverAuthorizedSessions(): Promise<AuthorizedSession[]> {
    const result = await this.poll();
    return result.activeSessions.map((session) => ({
      sessionId: session.uuid ?? session.groupId,
      transport: "sui-stack-messaging",
      accessRef: session.groupId,
      name: session.name,
      discoveredAtMs: session.discoveredAtMs,
      metadata: {
        groupId: session.groupId,
        lastEventId: session.lastEventId
      }
    }));
  }

  start(handler: SuiStackSessionDiscoveryHandler): () => void {
    let stopped = false;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        const result = await this.poll();
        if (result.events.length > 0 || result.addedSessions.length > 0 || result.removedGroupIds.length > 0) {
          await handler(result);
        }
        await sleep(this.pollIntervalMs);
      }
    };

    void loop();

    return () => {
      stopped = true;
    };
  }

  private eventDefinitions(): { kind: SuiStackSessionDiscoveryEventKind; eventType: string }[] {
    return [
      { kind: "member_added", eventType: this.eventTypes.memberAdded },
      { kind: "member_removed", eventType: this.eventTypes.memberRemoved },
      this.eventTypes.permissionsGranted
        ? { kind: "permissions_granted", eventType: this.eventTypes.permissionsGranted }
        : undefined,
      this.eventTypes.permissionsRevoked
        ? { kind: "permissions_revoked", eventType: this.eventTypes.permissionsRevoked }
        : undefined
    ].filter(
      (definition): definition is { kind: SuiStackSessionDiscoveryEventKind; eventType: string } => definition !== undefined
    );
  }

  private async hydrateSessions(groupIds: string[]): Promise<SuiStackAuthorizedSession[]> {
    if (groupIds.length === 0) {
      return [];
    }

    const metadataByGroupId = new Map<string, SuiStackGroupMetadata>();
    if (this.metadataView) {
      for (const metadata of normalizeMetadataResult(await this.metadataView.groupsMetadata({ groupIds, refresh: true }))) {
        metadataByGroupId.set(metadata.groupId, metadata);
      }
    }

    const addedSessions: SuiStackAuthorizedSession[] = [];
    for (const groupId of groupIds) {
      const current = this.activeSessions.get(groupId);
      if (!current) {
        continue;
      }
      const metadata = metadataByGroupId.get(groupId);
      const session = {
        ...current,
        uuid: metadata?.uuid ?? current.uuid,
        name: metadata?.name ?? current.name
      };
      this.activeSessions.set(groupId, session);
      addedSessions.push(session);
    }
    return addedSessions;
  }
}

export function membershipEventTypesFromSuiStackClient(client: {
  groups: {
    bcs: {
      MemberAdded: { name: string };
      MemberRemoved: { name: string };
      PermissionsGranted?: { name: string };
      PermissionsRevoked?: { name: string };
    };
  };
}): SuiStackMembershipEventTypes {
  return {
    memberAdded: client.groups.bcs.MemberAdded.name,
    memberRemoved: client.groups.bcs.MemberRemoved.name,
    permissionsGranted: client.groups.bcs.PermissionsGranted?.name,
    permissionsRevoked: client.groups.bcs.PermissionsRevoked?.name
  };
}

function parseMembershipEvent(
  event: SuiEventLike,
  kind: SuiStackSessionDiscoveryEventKind
): { kind: SuiStackSessionDiscoveryEventKind; groupId: string; member: string; permissions: string[] } | undefined {
  const parsed = asRecord(event.parsedJson);
  if (!parsed) {
    return undefined;
  }

  const groupId = extractString(parsed, ["group_id", "groupId", "group"]);
  const member = extractString(parsed, ["member", "address", "actor", "account"]);
  if (!groupId || !member) {
    return undefined;
  }

  return {
    kind,
    groupId,
    member,
    permissions: extractStringArray(parsed, ["permissions", "permission_types", "permissionTypes", "permission"])
  };
}

function normalizeMetadataResult(result: SuiStackGroupMetadataResult): SuiStackGroupMetadata[] {
  if (Array.isArray(result)) {
    return result;
  }
  return Object.entries(result).map(([groupId, metadata]) => ({
    groupId,
    uuid: metadata?.uuid,
    name: metadata?.name
  }));
}

function extractString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
    if (isObjectIdShape(value)) {
      return value.id;
    }
  }
  return undefined;
}

function extractStringArray(record: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (typeof value === "string") {
      return [value];
    }
  }
  return [];
}

function stableEventId(event: SuiEventLike): string {
  if (event.id !== undefined) {
    return JSON.stringify(event.id);
  }
  return `${event.type}:${JSON.stringify(event.parsedJson)}:${event.timestampMs ?? ""}`;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function isObjectIdShape(value: unknown): value is { id: string } {
  return value !== null && typeof value === "object" && typeof (value as { id?: unknown }).id === "string";
}


async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
