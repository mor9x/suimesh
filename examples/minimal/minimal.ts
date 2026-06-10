import {
  createDefaultPolicy,
  createSuiMeshClient,
  encodeInspectablePtb,
  policyRules
} from "../../src/index.ts";

const client = createSuiMeshClient();

const user = client.actors.user("alice", { address: "0xalice" });
const agent = client.actors.agent("demo-agent", { address: "0xagent" });
const policyActor = client.actors.policy("default-policy");

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

const manifest = client.manifest.transfer({
  traceId: "tr_minimal",
  amount: "10",
  coinType: "SUI",
  recipient: "0xbob",
  objectIds: ["0xcoin"],
  summary: "Send 10 SUI to Bob",
  idempotencyKey: "idem_minimal"
});

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
      policyRules.maxValueAtRisk({ maxAmount: "20", coinType: "SUI" }),
      policyRules.recipientAllowlist(["0xbob"]),
      policyRules.expirationCheck()
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
