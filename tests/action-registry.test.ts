import { describe, expect, test } from "bun:test";
import {
  DefaultPtbInspector,
  LocalActionRegistry,
  OnchainActionRegistry,
  createSuiMeshClient,
  encodeInspectablePtb,
  hashBytes,
  type ActionManifest
} from "../src/index.ts";

describe("action registry", () => {
  test("enriches PTB inspection with known action metadata", () => {
    const registry = new LocalActionRegistry([
      {
        selector: "0xdeepbook::trade::swap_exact_in",
        packageId: "0xdeepbook",
        module: "trade",
        function: "swap_exact_in",
        semanticType: "swap",
        protocolName: "DeepBook",
        riskCategory: "high",
        requiredPolicyChecks: ["package_allowlist", "function_allowlist", "slippage_limit"]
      }
    ]);
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
      actionId: "act_swap",
      traceId: "tr_swap",
      actionType: "sui.ptb.v1",
      semanticType: "swap",
      template: "custom",
      summary: "Swap through DeepBook",
      riskLevel: "high",
      primaryTarget: { packageId: "0xdeepbook", module: "trade", function: "swap_exact_in" },
      objectsTouched: ["0xpool"],
      policyRequirements: ["package_allowlist", "function_allowlist", "slippage_limit"],
      ptbHash: hashBytes(ptbBytes),
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_swap"
    };

    const inspector = new DefaultPtbInspector(registry);
    const { facts } = inspector.inspect(ptbBytes, manifest);

    expect(registry.resolve("0xdeepbook::trade::swap_exact_in")?.protocolName).toBe("DeepBook");
    expect(facts.semanticType).toBe("swap");
    expect(inspector.validateManifest(manifest, facts).ok).toBe(true);
  });

  test("SDK inspection awaits async registry metadata", async () => {
    const registry = new OnchainActionRegistry({
      async resolve(selector) {
        if (selector !== "0xdeepbook::trade::swap_exact_in") {
          return undefined;
        }
        return {
          selector,
          packageId: "0xdeepbook",
          module: "trade",
          function: "swap_exact_in",
          semanticType: "swap",
          protocolName: "DeepBook",
          riskCategory: "high",
          requiredPolicyChecks: ["package_allowlist", "function_allowlist", "slippage_limit"]
        };
      }
    });
    const client = createSuiMeshClient({ actionRegistry: registry });
    const ptbBytes = encodeInspectablePtb([
      {
        kind: "moveCall",
        packageId: "0xdeepbook",
        module: "trade",
        function: "swap_exact_in",
        objects: ["0xpool"]
      }
    ]);
    const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
      actionId: "act_async_swap",
      traceId: "tr_async_swap",
      semanticType: "swap",
      template: "custom",
      summary: "Swap through DeepBook",
      riskLevel: "high",
      primaryTarget: { packageId: "0xdeepbook", module: "trade", function: "swap_exact_in" },
      objectsTouched: ["0xpool"],
      policyRequirements: ["package_allowlist", "function_allowlist", "slippage_limit"],
      expiresAtMs: 4_000_000_000_000,
      idempotencyKey: "idem_async_swap"
    };

    const proposed = await client.actions.proposePtb({
      sessionId: "ses_async_registry",
      traceId: "tr_async_swap",
      actor: { role: "agent", id: "agent" },
      ptbBytes,
      manifest
    });

    expect(proposed.inspection.facts.semanticType).toBe("swap");
    expect(proposed.inspection.facts.policyRequirements).toEqual([
      "function_allowlist",
      "package_allowlist",
      "slippage_limit"
    ]);
  });

  test("sync inspector refuses async registry instead of silently falling back", () => {
    const registry = new OnchainActionRegistry({
      async resolve() {
        return undefined;
      }
    });
    const ptbBytes = encodeInspectablePtb([
      {
        kind: "moveCall",
        packageId: "0xdeepbook",
        module: "trade",
        function: "swap_exact_in"
      }
    ]);

    expect(() => new DefaultPtbInspector(registry).inspect(ptbBytes)).toThrow("Async ActionRegistry");
  });
});
