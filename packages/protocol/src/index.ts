export const SUIMESH_PROTOCOL = "suimesh" as const;
export const SUIMESH_VERSION = "0.1" as const;
export const SUI_PTB_ACTION_TYPE = "sui.ptb.v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type Encoding = "json-v1" | "bcs-v1";

export type ActorRole =
  | "user"
  | "agent"
  | "policy"
  | "executor"
  | "memory"
  | "system"
  | "dapp"
  | "wallet";

export interface Actor {
  role: ActorRole;
  id: string;
  address?: string;
  publicKey?: string;
}

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

export type EventType =
  | "conversation.user_message.v1"
  | "conversation.agent_message.v1"
  | "context.memory_receipt.v1"
  | "decision.intent.v1"
  | "decision.proposal.v1"
  | "decision.sui_ptb_action.v1"
  | "decision.policy_decision.v1"
  | "trace.action_anchor.v1"
  | "trace.action_claim.v1"
  | "outcome.execution_receipt.v1"
  | "outcome.audit_event.v1";

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

export type TraceState =
  | "proposed"
  | "inspected"
  | "simulated"
  | "policy_approved"
  | "policy_rejected"
  | "requires_confirmation"
  | "anchored"
  | "claimed"
  | "executed"
  | "failed"
  | "expired"
  | "revoked";

export type SemanticType =
  | "transfer"
  | "move_call"
  | "swap"
  | "copy_trade"
  | "prediction_market"
  | "unknown"
  | (string & {});

export type ActionTemplate = "transfer" | "move_call" | "custom";
export type RiskLevel = "low" | "medium" | "high" | "critical";

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

export type PolicyDecisionValue = "approved" | "rejected" | "requires_confirmation";

export interface PolicyRule {
  name:
    | "max_value_at_risk"
    | "recipient_allowlist"
    | "package_allowlist"
    | "function_allowlist"
    | "slippage_limit"
    | "expiration_check"
    | "risk_level_guard"
    | "unknown_contract_guard";
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
  status: "success" | "failed";
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
  provider: "memwal" | "external" | "none";
  operation: "recall" | "remember";
  namespace?: string;
  memoryRef?: string;
  memoryHash?: string;
  createdAtMs: number;
}
