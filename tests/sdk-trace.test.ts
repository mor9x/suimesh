import { describe, expect, test } from "bun:test";
import {
  createDefaultPolicy,
  createSuiMeshClient,
  encodeEvent,
  encodeInspectablePtb,
  hashJson,
  hexToBytes,
  policyRules,
  SuiMoveTraceGuardDriver,
  utf8ToBytes,
  type SuiMoveTraceGuardClient,
  type SuiMoveTraceGuardEvent,
  type SuiMoveTraceGuardEventPage,
  type SuiMoveTraceGuardEventQueryInput,
  type SuiMoveTraceGuardTransactionResult
} from "../src/index.ts";

const ALICE_ADDRESS = "0x00000000000000000000000000000000000000000000000000000000000a11ce";

describe("SDK and trace guard", () => {
  test("runs a minimal heavy path and blocks duplicate claims", async () => {
    const client = createSuiMeshClient();
    const user = client.actors.user("alice", { address: "0xalice" });
    const agent = client.actors.agent("agent", { address: "0xagent" });
    const policyActor = client.actors.policy("policy");
    const executor = client.actors.executor("executor");

    const light = await client.light.sendMessage({
      sessionId: "ses_sdk",
      actor: user,
      content: "Prepare a 10 SUI transfer to Bob",
      nowMs: 1
    });

    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "10", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest = client.manifest.transfer({
      actionId: "act_sdk",
      traceId: "tr_sdk",
      amount: "10",
      coinType: "SUI",
      objectIds: ["0xcoin"],
      summary: "Send 10 SUI to Bob",
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_sdk"
    });

    const proposed = await client.actions.proposePtb({
      sessionId: "ses_sdk",
      traceId: "tr_sdk",
      actor: agent,
      ptbBytes,
      manifest,
      previousEventHash: light.eventHash,
      nowMs: 2
    });
    const simulated = await client.actions.simulate(proposed.action);
    const decision = client.policy.evaluate({
      policy: createDefaultPolicy({
        rules: [
          policyRules.maxValueAtRisk({ maxAmount: "20", coinType: "SUI" }),
          policyRules.recipientAllowlist(["0xbob"]),
          policyRules.expirationCheck()
        ]
      }),
      facts: simulated.facts,
      decider: policyActor,
      nowMs: 3
    });
    expect(decision.decision).toBe("approved");

    const anchor = await client.traceGuard.anchor({
      traceId: "tr_sdk",
      actionHash: simulated.facts.actionHash,
      proposalHash: proposed.envelope.eventHash,
      decisionHash: hashJson(decision as never),
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 4
    });
    expect(anchor.status).toBe("anchored");

    const claim = await client.traceGuard.claim({
      actionHash: simulated.facts.actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 20,
      nowMs: 5
    });
    const duplicate = await client.traceGuard.claim({
      actionHash: simulated.facts.actionHash,
      decision,
      claimant: "0xexecutor",
      nowMs: 6
    });
    expect(claim.claimed).toBe(true);
    expect(duplicate.duplicate).toBe(true);

    const receipt = await client.actions.executeApproved({
      actionHash: simulated.facts.actionHash,
      claim,
      decision,
      executor: { ...executor, address: "0xexecutor" },
      execute: async () => ({ txDigest: "0xtx", effectsHash: "0xeffects" }),
      nowMs: 7
    });
    expect(receipt.status).toBe("success");

    const verified = await client.trace.verify("ses_sdk");
    expect(verified.ok).toBe(true);
  });

  test("local trace guard blocks unauthorized claim and completion", async () => {
    const client = createSuiMeshClient();
    const decision = {
      actionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: { role: "policy" as const, id: "policy" },
      createdAtMs: 1
    };

    await client.traceGuard.anchor({
      traceId: "tr_auth",
      actionHash: decision.actionHash,
      decisionHash: "0xdecision",
      owner: "0xowner",
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 2
    });

    await expect(client.traceGuard.claim({
      actionHash: decision.actionHash,
      decision,
      claimant: "0xattacker",
      nowMs: 3
    })).rejects.toThrow("unauthorized executor");

    const claim = await client.traceGuard.claim({
      actionHash: decision.actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 20,
      nowMs: 4
    });

    await expect(client.traceGuard.complete({
      actionHash: decision.actionHash,
      receipt: {
        actionHash: decision.actionHash,
        claimId: claim.claimId,
        executor: { role: "executor", id: "attacker", address: "0xattacker" },
        status: "success",
        txDigest: "0xtx",
        createdAtMs: 5
      },
      nowMs: 5
    })).rejects.toThrow("unauthorized claimant");
  });

  test("rejects mismatched decision and claim action hashes", async () => {
    const client = createSuiMeshClient();
    const actionA = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const actionB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const decisionA = {
      actionHash: actionA,
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: client.actors.policy("policy"),
      createdAtMs: 1
    };

    await client.traceGuard.anchor({
      traceId: "tr_mismatch",
      actionHash: actionB,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 2
    });

    await expect(client.traceGuard.claim({
      actionHash: actionB,
      decision: decisionA,
      claimant: "0xexecutor",
      nowMs: 3
    })).rejects.toThrow("different action");

    const decisionB = { ...decisionA, actionHash: actionB };
    const claimB = await client.traceGuard.claim({
      actionHash: actionB,
      decision: decisionB,
      claimant: "0xexecutor",
      nowMs: 4
    });

    await expect(client.actions.executeApproved({
      actionHash: actionB,
      claim: claimB,
      decision: decisionA,
      executor: client.actors.executor("executor", { address: "0xexecutor" }),
      execute: async () => ({ txDigest: "0xtx" }),
      nowMs: 5
    })).rejects.toThrow("PolicyDecision for a different action");

    await expect(client.actions.executeApproved({
      actionHash: actionB,
      claim: { ...claimB, actionHash: actionA },
      decision: decisionB,
      executor: client.actors.executor("executor", { address: "0xexecutor" }),
      execute: async () => ({ txDigest: "0xtx" }),
      nowMs: 6
    })).rejects.toThrow("ActionClaim for a different action");
  });

  test("local trace guard rejects duplicate anchor and completed action re-anchor", async () => {
    const client = createSuiMeshClient();
    const actionHash = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const decision = {
      actionHash,
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: client.actors.policy("policy"),
      createdAtMs: 1
    };

    await client.traceGuard.anchor({
      traceId: "tr_duplicate_anchor",
      actionHash,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 2
    });
    await expect(client.traceGuard.anchor({
      traceId: "tr_duplicate_anchor",
      actionHash,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 3
    })).rejects.toThrow("already anchored");

    const claim = await client.traceGuard.claim({
      actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 20,
      nowMs: 4
    });
    await client.actions.executeApproved({
      actionHash,
      claim,
      decision,
      executor: client.actors.executor("executor", { address: "0xexecutor" }),
      execute: async () => ({ txDigest: "0xtx" }),
      nowMs: 5
    });

    await expect(client.traceGuard.anchor({
      traceId: "tr_duplicate_anchor",
      actionHash,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 6
    })).rejects.toThrow("already anchored");
  });

  test("local trace guard allows reclaim after claim lease expires", async () => {
    const client = createSuiMeshClient();
    const decision = {
      actionHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: { role: "policy" as const, id: "policy" },
      createdAtMs: 1
    };

    await client.traceGuard.anchor({
      traceId: "tr_lease",
      actionHash: decision.actionHash,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 2
    });
    const first = await client.traceGuard.claim({
      actionHash: decision.actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 10,
      nowMs: 3
    });
    const duplicate = await client.traceGuard.claim({
      actionHash: decision.actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 10,
      nowMs: 4
    });
    const reclaimed = await client.traceGuard.claim({
      actionHash: decision.actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 10,
      nowMs: 14
    });

    expect(first.claimed).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.duplicate).toBe(false);
  });

  test("SDK refuses to execute after claim lease expires", async () => {
    const client = createSuiMeshClient();
    const actionHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const decision = {
      actionHash,
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: { role: "policy" as const, id: "policy" },
      createdAtMs: 1
    };

    await client.traceGuard.anchor({
      traceId: "tr_execute_expired",
      actionHash,
      authorizedExecutor: "0xexecutor",
      expiresAtMs: 100,
      nowMs: 2
    });
    const claim = await client.traceGuard.claim({
      actionHash,
      decision,
      claimant: "0xexecutor",
      claimLeaseMs: 1,
      nowMs: 3
    });
    let executed = false;

    await expect(client.actions.executeApproved({
      actionHash,
      claim,
      decision,
      executor: { role: "executor", id: "executor", address: "0xexecutor" },
      execute: async () => {
        executed = true;
        return { txDigest: "0xtx" };
      },
      nowMs: 5
    })).rejects.toThrow("claim lease expired");
    expect(executed).toBe(false);
  });

  test("Sui Move trace guard driver maps anchor, claim, and complete calls", async () => {
    const fakeClient = new FakeSuiClient();
    const driver = new SuiMoveTraceGuardDriver({
      client: fakeClient,
      signer: signer as never,
      packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
      registryId: "0x07707cb0206a042788107e4738f79825b1f8f36a092479dbda436cde06cf873c"
    });
    const decision = {
      actionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: { role: "policy" as const, id: "policy" },
      createdAtMs: 1
    };

    const anchor = await driver.anchor({
      traceId: "tr_onchain",
      actionHash: decision.actionHash,
      proposalHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      decisionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      authorizedExecutor: ALICE_ADDRESS,
      expiresAtMs: 100,
      nowMs: 2
    });
    const claim = await driver.claim({ actionHash: decision.actionHash, decision, nowMs: 3 });
    const duplicate = await driver.claim({ actionHash: decision.actionHash, decision, nowMs: 4 });
    const completed = await driver.complete({
      actionHash: decision.actionHash,
      receipt: {
        actionHash: decision.actionHash,
        claimId: claim.claimId,
        executor: { role: "executor", id: "executor" },
        status: "success",
        txDigest: "0xtx",
        createdAtMs: 5
      },
      nowMs: 6
    });

    expect(anchor.status).toBe("anchored");
    expect(claim.claimed).toBe(true);
    expect(duplicate.duplicate).toBe(true);
    expect(completed.status).toBe("executed");
    expect(fakeClient.calls).toEqual(["anchor_action", "claim_action", "claim_action", "complete_action"]);
  });

  test("Sui Move trace guard treats duplicate claim simulation abort as duplicate", async () => {
    const driver = new SuiMoveTraceGuardDriver({
      client: new ThrowingDuplicateClaimSuiClient(),
      signer: signer as never,
      packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
      registryId: "0x07707cb0206a042788107e4738f79825b1f8f36a092479dbda436cde06cf873c"
    });
    const decision = {
      actionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      policyHash: "0xpolicy",
      policyVersion: "1",
      evaluatedFactsHash: "0xfacts",
      decision: "approved" as const,
      reason: "ok",
      decider: { role: "policy" as const, id: "policy" },
      createdAtMs: 1
    };

    const duplicate = await driver.claim({ actionHash: decision.actionHash, decision, nowMs: 2 });

    expect(duplicate.claimed).toBe(false);
    expect(duplicate.duplicate).toBe(true);
  });

  test("Sui Move trace guard restores anchor state from trace events without local cache", async () => {
    const packageId = "0x0000000000000000000000000000000000000000000000000000000000000002";
    const registryId = "0x07707cb0206a042788107e4738f79825b1f8f36a092479dbda436cde06cf873c";
    const actionHash = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const proposalHash = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const decisionHash = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const receiptHash = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const eventClient = new EventQuerySuiClient([
      {
        type: `${packageId}::trace::ActionAnchored`,
        timestampMs: "2",
        parsedJson: {
          trace_id: bytes("tr_event_restore"),
          action_hash: bytes(actionHash),
          proposal_hash: bytes(proposalHash),
          decision_hash: bytes(decisionHash),
          owner: ALICE_ADDRESS,
          authorized_executor: ALICE_ADDRESS,
          approved: true,
          expires_at_ms: "1000",
          timestamp_ms: "2"
        }
      },
      {
        type: `${packageId}::trace::ActionClaimed`,
        timestampMs: "3",
        parsedJson: {
          action_hash: bytes(actionHash),
          claimant: ALICE_ADDRESS,
          claim_expires_at_ms: "900",
          timestamp_ms: "3"
        }
      },
      {
        type: `${packageId}::trace::ActionCompleted`,
        timestampMs: "4",
        parsedJson: {
          action_hash: bytes(actionHash),
          receipt_hash: bytes(receiptHash),
          claimant: ALICE_ADDRESS,
          status: 3,
          timestamp_ms: "4"
        }
      }
    ]);
    const driver = new SuiMoveTraceGuardDriver({
      client: eventClient,
      signer: signer as never,
      packageId,
      registryId
    });

    const restored = await driver.getAnchor(actionHash);
    expect(restored?.traceId).toBe("tr_event_restore");
    expect(restored?.status).toBe("executed");
    expect(restored?.receiptHash).toBe(receiptHash);
    expect(restored?.claimant).toBe(ALICE_ADDRESS);

    const freshDriver = new SuiMoveTraceGuardDriver({
      client: eventClient,
      signer: signer as never,
      packageId,
      registryId
    });
    const completed = await freshDriver.complete({
      actionHash,
      receipt: {
        actionHash,
        claimId: "claim_event_restore",
        executor: { role: "executor", id: "executor", address: ALICE_ADDRESS },
        status: "success",
        txDigest: "0xtx",
        createdAtMs: 5
      },
      nowMs: 5
    });

    expect(completed.status).toBe("executed");
    expect(eventClient.calls).toEqual(["complete_action"]);
  });

  test("records a recoverable heavy trace chain through transport", async () => {
    const client = createSuiMeshClient();
    const user = client.actors.user("alice", { address: "0xalice" });
    const agent = client.actors.agent("agent", { address: "0xagent" });
    const policyActor = client.actors.policy("policy");
    const executor = client.actors.executor("executor");
    const sessionId = "ses_recorded";
    const traceId = "tr_recorded";

    const light = await client.light.sendMessage({
      sessionId,
      actor: user,
      content: "Prepare a transfer",
      nowMs: 1
    });
    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "10", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest = client.manifest.transfer({
      actionId: "act_recorded",
      traceId,
      amount: "10",
      coinType: "SUI",
      objectIds: ["0xcoin"],
      summary: "Send 10 SUI to Bob",
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_recorded"
    });
    const proposed = await client.actions.proposePtb({
      sessionId,
      traceId,
      actor: agent,
      ptbBytes,
      manifest,
      previousEventHash: light.eventHash,
      nowMs: 2
    });
    const simulated = await client.actions.simulate(proposed.action);
    const decisionRecord = await client.policy.evaluateAndRecord({
      sessionId,
      traceId,
      policy: createDefaultPolicy({
        rules: [
          policyRules.maxValueAtRisk({ maxAmount: "20", coinType: "SUI" }),
          policyRules.recipientAllowlist(["0xbob"]),
          policyRules.expirationCheck()
        ]
      }),
      facts: simulated.facts,
      decider: policyActor,
      previousEventHash: proposed.envelope.eventHash,
      nowMs: 3
    });
    const anchorRecord = await client.trace.anchorAndRecord({
      sessionId,
      traceId,
      actor: policyActor,
      actionHash: simulated.facts.actionHash,
      proposalHash: proposed.envelope.eventHash,
      decisionHash: decisionRecord.envelope.eventHash,
      previousEventHash: decisionRecord.envelope.eventHash,
      nowMs: 4
    });
    const claimRecord = await client.trace.claimAndRecord({
      sessionId,
      traceId,
      actor: executor,
      actionHash: simulated.facts.actionHash,
      decision: decisionRecord.decision,
      previousEventHash: anchorRecord.envelope.eventHash,
      nowMs: 5
    });
    await client.trace.executeApprovedAndRecord({
      sessionId,
      traceId,
      actionHash: simulated.facts.actionHash,
      claim: claimRecord.claim,
      decision: decisionRecord.decision,
      executor,
      execute: async () => ({ txDigest: "0xtx", effectsHash: "0xeffects" }),
      previousEventHash: claimRecord.envelope.eventHash,
      nowMs: 6
    });

    const restored = await client.trace.restore(sessionId);
    expect(restored.map((event) => event.eventType)).toEqual([
      "conversation.user_message.v1",
      "decision.sui_ptb_action.v1",
      "decision.policy_decision.v1",
      "trace.action_anchor.v1",
      "trace.action_claim.v1",
      "outcome.execution_receipt.v1"
    ]);
    expect(await client.trace.verify(sessionId)).toEqual({ ok: true, errors: [] });
  });

  test("records memory receipts without affecting heavy path", async () => {
    const client = createSuiMeshClient();
    const memoryActor = { role: "memory" as const, id: "memwal" };
    const result = await client.memoryOps.rememberAndRecord({
      sessionId: "ses_memory_receipt",
      actor: memoryActor,
      namespace: "alice/default",
      content: { preference: "low risk" },
      nowMs: 1
    });

    expect(result.receipt.provider).toBe("memwal");
    expect((await client.trace.restore("ses_memory_receipt"))[0].eventType).toBe("context.memory_receipt.v1");
  });

  test("verify rejects heavy trace state transitions without required predecessors", async () => {
    const client = createSuiMeshClient();
    const sessionId = "ses_bad_trace_state";
    const traceId = "tr_bad_trace_state";
    const actionHash = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await client.messaging.send(encodeEvent({
      encoding: "bcs-v1",
      header: {
        eventId: "evt_bad_anchor",
        sessionId,
        traceId,
        eventType: "trace.action_anchor.v1",
        actor: { role: "policy", id: "policy" },
        createdAtMs: 1
      },
      payload: {
        anchorId: "anchor_bad",
        traceId,
        actionHash,
        status: "anchored",
        createdAtMs: 1,
        updatedAtMs: 1
      }
    }));

    const verified = await client.trace.verify(sessionId);

    expect(verified.ok).toBe(false);
    expect(verified.errors.join("; ")).toContain("anchored without approved PolicyDecision");
  });
});

const signer = {
  toSuiAddress: () => ALICE_ADDRESS,
  signPersonalMessage: async () => ({ bytes: "", signature: "" }),
  signTransaction: async () => ({ bytes: "", signature: "" }),
  signTransactionBlock: async () => ({ bytes: "", signature: "" })
};

function bytes(value: string): number[] {
  return Array.from(value.startsWith("0x") ? hexToBytes(value) : utf8ToBytes(value));
}

class FakeSuiClient implements SuiMoveTraceGuardClient {
  calls: string[] = [];
  private claims = 0;

  async signAndExecuteTransaction(
    input: Parameters<SuiMoveTraceGuardClient["signAndExecuteTransaction"]>[0]
  ): Promise<SuiMoveTraceGuardTransactionResult> {
    const data = input.transaction.getData() as { commands?: { MoveCall?: { function?: string } }[] };
    const call = data.commands?.[0]?.MoveCall?.function ?? "unknown";
    this.calls.push(call);
    if (call === "claim_action") {
      this.claims += 1;
      if (this.claims > 1) {
        return {
          digest: "0xduplicate",
          effects: {
            status: {
              status: "failure",
              error: "MoveAbort(MoveLocation { function_name: Some(\"claim_action\") }, 2)"
            }
          }
        };
      }
    }
    return {
      digest: "0xok",
      effects: {
        status: {
          status: "success"
        }
      }
    };
  }
}

class EventQuerySuiClient implements SuiMoveTraceGuardClient {
  calls: string[] = [];

  constructor(private readonly events: SuiMoveTraceGuardEvent[]) {}

  async signAndExecuteTransaction(
    input: Parameters<SuiMoveTraceGuardClient["signAndExecuteTransaction"]>[0]
  ): Promise<SuiMoveTraceGuardTransactionResult> {
    const data = input.transaction.getData() as { commands?: { MoveCall?: { function?: string } }[] };
    const call = data.commands?.[0]?.MoveCall?.function ?? "unknown";
    this.calls.push(call);
    return {
      digest: "0xok",
      effects: {
        status: {
          status: "success"
        }
      }
    };
  }

  async queryEvents(input: SuiMoveTraceGuardEventQueryInput): Promise<SuiMoveTraceGuardEventPage> {
    return {
      data: this.events.filter((event) => event.type === input.query.MoveEventType),
      hasNextPage: false
    };
  }
}

class ThrowingDuplicateClaimSuiClient implements SuiMoveTraceGuardClient {
  async signAndExecuteTransaction(): Promise<SuiMoveTraceGuardTransactionResult> {
    throw new Error(
      "Transaction resolution failed: MoveAbort in 1st command, abort code: 2, in '0x2::trace::claim_action'"
    );
  }
}
