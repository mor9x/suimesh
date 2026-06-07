import { describe, expect, test } from "bun:test";
import {
  DefaultPolicyEngine,
  DefaultPtbInspector,
  createDefaultPolicy,
  encodeInspectablePtb,
  hashBytes,
  type ActionManifest,
  type Policy
} from "../src/index.ts";
import { Transaction } from "@mysten/sui/transactions";

const future = 4_000_000_000_000;
const decider = { role: "policy" as const, id: "policy-engine" };
const objectDigest = "3EuKnmk9iCPSd3suDoWTnL2iDobNWPppJyrBcpdPCRv7";

function objectRef(objectId: string) {
  return {
    objectId,
    version: "1",
    digest: objectDigest
  };
}

function transferManifest(ptbBytes: Uint8Array): ActionManifest {
  return {
    actionId: "act_transfer",
    traceId: "tr_transfer",
    actionType: "sui.ptb.v1",
    semanticType: "transfer",
    template: "transfer",
    summary: "Send 10 SUI to Bob",
    riskLevel: "medium",
    valueAtRisk: { amount: "10", coinType: "SUI" },
    objectsTouched: ["0xcoin"],
    policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
    ptbHash: hashBytes(ptbBytes),
    expiresAtMs: future,
    idempotencyKey: "idem_transfer"
  };
}

describe("PTB inspector and policy engine", () => {
  test("parses real Sui TransactionKind BCS for split coin transfer", async () => {
    const recipient = "0x1fc15f5c553c0fb033077a25bab9c73e865348dacf50c9bb7be60e913c3b7662";
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(100)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
    const ptbBytes = await tx.build({ onlyTransactionKind: true });
    const manifest: ActionManifest = {
      actionId: "act_real_transfer",
      traceId: "tr_real_transfer",
      actionType: "sui.ptb.v1",
      semanticType: "transfer",
      template: "transfer",
      summary: "Send 100 MIST",
      riskLevel: "medium",
      valueAtRisk: { amount: "100", coinType: "SUI" },
      objectsTouched: ["gas"],
      policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_real_transfer"
    };

    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);

    expect(facts.semanticType).toBe("transfer");
    expect(facts.transfers[0]).toMatchObject({ recipient, amount: "100", coinType: "SUI" });
    expect(inspector.validateManifest(manifest, facts).ok).toBe(true);
  });

  test("parses real Sui TransactionKind BCS for MoveCall targets", async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: "0x2::pay::join_vec",
      arguments: [tx.pure.vector("u8", new Uint8Array([1, 2, 3]))]
    });
    const ptbBytes = await tx.build({ onlyTransactionKind: true });
    const manifest: ActionManifest = {
      actionId: "act_real_move",
      traceId: "tr_real_move",
      actionType: "sui.ptb.v1",
      semanticType: "move_call",
      template: "move_call",
      summary: "Call 0x2::pay::join_vec",
      riskLevel: "high",
      primaryTarget: {
        packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        module: "pay",
        function: "join_vec"
      },
      objectsTouched: [],
      policyRequirements: ["function_allowlist"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_real_move"
    };

    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);

    expect(facts.semanticType).toBe("move_call");
    expect(facts.moveCalls[0].selector).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002::pay::join_vec"
    );
    expect(inspector.validateManifest(manifest, facts).ok).toBe(true);
  });

  test("parses full Sui TransactionData BCS when provided instead of kind bytes", async () => {
    const recipient = "0x1fc15f5c553c0fb033077a25bab9c73e865348dacf50c9bb7be60e913c3b7662";
    const tx = new Transaction();
    tx.setSender(recipient);
    tx.setGasBudget(10_000_000);
    tx.setGasPrice(1_000);
    tx.setGasPayment([
      {
        objectId: "0x22e9e07f2f926971b7a3ca2305daa0bba1840d8637ec1ef4487da9c91c8fdba8",
        version: "1",
        digest: "3EuKnmk9iCPSd3suDoWTnL2iDobNWPppJyrBcpdPCRv7"
      }
    ]);
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(7)]);
    tx.transferObjects([coin], tx.pure.address(recipient));
    const ptbBytes = await tx.build();
    const manifest: ActionManifest = {
      actionId: "act_real_tx_data",
      traceId: "tr_real_tx_data",
      actionType: "sui.ptb.v1",
      semanticType: "transfer",
      template: "transfer",
      summary: "Send 7 MIST",
      riskLevel: "medium",
      valueAtRisk: { amount: "7", coinType: "SUI" },
      objectsTouched: ["gas"],
      policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_real_tx_data"
    };

    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);

    expect(facts.transfers[0]).toMatchObject({ recipient, amount: "7", coinType: "SUI" });
    expect(inspector.validateManifest(manifest, facts).ok).toBe(true);
  });

  test("parses direct object transfer as unknown-value transfer", async () => {
    const recipient = "0x1fc15f5c553c0fb033077a25bab9c73e865348dacf50c9bb7be60e913c3b7662";
    const objectId = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const tx = new Transaction();
    tx.transferObjects([tx.objectRef(objectRef(objectId))], tx.pure.address(recipient));
    const ptbBytes = await tx.build({ onlyTransactionKind: true });

    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes);

    expect(facts.semanticType).toBe("transfer");
    expect(facts.transfers[0]).toMatchObject({
      recipient,
      amount: "unknown",
      coinType: "unknown",
      objectIds: [objectId]
    });
    expect(facts.objectsTouched).toEqual([objectId]);
  });

  test("parses complex Sui PTB commands beyond transfer and MoveCall", async () => {
    const normalizedSuiPackage = "0x0000000000000000000000000000000000000000000000000000000000000002";
    const destinationCoin = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const sourceCoin = "0x2222222222222222222222222222222222222222222222222222222222222222";
    const vectorObject = "0x3333333333333333333333333333333333333333333333333333333333333333";
    const upgradePackage = "0x4444444444444444444444444444444444444444444444444444444444444444";
    const upgradeTicket = "0x5555555555555555555555555555555555555555555555555555555555555555";

    const tx = new Transaction();
    tx.mergeCoins(tx.objectRef(objectRef(destinationCoin)), [tx.objectRef(objectRef(sourceCoin))]);
    tx.makeMoveVec({
      type: "0x2::coin::Coin<0x2::sui::SUI>",
      elements: [tx.objectRef(objectRef(vectorObject))]
    });
    tx.publish({ modules: [[1, 2, 3]], dependencies: ["0x2"] });
    tx.upgrade({
      modules: [[4, 5, 6]],
      dependencies: ["0x2"],
      package: upgradePackage,
      ticket: tx.objectRef(objectRef(upgradeTicket))
    });
    const ptbBytes = await tx.build({ onlyTransactionKind: true });

    const { facts, commands } = new DefaultPtbInspector().inspect(ptbBytes);

    expect(commands.map((command) => command.kind)).toEqual(["mergeCoins", "makeMoveVec", "publish", "upgrade"]);
    expect(facts.riskLevel).toBe("critical");
    expect(facts.objectsTouched).toEqual([destinationCoin, sourceCoin, upgradeTicket, vectorObject].sort());
    expect(facts.packagesTouched).toEqual([normalizedSuiPackage, upgradePackage].sort());
  });

  test("inspects transfer commands and approves allowed policy", () => {
    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "10", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest = transferManifest(ptbBytes);
    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);

    expect(facts.semanticType).toBe("transfer");
    expect(facts.transfers[0].recipient).toBe("0xbob");
    expect(inspector.validateManifest(manifest, facts).ok).toBe(true);

    const policy: Policy = {
      id: "policy-1",
      version: "0.1",
      rules: [
        { name: "max_value_at_risk", params: { maxAmount: "20", coinType: "SUI" } },
        { name: "recipient_allowlist", params: { recipients: ["0xbob"] } },
        { name: "expiration_check", params: {} }
      ]
    };
    const decision = new DefaultPolicyEngine().evaluate({ policy, facts, decider, nowMs: 1 });
    expect(decision.decision).toBe("approved");
  });

  test("rejects manifest that lies about inspected MoveCall target", () => {
    const ptbBytes = encodeInspectablePtb([
      {
        kind: "moveCall",
        packageId: "0xescrow",
        module: "escrow",
        function: "deposit",
        objects: ["0xvault"]
      }
    ]);
    const manifest: ActionManifest = {
      actionId: "act_move",
      traceId: "tr_move",
      actionType: "sui.ptb.v1",
      semanticType: "move_call",
      template: "move_call",
      summary: "Deposit into escrow",
      riskLevel: "high",
      primaryTarget: { packageId: "0xevil", module: "escrow", function: "deposit" },
      objectsTouched: ["0xvault"],
      policyRequirements: ["package_allowlist"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_move"
    };
    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);
    expect(inspector.validateManifest(manifest, facts).ok).toBe(false);
  });

  test("rejects manifest that understates transfer amount or touched objects", () => {
    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "100", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest = transferManifest(ptbBytes);
    manifest.valueAtRisk = { amount: "10", coinType: "SUI" };
    manifest.objectsTouched = [];

    const inspector = new DefaultPtbInspector();
    const { facts } = inspector.inspect(ptbBytes, manifest);
    const validation = inspector.validateManifest(manifest, facts);

    expect(validation.ok).toBe(false);
    expect(validation.errors.join("; ")).toContain("valueAtRisk");
    expect(validation.errors.join("; ")).toContain("omits inspected object");
  });

  test("unknown opaque PTB requires confirmation by default", () => {
    const ptbBytes = new Uint8Array([1, 2, 3]);
    const manifest: ActionManifest = {
      actionId: "act_unknown",
      traceId: "tr_unknown",
      actionType: "sui.ptb.v1",
      semanticType: "unknown",
      template: "custom",
      summary: "Opaque PTB",
      riskLevel: "high",
      objectsTouched: [],
      policyRequirements: ["unknown_contract_guard"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_unknown"
    };
    const { facts } = new DefaultPtbInspector().inspect(ptbBytes, manifest);
    const decision = new DefaultPolicyEngine().evaluate({
      policy: {
        id: "policy-unknown",
        version: "0.1",
        rules: [{ name: "unknown_contract_guard", params: { mode: "requires_confirmation" } }]
      },
      facts,
      decider
    });
    expect(decision.decision).toBe("requires_confirmation");
  });

  test("default policy requires confirmation for high-risk MoveCall facts", async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: "0x2::pay::join_vec",
      arguments: [tx.pure.vector("u8", new Uint8Array([1, 2, 3]))]
    });
    const ptbBytes = await tx.build({ onlyTransactionKind: true });
    const manifest: ActionManifest = {
      actionId: "act_default_high_risk",
      traceId: "tr_default_high_risk",
      actionType: "sui.ptb.v1",
      semanticType: "move_call",
      template: "move_call",
      summary: "Call 0x2::pay::join_vec",
      riskLevel: "high",
      primaryTarget: {
        packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        module: "pay",
        function: "join_vec"
      },
      objectsTouched: [],
      policyRequirements: ["risk_level_guard"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_default_high_risk"
    };
    const { facts } = new DefaultPtbInspector().inspect(ptbBytes, manifest);
    const decision = new DefaultPolicyEngine().evaluate({
      policy: createDefaultPolicy(),
      facts,
      decider,
      nowMs: 1
    });

    expect(facts.riskLevel).toBe("high");
    expect(decision.decision).toBe("requires_confirmation");
    expect(decision.reason).toContain("risk level high requires confirmation");
  });

  test("createDefaultPolicy appends custom rules instead of removing default guards", async () => {
    const tx = new Transaction();
    tx.moveCall({
      target: "0x2::pay::join_vec",
      arguments: [tx.pure.vector("u8", new Uint8Array([1, 2, 3]))]
    });
    const ptbBytes = await tx.build({ onlyTransactionKind: true });
    const selector =
      "0x0000000000000000000000000000000000000000000000000000000000000002::pay::join_vec";
    const manifest: ActionManifest = {
      actionId: "act_append_policy",
      traceId: "tr_append_policy",
      actionType: "sui.ptb.v1",
      semanticType: "move_call",
      template: "move_call",
      summary: "Call 0x2::pay::join_vec",
      riskLevel: "high",
      primaryTarget: {
        packageId: "0x0000000000000000000000000000000000000000000000000000000000000002",
        module: "pay",
        function: "join_vec"
      },
      objectsTouched: [],
      policyRequirements: ["function_allowlist"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_append_policy"
    };
    const { facts } = new DefaultPtbInspector().inspect(ptbBytes, manifest);
    const decision = new DefaultPolicyEngine().evaluate({
      policy: createDefaultPolicy({
        rules: [{ name: "function_allowlist", params: { selectors: [selector] } }]
      }),
      facts,
      decider,
      nowMs: 1
    });
    const replacedDecision = new DefaultPolicyEngine().evaluate({
      policy: createDefaultPolicy({
        replaceRules: true,
        rules: [{ name: "function_allowlist", params: { selectors: [selector] } }]
      }),
      facts,
      decider,
      nowMs: 1
    });

    expect(decision.decision).toBe("requires_confirmation");
    expect(decision.reason).toContain("risk level high requires confirmation");
    expect(replacedDecision.decision).toBe("approved");
  });

  test("missing declared policy requirements require confirmation", () => {
    const ptbBytes = encodeInspectablePtb([
      { kind: "transfer", recipient: "0xbob", amount: "10", coinType: "SUI", objectIds: ["0xcoin"] }
    ]);
    const manifest = transferManifest(ptbBytes);
    const { facts } = new DefaultPtbInspector().inspect(ptbBytes, manifest);
    const decision = new DefaultPolicyEngine().evaluate({
      policy: createDefaultPolicy({
        replaceRules: true,
        rules: [{ name: "max_value_at_risk", params: { maxAmount: "20", coinType: "SUI" } }]
      }),
      facts,
      decider,
      nowMs: 1
    });

    expect(decision.decision).toBe("requires_confirmation");
    expect(decision.reason).toContain("missing required policy checks: recipient_allowlist");
  });

  test("slippage policy requires confirmation when slippage facts are missing", () => {
    const ptbBytes = encodeInspectablePtb([
      {
        kind: "moveCall",
        packageId: "0xdeepbook",
        module: "trade",
        function: "swap_exact_in",
        objects: ["0xpool"]
      }
    ]);
    const manifest: ActionManifest = {
      actionId: "act_slippage_missing",
      traceId: "tr_slippage_missing",
      actionType: "sui.ptb.v1",
      semanticType: "move_call",
      template: "custom",
      summary: "Swap through DeepBook",
      riskLevel: "high",
      primaryTarget: { packageId: "0xdeepbook", module: "trade", function: "swap_exact_in" },
      objectsTouched: ["0xpool"],
      policyRequirements: ["slippage_limit"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: future,
      idempotencyKey: "idem_slippage_missing"
    };
    const { facts } = new DefaultPtbInspector().inspect(ptbBytes, manifest);
    const decision = new DefaultPolicyEngine().evaluate({
      policy: createDefaultPolicy({
        rules: [{ name: "slippage_limit", params: { maxBps: 50 } }]
      }),
      facts,
      decider,
      nowMs: 1
    });

    expect(decision.decision).toBe("requires_confirmation");
    expect(decision.reason).toContain("slippage facts missing");
  });
});
