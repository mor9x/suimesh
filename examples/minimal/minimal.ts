import {
  createDefaultPolicy,
  createSuiMeshClient,
  encodeInspectablePtb,
  type ActionManifest
} from "../../src/index.ts";

const client = createSuiMeshClient();

const user = { role: "user" as const, id: "alice", address: "0xalice" };
const agent = { role: "agent" as const, id: "demo-agent", address: "0xagent" };
const policyActor = { role: "policy" as const, id: "default-policy" };

const light = await client.light.sendMessage({
  sessionId: "ses_minimal",
  actor: user,
  content: "Prepare a 10 SUI transfer to Bob."
});

const ptbBytes = encodeInspectablePtb([
  {
    kind: "transfer",
    recipient: "0xbob",
    amount: "10",
    coinType: "SUI",
    objectIds: ["0xcoin"]
  }
]);

const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
  actionId: "act_minimal",
  traceId: "tr_minimal",
  semanticType: "transfer",
  template: "transfer",
  summary: "Send 10 SUI to Bob",
  riskLevel: "medium",
  valueAtRisk: { amount: "10", coinType: "SUI" },
  objectsTouched: ["0xcoin"],
  policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
  expiresAtMs: Date.now() + 60_000,
  idempotencyKey: "idem_minimal"
};

const proposed = await client.actions.proposePtb({
  sessionId: "ses_minimal",
  traceId: "tr_minimal",
  actor: agent,
  ptbBytes,
  manifest,
  previousEventHash: light.eventHash
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
  decider: policyActor
});

console.log({
  actionHash: simulated.facts.actionHash,
  decision: decision.decision,
  reason: decision.reason
});
