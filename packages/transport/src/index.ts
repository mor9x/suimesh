import type { Actor, EventEnvelope, JsonValue } from "../../protocol/src/index.ts";

export interface EventTransport {
  send(envelope: EventEnvelope): Promise<void>;
  list(sessionId: string): Promise<EventEnvelope[]>;
  subscribe(sessionId: string, handler: (envelope: EventEnvelope) => void | Promise<void>): Promise<() => void>;
}

export interface AuthorizedSession {
  sessionId: string;
  transport?: string;
  accessRef?: string;
  name?: string;
  discoveredAtMs?: number;
  metadata?: Record<string, JsonValue>;
}

export interface SessionDiscoveryAdapter {
  discoverAuthorizedSessions(actor: Actor | string): Promise<AuthorizedSession[]>;
}

export interface SessionAccessController {
  createSession?(input: { owner: Actor; name?: string; metadata?: Record<string, JsonValue> }): Promise<AuthorizedSession>;
  grantAccess?(input: { sessionId: string; actor: Actor; permissions?: string[] }): Promise<void>;
  revokeAccess?(input: { sessionId: string; actor: Actor; permissions?: string[] }): Promise<void>;
}

export class InMemoryEventTransport implements EventTransport {
  private readonly events = new Map<string, EventEnvelope[]>();
  private readonly subscribers = new Map<string, Set<(envelope: EventEnvelope) => void | Promise<void>>>();

  async send(envelope: EventEnvelope): Promise<void> {
    const list = this.events.get(envelope.sessionId) ?? [];
    list.push(envelope);
    this.events.set(envelope.sessionId, list);
    for (const handler of this.subscribers.get(envelope.sessionId) ?? []) {
      await handler(envelope);
    }
  }

  async list(sessionId: string): Promise<EventEnvelope[]> {
    return [...(this.events.get(sessionId) ?? [])];
  }

  async subscribe(sessionId: string, handler: (envelope: EventEnvelope) => void | Promise<void>): Promise<() => void> {
    const handlers = this.subscribers.get(sessionId) ?? new Set();
    handlers.add(handler);
    this.subscribers.set(sessionId, handlers);
    return () => {
      handlers.delete(handler);
    };
  }
}
