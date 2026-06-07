import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";
import type {
  DeleteMessageParams,
  FetchMessageParams,
  FetchMessagesParams,
  FetchMessagesResult,
  RelayerMessage,
  RelayerTransport,
  SendMessageParams,
  SendMessageResult,
  SubscribeParams,
  UpdateMessageParams
} from "@mysten/sui-stack-messaging";
import { toHex } from "@mysten/sui/utils";
import {
  createSuiMeshClient,
  membershipEventTypesFromSuiStackClient,
  SuiStackEventTransport,
  SuiStackSessionDiscovery,
  type SuiStackSessionDiscoveryResult,
  type SuiEventQueryClient
} from "../../src/index.ts";
import {
  createLiveSuiClient,
  liveNetwork,
  resolveSealServerConfigs,
  resolveSealThreshold,
  resolveSigner,
  sleep
} from "./live-common.ts";

class InMemoryRelayerTransport implements RelayerTransport {
  private readonly groups = new Map<string, RelayerMessage[]>();
  private disconnected = false;

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    this.assertConnected();
    const list = this.groups.get(params.groupId) ?? [];
    const now = Date.now();
    const message: RelayerMessage = {
      messageId: `msg_${crypto.randomUUID()}`,
      groupId: params.groupId,
      order: list.length + 1,
      encryptedText: new Uint8Array(params.encryptedText),
      nonce: new Uint8Array(params.nonce),
      keyVersion: params.keyVersion,
      senderAddress: params.signer.toSuiAddress(),
      createdAt: now,
      updatedAt: now,
      attachments: params.attachments ?? [],
      isEdited: false,
      isDeleted: false,
      signature: params.messageSignature ?? "",
      publicKey: toHex(params.signer.getPublicKey().toSuiBytes())
    };
    list.push(message);
    this.groups.set(params.groupId, list);
    return { messageId: message.messageId };
  }

  async fetchMessages(params: FetchMessagesParams): Promise<FetchMessagesResult> {
    this.assertConnected();
    const all = this.groups.get(params.groupId) ?? [];
    const filtered = all.filter((message) => {
      if (params.afterOrder !== undefined && message.order <= params.afterOrder) {
        return false;
      }
      if (params.beforeOrder !== undefined && message.order >= params.beforeOrder) {
        return false;
      }
      return true;
    });
    const limit = params.limit ?? filtered.length;
    return {
      messages: filtered.slice(0, limit).map((message) => this.clone(message)),
      hasNext: filtered.length > limit
    };
  }

  async fetchMessage(params: FetchMessageParams): Promise<RelayerMessage> {
    this.assertConnected();
    const message = (this.groups.get(params.groupId) ?? []).find((entry) => entry.messageId === params.messageId);
    if (!message) {
      throw new Error(`Message ${params.messageId} not found`);
    }
    return this.clone(message);
  }

  async updateMessage(params: UpdateMessageParams): Promise<void> {
    this.assertConnected();
    const list = this.groups.get(params.groupId) ?? [];
    const message = list.find((entry) => entry.messageId === params.messageId);
    if (!message) {
      throw new Error(`Message ${params.messageId} not found`);
    }
    message.encryptedText = new Uint8Array(params.encryptedText);
    message.nonce = new Uint8Array(params.nonce);
    message.keyVersion = params.keyVersion;
    message.attachments = params.attachments ?? message.attachments;
    message.signature = params.messageSignature ?? message.signature;
    message.updatedAt = Date.now();
    message.isEdited = true;
  }

  async deleteMessage(params: DeleteMessageParams): Promise<void> {
    this.assertConnected();
    const message = (this.groups.get(params.groupId) ?? []).find((entry) => entry.messageId === params.messageId);
    if (!message) {
      throw new Error(`Message ${params.messageId} not found`);
    }
    message.isDeleted = true;
    message.updatedAt = Date.now();
  }

  async *subscribe(params: SubscribeParams): AsyncIterable<RelayerMessage> {
    let afterOrder = params.afterOrder ?? 0;
    while (!this.disconnected && !params.signal?.aborted) {
      const result = await this.fetchMessages({
        signer: params.signer,
        groupId: params.groupId,
        afterOrder,
        limit: params.limit
      });
      for (const message of result.messages) {
        afterOrder = message.order;
        yield message;
      }
      if (result.messages.length === 0) {
        await sleep(250);
      }
    }
  }

  disconnect(): void {
    this.disconnected = true;
  }

  private assertConnected(): void {
    if (this.disconnected) {
      throw new Error("In-memory relayer is disconnected");
    }
  }

  private clone(message: RelayerMessage): RelayerMessage {
    return {
      ...message,
      encryptedText: new Uint8Array(message.encryptedText),
      nonce: new Uint8Array(message.nonce),
      attachments: [...message.attachments]
    };
  }
}

type WireMessageResponse = {
  message_id: string;
  group_id: string;
  order: number;
  encrypted_text: string;
  nonce: string;
  key_version: number;
  sender_address: string;
  created_at: number;
  updated_at: number;
  attachments: unknown[];
  is_edited: boolean;
  is_deleted: boolean;
  sync_status: string;
  quilt_patch_id: string | null;
  signature: string;
  public_key: string;
};

class LocalHttpRelayerServer {
  private readonly groups = new Map<string, WireMessageResponse[]>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.server = Bun.serve({
      port: 0,
      fetch: (request) => this.handle(request)
    });
  }

  get url(): string {
    return `http://${this.server.hostname}:${this.server.port}`;
  }

  stop(): void {
    this.server.stop(true);
  }

  private async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/messages" && request.method === "POST") {
        return this.createMessage(request);
      }
      if (url.pathname === "/messages" && request.method === "GET") {
        return this.getMessages(url);
      }
      if (url.pathname === "/messages" && request.method === "PUT") {
        return this.updateMessage(request);
      }
      if (url.pathname.startsWith("/messages/") && request.method === "DELETE") {
        return this.deleteMessage(request, decodeURIComponent(url.pathname.slice("/messages/".length)));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  private async createMessage(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const groupId = String(body.group_id);
    const list = this.groups.get(groupId) ?? [];
    const now = Date.now();
    const message: WireMessageResponse = {
      message_id: `msg_${crypto.randomUUID()}`,
      group_id: groupId,
      order: list.length + 1,
      encrypted_text: String(body.encrypted_text ?? ""),
      nonce: String(body.nonce ?? ""),
      key_version: Number(body.key_version ?? 0),
      sender_address: String(body.sender_address ?? ""),
      created_at: now,
      updated_at: now,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      is_edited: false,
      is_deleted: false,
      sync_status: "SYNCED",
      quilt_patch_id: null,
      signature: String(body.message_signature ?? ""),
      public_key: request.headers.get("x-public-key") ?? ""
    };
    list.push(message);
    this.groups.set(groupId, list);
    return Response.json({ message_id: message.message_id });
  }

  private getMessages(url: URL): Response {
    const groupId = url.searchParams.get("group_id") ?? "";
    const messageId = url.searchParams.get("message_id");
    const list = this.groups.get(groupId) ?? [];
    if (messageId) {
      const message = list.find((entry) => entry.message_id === messageId);
      if (!message) {
        return Response.json({ error: "message not found" }, { status: 404 });
      }
      return Response.json(message);
    }
    const afterOrder = numberParam(url, "after_order");
    const beforeOrder = numberParam(url, "before_order");
    const limit = numberParam(url, "limit") ?? list.length;
    const filtered = list.filter((message) => {
      if (afterOrder !== undefined && message.order <= afterOrder) {
        return false;
      }
      if (beforeOrder !== undefined && message.order >= beforeOrder) {
        return false;
      }
      return true;
    });
    return Response.json({
      messages: filtered.slice(0, limit),
      hasNext: filtered.length > limit
    });
  }

  private async updateMessage(request: Request): Promise<Response> {
    const body = (await request.json()) as Record<string, unknown>;
    const groupId = String(body.group_id);
    const messageId = String(body.message_id);
    const message = (this.groups.get(groupId) ?? []).find((entry) => entry.message_id === messageId);
    if (!message) {
      return Response.json({ error: "message not found" }, { status: 404 });
    }
    message.encrypted_text = String(body.encrypted_text ?? message.encrypted_text);
    message.nonce = String(body.nonce ?? message.nonce);
    message.key_version = Number(body.key_version ?? message.key_version);
    message.attachments = Array.isArray(body.attachments) ? body.attachments : message.attachments;
    message.signature = String(body.message_signature ?? message.signature);
    message.updated_at = Date.now();
    message.is_edited = true;
    return Response.json({});
  }

  private deleteMessage(request: Request, messageId: string): Response {
    const groupId = request.headers.get("x-group-id") ?? "";
    const message = (this.groups.get(groupId) ?? []).find((entry) => entry.message_id === messageId);
    if (!message) {
      return Response.json({ error: "message not found" }, { status: 404 });
    }
    message.is_deleted = true;
    message.updated_at = Date.now();
    return Response.json({});
  }
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : Number(value);
}

async function waitForMessage(client: ReturnType<typeof createSuiMeshClient>, sessionId: string, eventId: string) {
  const deadline = Date.now() + 60_000;
  let lastCount = 0;
  while (Date.now() < deadline) {
    const events = await client.trace.restore(sessionId);
    lastCount = events.length;
    if (events.some((event) => event.eventId === eventId)) {
      return events;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for relayer message ${eventId}; last restored count=${lastCount}`);
}

async function waitForDiscoveredSession(
  discovery: SuiStackSessionDiscovery,
  groupId: string
): Promise<SuiStackSessionDiscoveryResult> {
  const deadline = Date.now() + 90_000;
  let lastEventCount = 0;
  while (Date.now() < deadline) {
    const result = await discovery.poll();
    lastEventCount += result.events.length;
    if (result.activeSessions.some((session) => session.groupId === groupId)) {
      return result;
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for session discovery of group ${groupId}; observed events=${lastEventCount}`);
}

const network = liveNetwork();
const sealServerConfigs = resolveSealServerConfigs(network);
const sealThreshold = resolveSealThreshold(sealServerConfigs);
const signer = await resolveSigner();
const sessionId = process.env.SUIMESH_GROUP_UUID ?? `suimesh-live-${crypto.randomUUID()}`;
const groupName = process.env.SUIMESH_GROUP_NAME ?? `SuiMesh live ${new Date().toISOString()}`;
const requestedRelayerUrl = process.env.SUIMESH_RELAYER_URL;
const requireRemoteRelayer = process.env.SUIMESH_REQUIRE_REMOTE_RELAYER === "1";
if (requireRemoteRelayer && !requestedRelayerUrl) {
  throw new Error("SUIMESH_REQUIRE_REMOTE_RELAYER=1 requires SUIMESH_RELAYER_URL");
}
const relayerMode = requestedRelayerUrl ? "http" : process.env.SUIMESH_RELAYER_MODE ?? "local-http";
const localHttpRelayer = relayerMode === "local-http" ? new LocalHttpRelayerServer() : undefined;
const relayerUrl = requestedRelayerUrl ?? localHttpRelayer?.url;

const baseClient = createLiveSuiClient(network);

function createOfficialClient() {
  return createSuiStackMessagingClient(baseClient, {
    seal: {
      serverConfigs: sealServerConfigs
    },
    encryption: {
      sessionKey: {
        ttlMin: 10,
        signer
      },
      sealThreshold
    },
    relayer: relayerUrl ? { relayerUrl } : { transport: new InMemoryRelayerTransport() }
  });
}

const stackClient = createOfficialClient();

const groupRef = { uuid: sessionId };
const createResult = await stackClient.messaging.createAndShareGroup({
  signer,
  uuid: sessionId,
  name: groupName
});
await baseClient.waitForTransaction({ digest: createResult.digest });
const resolvedGroup = stackClient.messaging.derive.resolveGroupRef(groupRef);
const sessionDiscovery = new SuiStackSessionDiscovery({
  actorAddress: signer.toSuiAddress(),
  suiClient: baseClient as unknown as SuiEventQueryClient,
  eventTypes: membershipEventTypesFromSuiStackClient(stackClient),
  metadataView: stackClient.messaging.view,
  maxPagesPerEventType: Number(process.env.SUIMESH_SESSION_DISCOVERY_MAX_PAGES ?? process.env.SUIMESH_INBOX_MAX_PAGES ?? 20)
});
const discoveryResult = await waitForDiscoveredSession(sessionDiscovery, resolvedGroup.groupId);
const discoveredTargetSession = discoveryResult.activeSessions.find((session) => session.groupId === resolvedGroup.groupId);

const adapter = new SuiStackEventTransport({
  client: stackClient.messaging,
  signer,
  groupRefForSession: () => groupRef
});
const suimesh = createSuiMeshClient({ transport: adapter });
const sent = await suimesh.light.sendMessage({
  sessionId,
  actor: {
    role: "user",
    id: "live-user",
    address: signer.toSuiAddress()
  },
  content: `SuiMesh live e2e ${Date.now()}`
});
const restored = await waitForMessage(suimesh, sessionId, sent.eventId);
const verified = await suimesh.trace.verify(sessionId);
stackClient.messaging.disconnect();

const reconnectStackClient = createOfficialClient();
const reconnectAdapter = new SuiStackEventTransport({
  client: reconnectStackClient.messaging,
  signer,
  groupRefForSession: () => groupRef
});
const reconnectedSuiMesh = createSuiMeshClient({ transport: reconnectAdapter });
const restoredAfterReconnect = await waitForMessage(reconnectedSuiMesh, sessionId, sent.eventId);
const verifiedAfterReconnect = await reconnectedSuiMesh.trace.verify(sessionId);

console.log(JSON.stringify({
  network,
  address: signer.toSuiAddress(),
  relayer: requestedRelayerUrl ? "http" : relayerMode,
  relayerUrl: relayerUrl ?? null,
  sealServerObjectIds: sealServerConfigs.map((config) => config.objectId),
  sealThreshold,
  sessionId,
  groupId: resolvedGroup.groupId,
  groupCreateDigest: createResult.digest,
  discoveredTargetSession,
  discoveredSessions: discoveryResult.activeSessions.map((session) => ({
    groupId: session.groupId,
    uuid: session.uuid,
    name: session.name
  })),
  sessionDiscoveryEventKinds: discoveryResult.events.map((event) => event.kind),
  sentEventId: sent.eventId,
  restoredEvents: restored.length,
  restoredAfterReconnectEvents: restoredAfterReconnect.length,
  verified,
  verifiedAfterReconnect
}, null, 2));

reconnectStackClient.messaging.disconnect();
localHttpRelayer?.stop();
