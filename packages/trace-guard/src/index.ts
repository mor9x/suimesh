import type { EventEnvelope, ExecutionReceipt, JsonValue, PolicyDecision, TraceState } from "../../protocol/src/index.ts";
import { hashJson, hexToBytes, utf8ToBytes } from "../../codec/src/index.ts";
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
    const expiresAtMs = input.expiresAtMs ?? existing?.expiresAtMs ?? nowMs + DEFAULT_ACTION_TTL_MS;
    if (expiresAtMs <= nowMs) {
      throw new Error("Cannot anchor an already expired action");
    }
    if (input.authorizedExecutor && isZeroAddress(input.authorizedExecutor)) {
      throw new Error("Cannot anchor action with zero authorized executor");
    }
    const next: ActionAnchor = {
      anchorId: existing?.anchorId ?? hashJson({ traceId: input.traceId, actionHash: input.actionHash }),
      traceId: input.traceId,
      actionHash: input.actionHash,
      proposalHash: input.proposalHash ?? existing?.proposalHash,
      decisionHash: input.decisionHash ?? existing?.decisionHash,
      receiptHash: existing?.receiptHash,
      owner: input.owner ?? existing?.owner,
      authorizedExecutor: input.authorizedExecutor ?? existing?.authorizedExecutor,
      claimant: existing?.claimant,
      status: "anchored",
      expiresAtMs,
      claimExpiresAtMs: existing?.claimExpiresAtMs,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs
    };
    this.anchors.set(input.actionHash, next);
    return next;
  }

  async claim(input: { actionHash: string; decision: PolicyDecision; claimant?: string; claimLeaseMs?: number; nowMs?: number }): Promise<ActionClaim> {
    if (input.decision.decision !== "approved") {
      throw new Error("Cannot claim an action without approved PolicyDecision");
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
}

const SUI_CLOCK_OBJECT_ID = "0x6";
const E_ALREADY_CLAIMED = 2;

export class SuiMoveTraceGuardDriver implements SuiTraceGuardDriver {
  private readonly client: SuiMoveTraceGuardClient;
  private readonly signer: Signer;
  private readonly packageId: string;
  private readonly registryId: string;
  private readonly clockId: string;
  private readonly defaultAuthorizedExecutor?: string;
  private readonly defaultActionTtlMs: number;
  private readonly defaultClaimLeaseMs: number;
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
      return {
        claimId,
        actionHash: input.actionHash,
        claimant,
        claimed: false,
        duplicate: true,
        claimExpiresAtMs: this.anchors.get(input.actionHash)?.claimExpiresAtMs,
        createdAtMs: nowMs
      };
    }
    const error = transactionError(result);
    const duplicate = error ? isMoveAbort(error, E_ALREADY_CLAIMED) : false;
    if (error && !duplicate) {
      throw new Error(`claim_action failed: ${error}`);
    }

    if (!duplicate) {
      const anchor = this.anchors.get(input.actionHash);
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
    const receiptHash = hashJson(input.receipt as unknown as JsonValue);
    const result = await this.execute("complete_action", (tx) => [
      tx.object(this.registryId),
      tx.pure.vector("u8", hashBytesForMove(input.actionHash)),
      tx.pure.vector("u8", hashBytesForMove(receiptHash)),
      tx.object(this.clockId)
    ]);
    assertTransactionSuccess(result, "complete_action");
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
    return this.updateAnchor(input.actionHash, receiptHash, "failed", nowMs);
  }

  async getAnchor(actionHash: string): Promise<ActionAnchor | undefined> {
    return this.anchors.get(actionHash);
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
