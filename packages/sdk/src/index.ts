import {
  ActorRoles,
  Encodings,
  EventTypes,
  SUI_PTB_ACTION_TYPE,
  SuiMeshConstants,
  actionManifests,
  actors,
  type ActionManifest,
  type Actor,
  type EventEnvelope,
  type EventHeader,
  type ExecutionReceipt,
  type JsonValue,
  type MemoryReceipt,
  type Policy,
  type PolicyDecision,
  type SuiPtbAction
} from "../../protocol/src/index.ts";
import { decodeEvent, encodeEvent, hashBytes, hashEvent, type DecodedEvent } from "../../codec/src/index.ts";
import type { ActionRegistry } from "../../action-registry/src/index.ts";
import {
  DefaultPtbInspector,
  LocalPtbSimulator,
  ptbBytesFromBase64Url,
  ptbBytesToBase64Url,
  type PtbInspectionResult,
  type PtbInspector,
  type PtbSimulator
} from "../../ptb-inspector/src/index.ts";
import { DefaultPolicyEngine, policyRules, type PolicyEngine } from "../../policy-engine/src/index.ts";
import { InMemoryEventTransport, type EventTransport } from "../../transport/src/index.ts";
import { MemWalAdapter, type MemoryAdapter } from "../../memwal-adapter/src/index.ts";
import { InMemoryStorageAdapter, type StorageAdapter } from "../../storage/src/index.ts";
import { LocalTraceGuard, verifyHashChain, type ActionAnchor, type ActionClaim, type TraceGuard } from "../../trace-guard/src/index.ts";

export interface SuiMeshClientConfig {
  transport?: EventTransport;
  messaging?: EventTransport;
  memory?: MemoryAdapter;
  storage?: StorageAdapter;
  inspector?: PtbInspector;
  simulator?: PtbSimulator;
  policyEngine?: PolicyEngine;
  traceGuard?: TraceGuard;
  actionRegistry?: ActionRegistry;
  defaultActor?: Actor;
}

export interface ProposePtbInput {
  sessionId: string;
  traceId: string;
  actor: Actor;
  ptbBytes: Uint8Array;
  manifest: Omit<ActionManifest, "actionType" | "ptbHash"> & {
    actionType?: typeof SUI_PTB_ACTION_TYPE;
    ptbHash?: string;
  };
  previousEventHash?: string;
  nowMs?: number;
}

export interface ProposePtbResult {
  action: SuiPtbAction;
  envelope: EventEnvelope;
  inspection: PtbInspectionResult;
}

export interface ExecuteApprovedInput {
  actionHash: string;
  claim: ActionClaim;
  decision: PolicyDecision;
  executor: Actor;
  execute: () => Promise<{ txDigest?: string; effectsHash?: string }>;
  nowMs?: number;
}

export interface RecordPolicyDecisionInput {
  sessionId: string;
  traceId: string;
  policy: Policy;
  facts: PtbInspectionResult["facts"];
  decider: Actor;
  previousEventHash?: string;
  nowMs?: number;
  policySnapshotRef?: string;
}

export interface RecordTraceAnchorInput {
  sessionId: string;
  traceId: string;
  actor: Actor;
  actionHash: string;
  proposalHash?: string;
  decisionHash?: string;
  owner?: string;
  authorizedExecutor?: string;
  expiresAtMs?: number;
  previousEventHash?: string;
  nowMs?: number;
}

export interface RecordTraceClaimInput {
  sessionId: string;
  traceId: string;
  actor: Actor;
  actionHash: string;
  decision: PolicyDecision;
  claimant?: string;
  claimLeaseMs?: number;
  previousEventHash?: string;
  nowMs?: number;
}

export interface ExecuteApprovedAndRecordInput extends ExecuteApprovedInput {
  sessionId: string;
  traceId: string;
  previousEventHash?: string;
}

export interface RecordMemoryInput {
  sessionId: string;
  traceId?: string;
  actor: Actor;
  namespace: string;
  previousEventHash?: string;
  nowMs?: number;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function header(input: {
  sessionId: string;
  traceId?: string;
  eventType: EventHeader["eventType"];
  actor: Actor;
  previousEventHash?: string;
  idempotencyKey?: string;
  nowMs?: number;
}): EventHeader {
  return {
    eventId: id("evt"),
    sessionId: input.sessionId,
    traceId: input.traceId,
    eventType: input.eventType,
    actor: input.actor,
    previousEventHash: input.previousEventHash,
    idempotencyKey: input.idempotencyKey,
    createdAtMs: input.nowMs ?? Date.now()
  };
}

export class SuiMeshClient {
  readonly constants = SuiMeshConstants;
  readonly actors = actors;
  readonly manifest = actionManifests;
  readonly policyRules = policyRules;
  readonly transport: EventTransport;
  readonly messaging: EventTransport;
  readonly memory: MemoryAdapter;
  readonly storage: StorageAdapter;
  readonly inspector: PtbInspector;
  readonly simulator: PtbSimulator;
  readonly policyEngine: PolicyEngine;
  readonly traceGuard: TraceGuard;
  readonly defaultActor: Actor;

  constructor(config: SuiMeshClientConfig = {}) {
    this.transport = config.transport ?? config.messaging ?? new InMemoryEventTransport();
    this.messaging = this.transport;
    this.memory = config.memory ?? new MemWalAdapter({});
    this.storage = config.storage ?? new InMemoryStorageAdapter();
    this.inspector = config.inspector ?? new DefaultPtbInspector(config.actionRegistry);
    this.simulator = config.simulator ?? new LocalPtbSimulator();
    this.policyEngine = config.policyEngine ?? new DefaultPolicyEngine();
    this.traceGuard = config.traceGuard ?? new LocalTraceGuard();
    this.defaultActor = config.defaultActor ?? actors.system("suimesh-sdk");
  }

  light = {
    sendMessage: async (input: {
      sessionId: string;
      actor: Actor;
      content: string;
      traceId?: string;
      previousEventHash?: string;
      nowMs?: number;
    }): Promise<EventEnvelope> => {
      const envelope = encodeEvent({
        encoding: Encodings.JsonV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: input.actor.role === ActorRoles.Agent ? EventTypes.AgentMessage : EventTypes.UserMessage,
          actor: input.actor,
          previousEventHash: input.previousEventHash,
          nowMs: input.nowMs
        }),
        payload: {
          content: input.content
        }
      });
      await this.transport.send(envelope);
      return envelope;
    }
  };

  actions = {
    proposePtb: async (input: ProposePtbInput): Promise<ProposePtbResult> => {
      const ptbHash = hashBytes(input.ptbBytes);
      const manifest: ActionManifest = {
        ...input.manifest,
        actionType: SUI_PTB_ACTION_TYPE,
        ptbHash
      };
      const inspection = await this.inspectPtb(input.ptbBytes, manifest);
      const validation = this.inspector.validateManifest(manifest, inspection.facts);
      if (!validation.ok) {
        throw new Error(`Invalid ActionManifest: ${validation.errors.join("; ")}`);
      }
      const action: SuiPtbAction = {
        actionType: SUI_PTB_ACTION_TYPE,
        ptbBytes: ptbBytesToBase64Url(input.ptbBytes),
        manifest
      };
      const envelope = encodeEvent({
        encoding: Encodings.BcsV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: EventTypes.SuiPtbAction,
          actor: input.actor,
          previousEventHash: input.previousEventHash,
          idempotencyKey: manifest.idempotencyKey,
          nowMs: input.nowMs
        }),
        payload: action as unknown as JsonValue
      });
      await this.transport.send(envelope);
      return {
        action,
        envelope,
        inspection
      };
    },

    inspect: async (action: SuiPtbAction): Promise<PtbInspectionResult> => {
      return this.inspectPtb(ptbBytesFromBase64Url(action.ptbBytes), action.manifest);
    },

    simulate: async (action: SuiPtbAction): Promise<PtbInspectionResult> => {
      const ptbBytes = ptbBytesFromBase64Url(action.ptbBytes);
      const result = await this.inspectPtb(ptbBytes, action.manifest);
      result.facts.simulation = await this.simulator.simulate({
        ptbBytes,
        manifest: action.manifest,
        facts: result.facts
      });
      return result;
    },

    executeApproved: async (input: ExecuteApprovedInput): Promise<ExecutionReceipt> => {
      if (input.decision.decision !== "approved") {
        throw new Error("Cannot execute without approved PolicyDecision");
      }
      if (!input.claim.claimed || input.claim.duplicate) {
        throw new Error("Cannot execute without successful non-duplicate ActionClaim");
      }
      const nowMs = input.nowMs ?? Date.now();
      const anchor = await this.traceGuard.getAnchor(input.actionHash);
      if (anchor?.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
        throw new Error("Cannot execute expired action");
      }
      if (anchor?.claimExpiresAtMs !== undefined && anchor.claimExpiresAtMs <= nowMs) {
        throw new Error("Cannot execute after claim lease expired");
      }
      const result = await input.execute();
      const receipt: ExecutionReceipt = {
        actionHash: input.actionHash,
        claimId: input.claim.claimId,
        executor: input.executor,
        status: "success",
        txDigest: result.txDigest,
        effectsHash: result.effectsHash,
        createdAtMs: nowMs
      };
      await this.traceGuard.complete({ actionHash: input.actionHash, receipt, nowMs });
      return receipt;
    }
  };

  policy = {
    evaluate: (input: {
      policy: Policy;
      facts: PtbInspectionResult["facts"];
      decider: Actor;
      nowMs?: number;
      policySnapshotRef?: string;
    }): PolicyDecision => {
      return this.policyEngine.evaluate(input);
    },

    evaluateAndRecord: async (input: RecordPolicyDecisionInput): Promise<{ decision: PolicyDecision; envelope: EventEnvelope }> => {
      const decision = this.policyEngine.evaluate(input);
      const envelope = encodeEvent({
        encoding: Encodings.BcsV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: EventTypes.PolicyDecision,
          actor: input.decider,
          previousEventHash: input.previousEventHash,
          nowMs: input.nowMs
        }),
        payload: decision as unknown as JsonValue
      });
      await this.transport.send(envelope);
      return { decision, envelope };
    }
  };

  memoryOps = {
    recallAndRecord: async (input: RecordMemoryInput & { query: string }): Promise<{
      memories: unknown[];
      receipt: MemoryReceipt;
      envelope: EventEnvelope;
    }> => {
      const { memories, receipt } = await this.memory.recall(input);
      const envelope = await this.recordMemoryReceipt(input, receipt);
      return { memories, receipt, envelope };
    },

    rememberAndRecord: async (input: RecordMemoryInput & { content: unknown }): Promise<{
      receipt: MemoryReceipt;
      envelope: EventEnvelope;
    }> => {
      const receipt = await this.memory.remember(input);
      const envelope = await this.recordMemoryReceipt(input, receipt);
      return { receipt, envelope };
    }
  };

  trace = {
    anchorAndRecord: async (input: RecordTraceAnchorInput): Promise<{ anchor: ActionAnchor; envelope: EventEnvelope }> => {
      const anchor = await this.traceGuard.anchor(input);
      const envelope = encodeEvent({
        encoding: Encodings.BcsV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: EventTypes.ActionAnchor,
          actor: input.actor,
          previousEventHash: input.previousEventHash,
          nowMs: input.nowMs
        }),
        payload: anchor as unknown as JsonValue
      });
      await this.transport.send(envelope);
      return { anchor, envelope };
    },

    claimAndRecord: async (input: RecordTraceClaimInput): Promise<{ claim: ActionClaim; envelope: EventEnvelope }> => {
      const claim = await this.traceGuard.claim({
        ...input,
        claimant: input.claimant ?? input.actor.address
      });
      const envelope = encodeEvent({
        encoding: Encodings.BcsV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: EventTypes.ActionClaim,
          actor: input.actor,
          previousEventHash: input.previousEventHash,
          nowMs: input.nowMs
        }),
        payload: claim as unknown as JsonValue
      });
      await this.transport.send(envelope);
      return { claim, envelope };
    },

    executeApprovedAndRecord: async (input: ExecuteApprovedAndRecordInput): Promise<{ receipt: ExecutionReceipt; envelope: EventEnvelope }> => {
      const receipt = await this.actions.executeApproved(input);
      const envelope = encodeEvent({
        encoding: Encodings.BcsV1,
        header: header({
          sessionId: input.sessionId,
          traceId: input.traceId,
          eventType: EventTypes.ExecutionReceipt,
          actor: input.executor,
          previousEventHash: input.previousEventHash,
          nowMs: input.nowMs
        }),
        payload: receipt as unknown as JsonValue
      });
      await this.transport.send(envelope);
      return { receipt, envelope };
    },

    restore: async (sessionId: string): Promise<EventEnvelope[]> => {
      return this.transport.list(sessionId);
    },
    verify: async (sessionId: string) => {
      const events = await this.transport.list(sessionId);
      const errors: string[] = [];
      const decodedEvents: DecodedEvent[] = [];
      for (const event of events) {
        try {
          decodedEvents.push(decodeEvent(event));
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      const chain = verifyHashChain(events);
      const traceStateErrors = verifyTraceState(decodedEvents);
      return {
        ok: errors.length === 0 && chain.ok && traceStateErrors.length === 0,
        errors: [...errors, ...chain.errors, ...traceStateErrors]
      };
    }
  };

  codec = {
    encodeEvent,
    decodeEvent,
    hashEvent
  };

  private async recordMemoryReceipt(input: RecordMemoryInput, receipt: MemoryReceipt): Promise<EventEnvelope> {
    const envelope = encodeEvent({
      encoding: Encodings.JsonV1,
      header: header({
        sessionId: input.sessionId,
        traceId: input.traceId,
        eventType: EventTypes.MemoryReceipt,
        actor: input.actor,
        previousEventHash: input.previousEventHash,
        nowMs: input.nowMs
      }),
      payload: receipt as unknown as JsonValue
    });
    await this.transport.send(envelope);
    return envelope;
  }

  private async inspectPtb(ptbBytes: Uint8Array, manifest?: ActionManifest): Promise<PtbInspectionResult> {
    return this.inspector.inspectAsync
      ? this.inspector.inspectAsync(ptbBytes, manifest)
      : this.inspector.inspect(ptbBytes, manifest);
  }
}

export function createSuiMeshClient(config: SuiMeshClientConfig = {}): SuiMeshClient {
  return new SuiMeshClient(config);
}

type MutableTraceState = {
  proposalSeen: boolean;
  approvedActions: Set<string>;
  anchoredActions: Set<string>;
  claimedActions: Set<string>;
  executedActions: Set<string>;
};

function objectPayload(event: DecodedEvent): Record<string, JsonValue> | undefined {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, JsonValue>
    : undefined;
}

function stringField(input: Record<string, JsonValue> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(input: Record<string, JsonValue> | undefined, key: string): boolean | undefined {
  const value = input?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function traceStateFor(states: Map<string, MutableTraceState>, traceId: string): MutableTraceState {
  const existing = states.get(traceId);
  if (existing) {
    return existing;
  }
  const created: MutableTraceState = {
    proposalSeen: false,
    approvedActions: new Set(),
    anchoredActions: new Set(),
    claimedActions: new Set(),
    executedActions: new Set()
  };
  states.set(traceId, created);
  return created;
}

function verifyTraceState(events: DecodedEvent[]): string[] {
  const errors: string[] = [];
  const states = new Map<string, MutableTraceState>();

  for (const event of events) {
    const traceId = event.header.traceId;
    if (!traceId) {
      continue;
    }
    const state = traceStateFor(states, traceId);
    const payload = objectPayload(event);

    if (event.header.eventType === EventTypes.SuiPtbAction) {
      state.proposalSeen = true;
      continue;
    }

    if (event.header.eventType === EventTypes.PolicyDecision) {
      const actionHash = stringField(payload, "actionHash");
      const decision = stringField(payload, "decision");
      if (!state.proposalSeen) {
        errors.push(`trace ${traceId} policy decision appears before action proposal`);
      }
      if (actionHash && decision === "approved") {
        state.approvedActions.add(actionHash);
      }
      continue;
    }

    if (event.header.eventType === EventTypes.ActionAnchor) {
      const actionHash = stringField(payload, "actionHash");
      if (!actionHash) {
        errors.push(`trace ${traceId} action anchor is missing actionHash`);
      } else {
        if (!state.approvedActions.has(actionHash)) {
          errors.push(`trace ${traceId} action ${actionHash} anchored without approved PolicyDecision`);
        }
        state.anchoredActions.add(actionHash);
      }
      continue;
    }

    if (event.header.eventType === EventTypes.ActionClaim) {
      const actionHash = stringField(payload, "actionHash");
      const claimed = booleanField(payload, "claimed");
      const duplicate = booleanField(payload, "duplicate");
      if (!actionHash) {
        errors.push(`trace ${traceId} action claim is missing actionHash`);
      } else {
        if (!state.anchoredActions.has(actionHash)) {
          errors.push(`trace ${traceId} action ${actionHash} claimed without ActionAnchor`);
        }
        if (claimed === true && duplicate !== true) {
          state.claimedActions.add(actionHash);
        }
      }
      continue;
    }

    if (event.header.eventType === EventTypes.ExecutionReceipt) {
      const actionHash = stringField(payload, "actionHash");
      if (!actionHash) {
        errors.push(`trace ${traceId} execution receipt is missing actionHash`);
      } else {
        if (!state.claimedActions.has(actionHash)) {
          errors.push(`trace ${traceId} action ${actionHash} executed without successful ActionClaim`);
        }
        state.executedActions.add(actionHash);
      }
      continue;
    }

    if (event.header.eventType === EventTypes.AuditEvent) {
      const eventHash = stringField(payload, "eventHash");
      const previousEventHash = stringField(payload, "previousEventHash");
      if (!eventHash && !previousEventHash && state.executedActions.size === 0) {
        errors.push(`trace ${traceId} audit event appears before execution evidence`);
      }
    }
  }

  return errors;
}
