import type { EventEnvelope, ExecutionReceipt, JsonValue, PolicyDecision, TraceState } from "../../protocol/src/index.ts";
import { bytesToHex, bytesToUtf8, hashJson, hexToBytes, utf8ToBytes } from "../../codec/src/index.ts";
import { Transaction } from "@mysten/sui/transactions";
import type { Signer } from "@mysten/sui/cryptography";

export interface ActionAnchor {
  anchorId: string;
  traceId: string;
  actionHash: string;
  proposalHash?: string;
  decisionHash?: string;
  receiptHash?: string;
  owner?: string;
  authorizedExecutor?: string;
  claimant?: string;
  status: TraceState;
  expiresAtMs?: number;
  claimExpiresAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ActionClaim {
  claimId: string;
  actionHash: string;
  claimant?: string;
  claimed: boolean;
  duplicate: boolean;
  claimExpiresAtMs?: number;
  createdAtMs: number;
}

export interface TraceGuard {
  anchor(input: {
    traceId: string;
    actionHash: string;
    proposalHash?: string;
    decisionHash?: string;
    owner?: string;
    authorizedExecutor?: string;
    expiresAtMs?: number;
    nowMs?: number;
  }): Promise<ActionAnchor>;
  claim(input: { actionHash: string; decision: PolicyDecision; claimant?: string; claimLeaseMs?: number; nowMs?: number }): Promise<ActionClaim>;
  complete(input: { actionHash: string; receipt: ExecutionReceipt; nowMs?: number }): Promise<ActionAnchor>;
  fail(input: { actionHash: string; reason: string; claimant?: string; nowMs?: number }): Promise<ActionAnchor>;
  getAnchor(actionHash: string): Promise<ActionAnchor | undefined>;
}

const DEFAULT_ACTION_TTL_MS = 10 * 60_000;
const DEFAULT_CLAIM_LEASE_MS = 2 * 60_000;
const LOCAL_ANONYMOUS_CLAIMANT = "local:anonymous";

export class LocalTraceGuard implements TraceGuard {
  private readonly anchors = new Map<string, ActionAnchor>();

  async anchor(input: {
    traceId: string;
    actionHash: string;
    proposalHash?: string;
    decisionHash?: string;
    owner?: string;
    authorizedExecutor?: string;
    expiresAtMs?: number;
    nowMs?: number;
  }): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    const existing = this.anchors.get(input.actionHash);
    if (existing) {
      throw new Error("Action already anchored");
    }
    const expiresAtMs = input.expiresAtMs ?? nowMs + DEFAULT_ACTION_TTL_MS;
    if (expiresAtMs <= nowMs) {
      throw new Error("Cannot anchor an already expired action");
    }
    if (input.authorizedExecutor && isZeroAddress(input.authorizedExecutor)) {
      throw new Error("Cannot anchor action with zero authorized executor");
    }
    const next: ActionAnchor = {
      anchorId: hashJson({ traceId: input.traceId, actionHash: input.actionHash }),
      traceId: input.traceId,
      actionHash: input.actionHash,
      proposalHash: input.proposalHash,
      decisionHash: input.decisionHash,
      owner: input.owner,
      authorizedExecutor: input.authorizedExecutor,
      status: "anchored",
      expiresAtMs,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    };
    this.anchors.set(input.actionHash, next);
    return next;
  }

  async claim(input: { actionHash: string; decision: PolicyDecision; claimant?: string; claimLeaseMs?: number; nowMs?: number }): Promise<ActionClaim> {
    if (input.decision.decision !== "approved") {
      throw new Error("Cannot claim an action without approved PolicyDecision");
    }
    if (input.decision.actionHash !== input.actionHash) {
      throw new Error("Cannot claim with PolicyDecision for a different action");
    }
    const nowMs = input.nowMs ?? Date.now();
    const anchor = this.anchors.get(input.actionHash);
    if (!anchor) {
      throw new Error("Cannot claim unanchored action");
    }
    if (anchor.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
      throw new Error("Cannot claim expired action");
    }
    if (anchor.authorizedExecutor && input.claimant && input.claimant !== anchor.authorizedExecutor) {
      throw new Error("Cannot claim action with unauthorized executor");
    }
    const duplicate = anchor.status === "claimed" && (anchor.claimExpiresAtMs ?? Number.POSITIVE_INFINITY) > nowMs;
    const claimant = input.claimant ?? anchor.authorizedExecutor ?? LOCAL_ANONYMOUS_CLAIMANT;
    const claimLeaseMs = input.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (claimLeaseMs <= 0) {
      throw new Error("Cannot claim action with non-positive claim lease");
    }
    const claimExpiresAtMs = nowMs + claimLeaseMs;
    if (!duplicate) {
      this.anchors.set(input.actionHash, {
        ...anchor,
        claimant,
        status: "claimed",
        claimExpiresAtMs,
        updatedAtMs: nowMs
      });
    }
    return {
      claimId: hashJson({ actionHash: input.actionHash, decisionHash: input.decision.evaluatedFactsHash }),
      actionHash: input.actionHash,
      claimant,
      claimed: !duplicate,
      duplicate,
      claimExpiresAtMs: duplicate ? anchor.claimExpiresAtMs : claimExpiresAtMs,
      createdAtMs: nowMs
    };
  }

  async complete(input: { actionHash: string; receipt: ExecutionReceipt; nowMs?: number }): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    if (input.receipt.actionHash !== input.actionHash) {
      throw new Error("Cannot complete with receipt for a different action");
    }
    const anchor = this.anchors.get(input.actionHash);
    if (!anchor) {
      throw new Error("Cannot complete unanchored action");
    }
    if (anchor.status !== "claimed") {
      throw new Error("Cannot complete unclaimed action");
    }
    const executorAddress = input.receipt.executor.address;
    if (anchor.claimant && executorAddress && executorAddress !== anchor.claimant) {
      throw new Error("Cannot complete action with unauthorized claimant");
    }
    if (anchor.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
      throw new Error("Cannot complete expired action");
    }
    if (anchor.claimExpiresAtMs !== undefined && anchor.claimExpiresAtMs <= nowMs) {
      throw new Error("Cannot complete action after claim lease expired");
    }
    const next: ActionAnchor = {
      ...anchor,
      receiptHash: hashJson(input.receipt as unknown as JsonValue),
      status: input.receipt.status === "success" ? "executed" : "failed",
      updatedAtMs: nowMs
    };
    this.anchors.set(input.actionHash, next);
    return next;
  }

  async fail(input: { actionHash: string; reason: string; claimant?: string; nowMs?: number }): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    const anchor = this.anchors.get(input.actionHash);
    if (!anchor) {
      throw new Error("Cannot fail unanchored action");
    }
    if (anchor.status !== "claimed") {
      throw new Error("Cannot fail unclaimed action");
    }
    if (anchor.claimant && input.claimant && input.claimant !== anchor.claimant) {
      throw new Error("Cannot fail action with unauthorized claimant");
    }
    if (anchor.expiresAtMs !== undefined && anchor.expiresAtMs <= nowMs) {
      throw new Error("Cannot fail expired action");
    }
    if (anchor.claimExpiresAtMs !== undefined && anchor.claimExpiresAtMs <= nowMs) {
      throw new Error("Cannot fail action after claim lease expired");
    }
    const next: ActionAnchor = {
      ...anchor,
      status: "failed",
      updatedAtMs: nowMs
    };
    this.anchors.set(input.actionHash, next);
    return next;
  }

  async getAnchor(actionHash: string): Promise<ActionAnchor | undefined> {
    return this.anchors.get(actionHash);
  }
}

export interface TraceVerificationResult {
  ok: boolean;
  errors: string[];
}

export function verifyHashChain(events: EventEnvelope[]): TraceVerificationResult {
  const errors: string[] = [];
  for (let i = 1; i < events.length; i += 1) {
    const expected = events[i - 1].eventHash;
    const actual = events[i].previousEventHash;
    if (expected && actual !== expected) {
      errors.push(`event ${events[i].eventId} previousEventHash does not match ${events[i - 1].eventId}`);
    }
  }
  return {
    ok: errors.length === 0,
    errors
  };
}

export interface SuiTraceGuardDriver {
  anchor(input: Parameters<TraceGuard["anchor"]>[0]): Promise<ActionAnchor>;
  claim(input: Parameters<TraceGuard["claim"]>[0]): Promise<ActionClaim>;
  complete(input: Parameters<TraceGuard["complete"]>[0]): Promise<ActionAnchor>;
  fail(input: Parameters<TraceGuard["fail"]>[0]): Promise<ActionAnchor>;
  getAnchor(actionHash: string): Promise<ActionAnchor | undefined>;
}

export class SuiOnchainTraceGuard implements TraceGuard {
  constructor(private readonly driver: SuiTraceGuardDriver) {}

  anchor(input: Parameters<TraceGuard["anchor"]>[0]): Promise<ActionAnchor> {
    return this.driver.anchor(input);
  }

  claim(input: Parameters<TraceGuard["claim"]>[0]): Promise<ActionClaim> {
    return this.driver.claim(input);
  }

  complete(input: Parameters<TraceGuard["complete"]>[0]): Promise<ActionAnchor> {
    return this.driver.complete(input);
  }

  fail(input: Parameters<TraceGuard["fail"]>[0]): Promise<ActionAnchor> {
    return this.driver.fail(input);
  }

  getAnchor(actionHash: string): Promise<ActionAnchor | undefined> {
    return this.driver.getAnchor(actionHash);
  }
}

export interface SuiMoveTraceGuardTransactionResult {
  digest?: string;
  effects?: {
    status?: { status: "success" | "failure"; error?: string } | "success" | "failure";
  };
}

export interface SuiMoveTraceGuardEventQueryInput {
  query: { MoveEventType: string };
  cursor?: unknown;
  limit?: number;
  order?: "ascending" | "descending";
}

export interface SuiMoveTraceGuardEvent {
  id?: unknown;
  type: string;
  parsedJson?: unknown;
  timestampMs?: string;
}

export interface SuiMoveTraceGuardEventPage {
  data: SuiMoveTraceGuardEvent[];
  nextCursor?: unknown;
  hasNextPage: boolean;
}

export interface SuiMoveTraceGuardClient {
  signAndExecuteTransaction(input: {
    transaction: Transaction;
    signer: Signer;
    options?: {
      showEffects?: boolean;
      showObjectChanges?: boolean;
      showEvents?: boolean;
    };
  }): Promise<SuiMoveTraceGuardTransactionResult>;
  queryEvents?(input: SuiMoveTraceGuardEventQueryInput): Promise<SuiMoveTraceGuardEventPage>;
}

export interface SuiMoveTraceGuardDriverConfig {
  client: SuiMoveTraceGuardClient;
  signer: Signer;
  packageId: string;
  registryId: string;
  clockId?: string;
  defaultAuthorizedExecutor?: string;
  defaultActionTtlMs?: number;
  defaultClaimLeaseMs?: number;
  eventQueryPageSize?: number;
  eventQueryMaxPages?: number;
}

const SUI_CLOCK_OBJECT_ID = "0x6";
const E_ALREADY_CLAIMED = 2;
const DEFAULT_EVENT_QUERY_PAGE_SIZE = 50;
const DEFAULT_EVENT_QUERY_MAX_PAGES = 20;
const MOVE_STATUS_EXECUTED = 3;
const MOVE_STATUS_FAILED = 4;

export class SuiMoveTraceGuardDriver implements SuiTraceGuardDriver {
  private readonly client: SuiMoveTraceGuardClient;
  private readonly signer: Signer;
  private readonly packageId: string;
  private readonly registryId: string;
  private readonly clockId: string;
  private readonly defaultAuthorizedExecutor?: string;
  private readonly defaultActionTtlMs: number;
  private readonly defaultClaimLeaseMs: number;
  private readonly eventQueryPageSize: number;
  private readonly eventQueryMaxPages: number;
  private readonly anchors = new Map<string, ActionAnchor>();

  constructor(config: SuiMoveTraceGuardDriverConfig) {
    this.client = config.client;
    this.signer = config.signer;
    this.packageId = config.packageId;
    this.registryId = config.registryId;
    this.clockId = config.clockId ?? SUI_CLOCK_OBJECT_ID;
    this.defaultAuthorizedExecutor = config.defaultAuthorizedExecutor;
    this.defaultActionTtlMs = config.defaultActionTtlMs ?? DEFAULT_ACTION_TTL_MS;
    this.defaultClaimLeaseMs = config.defaultClaimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    this.eventQueryPageSize = config.eventQueryPageSize ?? DEFAULT_EVENT_QUERY_PAGE_SIZE;
    this.eventQueryMaxPages = config.eventQueryMaxPages ?? DEFAULT_EVENT_QUERY_MAX_PAGES;
  }

  async anchor(input: Parameters<TraceGuard["anchor"]>[0]): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    const owner = input.owner ?? this.signer.toSuiAddress();
    const authorizedExecutor = input.authorizedExecutor ?? this.defaultAuthorizedExecutor ?? this.signer.toSuiAddress();
    const expiresAtMs = input.expiresAtMs ?? nowMs + this.defaultActionTtlMs;
    const result = await this.execute("anchor_action", (tx) => [
      tx.object(this.registryId),
      tx.pure.vector("u8", textBytes(input.traceId)),
      tx.pure.vector("u8", hashBytesForMove(input.actionHash)),
      tx.pure.vector("u8", optionalHashBytes(input.proposalHash)),
      tx.pure.vector("u8", optionalHashBytes(input.decisionHash)),
      tx.pure.bool(true),
      tx.pure.address(authorizedExecutor),
      tx.pure.u64(expiresAtMs),
      tx.object(this.clockId)
    ]);
    assertTransactionSuccess(result, "anchor_action");

    const anchor: ActionAnchor = {
      anchorId: hashJson({ registryId: this.registryId, actionHash: input.actionHash }),
      traceId: input.traceId,
      actionHash: input.actionHash,
      proposalHash: input.proposalHash,
      decisionHash: input.decisionHash,
      owner,
      authorizedExecutor,
      status: "anchored",
      expiresAtMs,
      claimExpiresAtMs: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs
    };
    this.anchors.set(input.actionHash, anchor);
    return anchor;
  }

  async claim(input: Parameters<TraceGuard["claim"]>[0]): Promise<ActionClaim> {
    if (input.decision.decision !== "approved") {
      throw new Error("Cannot claim an action without approved PolicyDecision");
    }
    if (input.decision.actionHash !== input.actionHash) {
      throw new Error("Cannot claim with PolicyDecision for a different action");
    }

    const nowMs = input.nowMs ?? Date.now();
    const claimId = hashJson({ actionHash: input.actionHash, decisionHash: input.decision.evaluatedFactsHash });
    const claimant = this.signer.toSuiAddress();
    const claimLeaseMs = input.claimLeaseMs ?? this.defaultClaimLeaseMs;
    let result: SuiMoveTraceGuardTransactionResult;
    try {
      result = await this.execute("claim_action", (tx) => [
        tx.object(this.registryId),
        tx.pure.vector("u8", hashBytesForMove(input.actionHash)),
        tx.pure.u64(claimLeaseMs),
        tx.object(this.clockId)
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isMoveAbort(message, E_ALREADY_CLAIMED)) {
        throw error;
      }
      const anchor = await this.getAnchor(input.actionHash);
      return {
        claimId,
        actionHash: input.actionHash,
        claimant,
        claimed: false,
        duplicate: true,
        claimExpiresAtMs: anchor?.claimExpiresAtMs,
        createdAtMs: nowMs
      };
    }
    const error = transactionError(result);
    const duplicate = error ? isMoveAbort(error, E_ALREADY_CLAIMED) : false;
    if (error && !duplicate) {
      throw new Error(`claim_action failed: ${error}`);
    }

    if (!duplicate) {
      const restored = await this.restoreAnchor(input.actionHash, true);
      const anchor = restored ?? this.anchors.get(input.actionHash);
      if (anchor) {
        this.anchors.set(input.actionHash, {
          ...anchor,
          claimant,
          status: "claimed",
          claimExpiresAtMs: nowMs + claimLeaseMs,
          updatedAtMs: nowMs
        });
      }
    }

    return {
      claimId,
      actionHash: input.actionHash,
      claimant,
      claimed: !duplicate,
      duplicate,
      claimExpiresAtMs: this.anchors.get(input.actionHash)?.claimExpiresAtMs ?? nowMs + claimLeaseMs,
      createdAtMs: nowMs
    };
  }

  async complete(input: Parameters<TraceGuard["complete"]>[0]): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    if (input.receipt.actionHash !== input.actionHash) {
      throw new Error("Cannot complete with receipt for a different action");
    }
    const receiptHash = hashJson(input.receipt as unknown as JsonValue);
    const result = await this.execute("complete_action", (tx) => [
      tx.object(this.registryId),
      tx.pure.vector("u8", hashBytesForMove(input.actionHash)),
      tx.pure.vector("u8", hashBytesForMove(receiptHash)),
      tx.object(this.clockId)
    ]);
    assertTransactionSuccess(result, "complete_action");
    const restored = await this.restoreAnchor(input.actionHash, true);
    if (restored?.status === "executed" || restored?.status === "failed") {
      return restored;
    }
    return this.updateAnchor(input.actionHash, receiptHash, input.receipt.status === "success" ? "executed" : "failed", nowMs);
  }

  async fail(input: Parameters<TraceGuard["fail"]>[0]): Promise<ActionAnchor> {
    const nowMs = input.nowMs ?? Date.now();
    const receiptHash = hashJson({
      actionHash: input.actionHash,
      status: "failed",
      reason: input.reason
    });
    const result = await this.execute("fail_action", (tx) => [
      tx.object(this.registryId),
      tx.pure.vector("u8", hashBytesForMove(input.actionHash)),
      tx.pure.vector("u8", hashBytesForMove(receiptHash)),
      tx.object(this.clockId)
    ]);
    assertTransactionSuccess(result, "fail_action");
    const restored = await this.restoreAnchor(input.actionHash, true);
    if (restored?.status === "failed") {
      return restored;
    }
    return this.updateAnchor(input.actionHash, receiptHash, "failed", nowMs);
  }

  async getAnchor(actionHash: string): Promise<ActionAnchor | undefined> {
    return this.anchors.get(actionHash) ?? this.restoreAnchor(actionHash);
  }

  async restoreAnchor(actionHash: string, force = false): Promise<ActionAnchor | undefined> {
    if (!force) {
      const cached = this.anchors.get(actionHash);
      if (cached) {
        return cached;
      }
    }
    if (!this.client.queryEvents) {
      return undefined;
    }

    const events = await this.queryTraceEvents();
    const restored = restoreAnchorFromEvents({
      actionHash,
      registryId: this.registryId,
      events
    });
    if (restored) {
      this.anchors.set(actionHash, restored);
    }
    return restored;
  }

  private async execute(
    functionName: "anchor_action" | "claim_action" | "complete_action" | "fail_action",
    args: (tx: Transaction) => Parameters<Transaction["moveCall"]>[0]["arguments"]
  ): Promise<SuiMoveTraceGuardTransactionResult> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::trace::${functionName}`,
      arguments: args(tx)
    });
    return this.client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.signer,
      options: {
        showEffects: true,
        showObjectChanges: true,
        showEvents: true
      }
    });
  }

  private updateAnchor(actionHash: string, receiptHash: string, status: TraceState, nowMs: number): ActionAnchor {
    const anchor = this.anchors.get(actionHash);
    if (!anchor) {
      throw new Error("Cannot update unknown on-chain anchor");
    }
    const next: ActionAnchor = {
      ...anchor,
      receiptHash,
      status,
      updatedAtMs: nowMs
    };
    this.anchors.set(actionHash, next);
    return next;
  }

  private async queryTraceEvents(): Promise<SuiMoveTraceGuardEvent[]> {
    if (!this.client.queryEvents) {
      return [];
    }

    const allEvents: SuiMoveTraceGuardEvent[] = [];
    for (const eventType of this.traceEventTypes()) {
      let cursor: unknown;
      let pages = 0;
      while (pages < this.eventQueryMaxPages) {
        const page = await this.client.queryEvents({
          query: { MoveEventType: eventType },
          cursor,
          limit: this.eventQueryPageSize,
          order: "ascending"
        });
        allEvents.push(...page.data);
        cursor = page.nextCursor;
        pages += 1;
        if (!page.hasNextPage) {
          break;
        }
      }
    }

    return allEvents.sort((left, right) => {
      const byTime = eventTimestampMs(left) - eventTimestampMs(right);
      return byTime !== 0 ? byTime : traceEventRank(left) - traceEventRank(right);
    });
  }

  private traceEventTypes(): string[] {
    return [
      `${this.packageId}::trace::ActionAnchored`,
      `${this.packageId}::trace::ActionClaimed`,
      `${this.packageId}::trace::ActionCompleted`
    ];
  }
}

function transactionError(result: SuiMoveTraceGuardTransactionResult): string | undefined {
  const status = result.effects?.status;
  if (!status) {
    return undefined;
  }
  if (typeof status === "string") {
    return status === "failure" ? "transaction failed" : undefined;
  }
  return status.status === "failure" ? status.error ?? "transaction failed" : undefined;
}

function restoreAnchorFromEvents(input: {
  actionHash: string;
  registryId: string;
  events: SuiMoveTraceGuardEvent[];
}): ActionAnchor | undefined {
  const expectedActionHash = hashBytesForMove(input.actionHash);
  let anchor: ActionAnchor | undefined;

  for (const event of input.events) {
    const parsed = asRecord(event.parsedJson);
    if (!parsed || !moveBytesEqual(parsed.action_hash, expectedActionHash)) {
      continue;
    }

    const timestampMs = numberField(parsed.timestamp_ms) ?? eventTimestampMs(event);

    if (event.type.endsWith("::ActionAnchored")) {
      anchor = {
        anchorId: hashJson({ registryId: input.registryId, actionHash: input.actionHash }),
        traceId: textField(parsed.trace_id) ?? "",
        actionHash: input.actionHash,
        proposalHash: optionalHashField(parsed.proposal_hash),
        decisionHash: optionalHashField(parsed.decision_hash),
        owner: stringField(parsed.owner),
        authorizedExecutor: stringField(parsed.authorized_executor),
        status: "anchored",
        expiresAtMs: numberField(parsed.expires_at_ms),
        claimExpiresAtMs: 0,
        createdAtMs: timestampMs,
        updatedAtMs: timestampMs
      };
      continue;
    }

    if (event.type.endsWith("::ActionClaimed") && anchor) {
      anchor = {
        ...anchor,
        claimant: stringField(parsed.claimant),
        status: "claimed",
        claimExpiresAtMs: numberField(parsed.claim_expires_at_ms),
        updatedAtMs: timestampMs
      };
      continue;
    }

    if (event.type.endsWith("::ActionCompleted") && anchor) {
      anchor = {
        ...anchor,
        receiptHash: optionalHashField(parsed.receipt_hash),
        claimant: stringField(parsed.claimant) ?? anchor.claimant,
        status: completedTraceState(parsed.status),
        updatedAtMs: timestampMs
      };
    }
  }

  return anchor;
}

function eventTimestampMs(event: SuiMoveTraceGuardEvent): number {
  return numberField(event.timestampMs) ?? 0;
}

function traceEventRank(event: SuiMoveTraceGuardEvent): number {
  if (event.type.endsWith("::ActionAnchored")) return 1;
  if (event.type.endsWith("::ActionClaimed")) return 2;
  if (event.type.endsWith("::ActionCompleted")) return 3;
  return 4;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bytesField(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  if (typeof value === "string" && value.startsWith("0x")) {
    try {
      return hexToBytes(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function moveBytesEqual(value: unknown, expected: Uint8Array): boolean {
  const actual = bytesField(value);
  if (!actual || actual.length !== expected.length) {
    return false;
  }
  return actual.every((byte, index) => byte === expected[index]);
}

function optionalHashField(value: unknown): string | undefined {
  const bytes = bytesField(value);
  if (!bytes || bytes.length === 0) {
    return undefined;
  }
  return bytesToHex(bytes);
}

function textField(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const bytes = bytesField(value);
  if (!bytes) {
    return undefined;
  }
  return bytesToUtf8(bytes);
}

function completedTraceState(value: unknown): TraceState {
  if (value === "failed") {
    return "failed";
  }
  const status = numberField(value);
  if (status === MOVE_STATUS_FAILED) {
    return "failed";
  }
  return status === MOVE_STATUS_EXECUTED ? "executed" : "executed";
}

function assertTransactionSuccess(result: SuiMoveTraceGuardTransactionResult, functionName: string): void {
  const error = transactionError(result);
  if (error) {
    throw new Error(`${functionName} failed: ${error}`);
  }
}

function isMoveAbort(error: string, code: number): boolean {
  return (
    error.includes(`}, ${code})`) ||
    error.includes(`abort code: ${code}`) ||
    error.includes(`error_code: ${code}`) ||
    error.includes(`"error_code":${code}`)
  );
}

function optionalHashBytes(value: string | undefined): Uint8Array {
  return value ? hashBytesForMove(value) : new Uint8Array();
}

function hashBytesForMove(value: string): Uint8Array {
  if (value.startsWith("0x")) {
    return hexToBytes(value);
  }
  return textBytes(value);
}

function textBytes(value: string): Uint8Array {
  return utf8ToBytes(value);
}

function isZeroAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return normalized.length === 0;
}
