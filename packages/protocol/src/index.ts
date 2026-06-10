export const SUIMESH_PROTOCOL = "suimesh" as const;
export const SUIMESH_VERSION = "0.1" as const;
export const SUI_PTB_ACTION_TYPE = "sui.ptb.v1" as const;
export const DEFAULT_ACTION_TTL_MS = 5 * 60 * 1000;

export const Encodings = {
  JsonV1: "json-v1",
  BcsV1: "bcs-v1"
} as const;

export const ActorRoles = {
  User: "user",
  Agent: "agent",
  Policy: "policy",
  Executor: "executor",
  Memory: "memory",
  System: "system",
  Dapp: "dapp",
  Wallet: "wallet"
} as const;

export const EventTypes = {
  UserMessage: "conversation.user_message.v1",
  AgentMessage: "conversation.agent_message.v1",
  MemoryReceipt: "context.memory_receipt.v1",
  Intent: "decision.intent.v1",
  Proposal: "decision.proposal.v1",
  SuiPtbAction: "decision.sui_ptb_action.v1",
  PolicyDecision: "decision.policy_decision.v1",
  ActionAnchor: "trace.action_anchor.v1",
  ActionClaim: "trace.action_claim.v1",
  ExecutionReceipt: "outcome.execution_receipt.v1",
  AuditEvent: "outcome.audit_event.v1"
} as const;

export const TraceStates = {
  Proposed: "proposed",
  Inspected: "inspected",
  Simulated: "simulated",
  PolicyApproved: "policy_approved",
  PolicyRejected: "policy_rejected",
  RequiresConfirmation: "requires_confirmation",
  Anchored: "anchored",
  Claimed: "claimed",
  Executed: "executed",
  Failed: "failed",
  Expired: "expired",
  Revoked: "revoked"
} as const;

export const SemanticTypes = {
  Transfer: "transfer",
  MoveCall: "move_call",
  Swap: "swap",
  CopyTrade: "copy_trade",
  PredictionMarket: "prediction_market",
  Unknown: "unknown"
} as const;

export const ActionTemplates = {
  Transfer: "transfer",
  MoveCall: "move_call",
  Custom: "custom"
} as const;

export const RiskLevels = {
  Low: "low",
  Medium: "medium",
  High: "high",
  Critical: "critical"
} as const;

export const PolicyDecisionValues = {
  Approved: "approved",
  Rejected: "rejected",
  RequiresConfirmation: "requires_confirmation"
} as const;

export const PolicyRuleNames = {
  MaxValueAtRisk: "max_value_at_risk",
  RecipientAllowlist: "recipient_allowlist",
  PackageAllowlist: "package_allowlist",
  FunctionAllowlist: "function_allowlist",
  SlippageLimit: "slippage_limit",
  ExpirationCheck: "expiration_check",
  RiskLevelGuard: "risk_level_guard",
  UnknownContractGuard: "unknown_contract_guard"
} as const;

export const ExecutionStatuses = {
  Success: "success",
  Failed: "failed"
} as const;

export const MemoryProviders = {
  MemWal: "memwal",
  External: "external",
  None: "none"
} as const;

export const MemoryOperations = {
  Recall: "recall",
  Remember: "remember"
} as const;

export const SuiMeshConstants = {
  protocol: SUIMESH_PROTOCOL,
  version: SUIMESH_VERSION,
  encodings: Encodings,
  actorRoles: ActorRoles,
  eventTypes: EventTypes,
  traceStates: TraceStates,
  actionType: SUI_PTB_ACTION_TYPE,
  semanticTypes: SemanticTypes,
  actionTemplates: ActionTemplates,
  riskLevels: RiskLevels,
  policyDecisionValues: PolicyDecisionValues,
  policyRuleNames: PolicyRuleNames,
  executionStatuses: ExecutionStatuses,
  memoryProviders: MemoryProviders,
  memoryOperations: MemoryOperations
} as const;

type ConstantValue<T extends Record<string, string>> = T[keyof T];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Encoding = ConstantValue<typeof Encodings>;

export type ActorRole = ConstantValue<typeof ActorRoles>;

export interface Actor {
  role: ActorRole;
  id: string;
  address?: string;
  publicKey?: string;
}

export type ActorInput = Partial<Omit<Actor, "role" | "id">>;

export function createActor(role: ActorRole, id: string, input: ActorInput = {}): Actor {
  return {
    role,
    id,
    ...input
  };
}

export const actors = {
  user: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.User, id, input),
  agent: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Agent, id, input),
  policy: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Policy, id, input),
  executor: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Executor, id, input),
  memory: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Memory, id, input),
  system: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.System, id, input),
  dapp: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Dapp, id, input),
  wallet: (id: string, input?: ActorInput): Actor => createActor(ActorRoles.Wallet, id, input)
} as const;

export function actorToString(actor: Actor): string {
  return actor.address ? `${actor.role}:${actor.id}@${actor.address}` : `${actor.role}:${actor.id}`;
}

export function actorFromString(value: string): Actor {
  const separator = value.indexOf(":");
  const role = separator >= 0 ? value.slice(0, separator) : "system";
  const rest = separator >= 0 ? value.slice(separator + 1) : value;
  const addressSeparator = rest.lastIndexOf("@");
  return {
    role: role as ActorRole,
    id: addressSeparator >= 0 ? rest.slice(0, addressSeparator) : rest,
    address: addressSeparator >= 0 ? rest.slice(addressSeparator + 1) : undefined
  };
}

export type EventType = ConstantValue<typeof EventTypes>;

export interface EventHeader {
  eventId: string;
  sessionId: string;
  traceId?: string;
  eventType: EventType;
  actor: Actor;
  previousEventHash?: string;
  idempotencyKey?: string;
  createdAtMs: number;
}

export interface JsonEnvelope {
  protocol: typeof SUIMESH_PROTOCOL;
  version: typeof SUIMESH_VERSION;
  encoding: "json-v1";
  eventType: EventType;
  eventId: string;
  sessionId: string;
  traceId?: string;
  actor: string;
  eventHash?: string;
  previousEventHash?: string;
  idempotencyKey?: string;
  createdAtMs?: number;
  payload: JsonValue;
  signature?: string;
}

export interface BcsEnvelope {
  protocol: typeof SUIMESH_PROTOCOL;
  version: typeof SUIMESH_VERSION;
  encoding: "bcs-v1";
  eventType: EventType;
  eventId: string;
  sessionId: string;
  traceId?: string;
  actor: string;
  eventHash: string;
  previousEventHash?: string;
  idempotencyKey?: string;
  createdAtMs?: number;
  payload: {
    bcs: string;
  };
  signature?: string;
}

export type EventEnvelope = JsonEnvelope | BcsEnvelope;

export type TraceState = ConstantValue<typeof TraceStates>;

export type SemanticType =
  | ConstantValue<typeof SemanticTypes>
  | (string & {});

export type ActionTemplate = ConstantValue<typeof ActionTemplates>;
export type RiskLevel = ConstantValue<typeof RiskLevels>;

export interface PrimaryTarget {
  packageId: string;
  module: string;
  function: string;
}

export interface ValueAtRisk {
  amount: string;
  coinType: string;
  decimals?: number;
}

export interface ActionManifest {
  actionId: string;
  traceId: string;
  actionType: typeof SUI_PTB_ACTION_TYPE;
  semanticType: SemanticType;
  template: ActionTemplate;
  summary: string;
  riskLevel: RiskLevel;
  valueAtRisk?: ValueAtRisk;
  primaryTarget?: PrimaryTarget;
  objectsTouched: string[];
  policyRequirements: string[];
  ptbHash: string;
  expiresAtMs: number;
  idempotencyKey: string;
}

export type ActionManifestDraft = Omit<ActionManifest, "actionType" | "ptbHash">;

export interface CreatePtbManifestInput {
  actionId?: string;
  traceId: string;
  semanticType?: SemanticType;
  template?: ActionTemplate;
  summary?: string;
  riskLevel?: RiskLevel;
  valueAtRisk?: ValueAtRisk;
  primaryTarget?: PrimaryTarget;
  objectsTouched?: string[];
  policyRequirements?: string[];
  expiresAtMs?: number;
  ttlMs?: number;
  idempotencyKey?: string;
  nowMs?: number;
}

export interface CreateTransferManifestInput extends Omit<CreatePtbManifestInput, "semanticType" | "template" | "valueAtRisk" | "objectsTouched" | "policyRequirements"> {
  amount: string;
  coinType: string;
  recipient?: string;
  objectIds: string[];
  policyRequirements?: string[];
}

export interface CreateMoveCallManifestInput extends Omit<CreatePtbManifestInput, "semanticType" | "template" | "primaryTarget" | "policyRequirements"> {
  target: PrimaryTarget;
  policyRequirements?: string[];
}

function protocolId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function expiresAt(input: { expiresAtMs?: number; ttlMs?: number; nowMs?: number }): number {
  return input.expiresAtMs ?? ((input.nowMs ?? Date.now()) + (input.ttlMs ?? DEFAULT_ACTION_TTL_MS));
}

export function createPtbManifest(input: CreatePtbManifestInput): ActionManifestDraft {
  return {
    actionId: input.actionId ?? protocolId("act"),
    traceId: input.traceId,
    semanticType: input.semanticType ?? SemanticTypes.Unknown,
    template: input.template ?? ActionTemplates.Custom,
    summary: input.summary ?? "Sui PTB action",
    riskLevel: input.riskLevel ?? RiskLevels.High,
    valueAtRisk: input.valueAtRisk,
    primaryTarget: input.primaryTarget,
    objectsTouched: input.objectsTouched ?? [],
    policyRequirements: input.policyRequirements ?? [],
    expiresAtMs: expiresAt(input),
    idempotencyKey: input.idempotencyKey ?? protocolId("idem")
  };
}

export const actionManifests = {
  ptb: createPtbManifest,
  transfer: (input: CreateTransferManifestInput): ActionManifestDraft => createPtbManifest({
    ...input,
    semanticType: SemanticTypes.Transfer,
    template: ActionTemplates.Transfer,
    summary: input.summary ?? `Transfer ${input.amount} ${input.coinType}${input.recipient ? ` to ${input.recipient}` : ""}`,
    riskLevel: input.riskLevel ?? RiskLevels.Medium,
    valueAtRisk: { amount: input.amount, coinType: input.coinType },
    objectsTouched: input.objectIds ?? [],
    policyRequirements: input.policyRequirements ?? [
      PolicyRuleNames.MaxValueAtRisk,
      PolicyRuleNames.RecipientAllowlist,
      PolicyRuleNames.ExpirationCheck
    ]
  }),
  moveCall: (input: CreateMoveCallManifestInput): ActionManifestDraft => createPtbManifest({
    ...input,
    semanticType: SemanticTypes.MoveCall,
    template: ActionTemplates.MoveCall,
    summary: input.summary ?? `Call ${input.target.packageId}::${input.target.module}::${input.target.function}`,
    riskLevel: input.riskLevel ?? RiskLevels.High,
    primaryTarget: input.target,
    policyRequirements: input.policyRequirements ?? [
      PolicyRuleNames.PackageAllowlist,
      PolicyRuleNames.FunctionAllowlist,
      PolicyRuleNames.ExpirationCheck
    ]
  })
} as const;

export interface SuiPtbAction {
  actionType: typeof SUI_PTB_ACTION_TYPE;
  ptbBytes: string;
  manifest: ActionManifest;
}

export interface MoveCallFact extends PrimaryTarget {
  selector: string;
  typeArguments: string[];
  arguments: JsonValue[];
}

export interface TransferFact {
  recipient: string;
  amount: string;
  coinType: string;
  objectIds: string[];
}

export interface PolicyFacts {
  actionHash: string;
  manifestHash: string;
  ptbHash: string;
  semanticType: SemanticType;
  riskLevel: RiskLevel;
  expiresAtMs?: number;
  moveCalls: MoveCallFact[];
  transfers: TransferFact[];
  objectsTouched: string[];
  packagesTouched: string[];
  valueAtRisk?: ValueAtRisk;
  policyRequirements: string[];
  simulation?: SimulationResult;
  warnings: string[];
}

export interface SimulationResult {
  ok: boolean;
  gasEstimate?: string;
  balanceChanges?: JsonValue[];
  objectChanges?: JsonValue[];
  events?: JsonValue[];
  error?: string;
}

export type PolicyDecisionValue = ConstantValue<typeof PolicyDecisionValues>;

export interface PolicyRule {
  name: ConstantValue<typeof PolicyRuleNames>;
  params: JsonValue;
}

export interface Policy {
  id: string;
  version: string;
  rules: PolicyRule[];
}

export interface PolicySnapshot {
  policyHash: string;
  policyVersion: string;
  policyRef?: string;
  policy: Policy;
}

export interface PolicyDecision {
  actionHash: string;
  policyHash: string;
  policyVersion: string;
  policySnapshotRef?: string;
  evaluatedFactsHash: string;
  decision: PolicyDecisionValue;
  reason: string;
  decider: Actor;
  createdAtMs: number;
}

export interface ExecutionReceipt {
  actionHash: string;
  claimId: string;
  executor: Actor;
  status: ConstantValue<typeof ExecutionStatuses>;
  txDigest?: string;
  effectsHash?: string;
  error?: string;
  createdAtMs: number;
}

export interface AuditEvent {
  traceId: string;
  state: TraceState;
  eventHash: string;
  previousEventHash?: string;
  detailRef?: string;
  createdAtMs: number;
}

export interface MemoryReceipt {
  provider: ConstantValue<typeof MemoryProviders>;
  operation: ConstantValue<typeof MemoryOperations>;
  namespace?: string;
  memoryRef?: string;
  memoryHash?: string;
  createdAtMs: number;
}
