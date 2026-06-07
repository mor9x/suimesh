import { describe, expect, test } from "bun:test";
import {
  createDefaultPolicy,
  createSuiMeshClient,
  encodeEvent,
  encodeInspectablePtb,
  hashJson,
  SuiMoveTraceGuardDriver,
  type ActionManifest,
  type SuiMoveTraceGuardClient,
  type SuiMoveTraceGuardTransactionResult
} from "../src/index.ts";

const ALICE_ADDRESS = "0x00000000000000000000000000000000000000000000000000000000000a11ce";

describe("SDK and trace guard", () => {
  test("runs a minimal heavy path and blocks duplicate claims", async () => {
    const client = createSuiMeshClient();
    const user = { role: "user" as const, id: "alice", address: "0xalice" };
    const agent = { role: "agent" as const, id: "agent", address: "0xagent" };
    const policyActor = { role: "policy" as const, id: "policy" };
    const executor = { role: "executor" as const, id: "executor" };

    const light = await client.light.sendMessage({
      sessionId: "ses_sdk",
      actor: user,
      content: "Prepare a 10 SUI transfer to Bob",
      nowMs: 1
    });

    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "10", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
      actionId: "act_sdk",
      traceId: "tr_sdk",
      semanticType: "transfer",
      template: "transfer",
      summary: "Send 10 SUI to Bob",
      riskLevel: "medium",
      valueAtRisk: { amount: "10", coinType: "SUI" },
      objectsTouched: ["0xcoin"],
      policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_sdk"
    };

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
          { name: "max_value_at_risk", params: { maxAmount: "20", coinType: "SUI" } },
          { name: "recipient_allowlist", params: { recipients: ["0xbob"] } },
          { name: "expiration_check", params: {} }
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

  test("records a recoverable heavy trace chain through transport", async () => {
    const client = createSuiMeshClient();
    const user = { role: "user" as const, id: "alice", address: "0xalice" };
    const agent = { role: "agent" as const, id: "agent", address: "0xagent" };
    const policyActor = { role: "policy" as const, id: "policy" };
    const executor = { role: "executor" as const, id: "executor" };
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
    const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
      actionId: "act_recorded",
      traceId,
      semanticType: "transfer",
      template: "transfer",
      summary: "Send 10 SUI to Bob",
      riskLevel: "medium",
      valueAtRisk: { amount: "10", coinType: "SUI" },
      objectsTouched: ["0xcoin"],
      policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_recorded"
    };
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
          { name: "max_value_at_risk", params: { maxAmount: "20", coinType: "SUI" } },
          { name: "recipient_allowlist", params: { recipients: ["0xbob"] } },
          { name: "expiration_check", params: {} }
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

class ThrowingDuplicateClaimSuiClient implements SuiMoveTraceGuardClient {
  async signAndExecuteTransaction(): Promise<SuiMoveTraceGuardTransactionResult> {
    throw new Error(
      "Transaction resolution failed: MoveAbort in 1st command, abort code: 2, in '0x2::trace::claim_action'"
    );
  }
}
