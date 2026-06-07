import type { EventEnvelope } from "../../protocol/src/index.ts";
import type { EventTransport } from "../../transport/src/index.ts";
import type {
  DecryptedMessage,
  GetMessagesResult,
  GroupRef,
  SendMessageOptions,
  SubscribeOptions,
  SuiStackMessagingClient
} from "@mysten/sui-stack-messaging";

export * from "./session-discovery.ts";
export type { EventTransport };
export { InMemoryEventTransport } from "../../transport/src/index.ts";

export type SuiStackMessagingSigner = SendMessageOptions["signer"];
export type SuiStackMessagingGroupRef = GroupRef;

export type OfficialSuiStackMessagingClient = Pick<
  SuiStackMessagingClient,
  "sendMessage" | "getMessages" | "subscribe" | "disconnect"
>;

export interface SuiStackEventTransportOptions {
  client: OfficialSuiStackMessagingClient;
  signer: SuiStackMessagingSigner | ((sessionId: string) => SuiStackMessagingSigner | Promise<SuiStackMessagingSigner>);
  groupRefForSession?: (sessionId: string) => SuiStackMessagingGroupRef;
  pageSize?: number;
  maxPages?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20;

export class SuiStackEventTransport implements EventTransport {
  private readonly client: OfficialSuiStackMessagingClient;
  private readonly signer: SuiStackEventTransportOptions["signer"];
  private readonly groupRefForSession: (sessionId: string) => SuiStackMessagingGroupRef;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(options: SuiStackEventTransportOptions) {
    this.client = options.client;
    this.signer = options.signer;
    this.groupRefForSession = options.groupRefForSession ?? ((sessionId) => ({ uuid: sessionId }));
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async send(envelope: EventEnvelope): Promise<void> {
    await this.client.sendMessage({
      signer: await this.resolveSigner(envelope.sessionId),
      groupRef: this.groupRefForSession(envelope.sessionId),
      text: serializeEnvelope(envelope)
    });
  }

  async list(sessionId: string): Promise<EventEnvelope[]> {
    const messages: DecryptedMessage[] = [];
    let afterOrder: number | undefined;
    let pages = 0;

    while (pages < this.maxPages) {
      const page: GetMessagesResult = await this.client.getMessages({
        signer: await this.resolveSigner(sessionId),
        groupRef: this.groupRefForSession(sessionId),
        afterOrder,
        limit: this.pageSize
      });
      messages.push(...page.messages);
      pages += 1;

      const last = page.messages.at(-1);
      if (!page.hasNext || !last) {
        break;
      }
      afterOrder = last.order;
    }

    return messages
      .map((message) => parseEnvelopeText(message.text))
      .filter((envelope): envelope is EventEnvelope => envelope !== undefined && envelope.sessionId === sessionId);
  }

  async subscribe(sessionId: string, handler: (envelope: EventEnvelope) => void | Promise<void>): Promise<() => void> {
    const controller = new AbortController();
    const options: SubscribeOptions = {
      signer: await this.resolveSigner(sessionId),
      groupRef: this.groupRefForSession(sessionId),
      signal: controller.signal
    };

    void (async () => {
      try {
        for await (const message of this.client.subscribe(options)) {
          const envelope = parseEnvelopeText(message.text);
          if (envelope && envelope.sessionId === sessionId) {
            await handler(envelope);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }

  disconnect(): void {
    this.client.disconnect();
  }

  private async resolveSigner(sessionId: string): Promise<SuiStackMessagingSigner> {
    return typeof this.signer === "function" ? this.signer(sessionId) : this.signer;
  }
}


export function serializeEnvelope(envelope: EventEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelopeText(text: string): EventEnvelope | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<EventEnvelope>;
    if (parsed.protocol !== "suimesh" || parsed.version !== "0.1") {
      return undefined;
    }
    if (parsed.encoding !== "json-v1" && parsed.encoding !== "bcs-v1") {
      return undefined;
    }
    if (!parsed.eventType || !parsed.eventId || !parsed.sessionId || !parsed.actor || !parsed.payload) {
      return undefined;
    }
    return parsed as EventEnvelope;
  } catch {
    return undefined;
  }
}
