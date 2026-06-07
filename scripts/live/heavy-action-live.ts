import { Transaction } from "@mysten/sui/transactions";
import {
  createDefaultPolicy,
  createSuiMeshClient,
  hashJson,
  SuiMoveTraceGuardDriver,
  SuiOnchainTraceGuard,
  type ActionManifest,
  type JsonValue
} from "../../src/index.ts";
import {
  createLiveSuiClient,
  DEFAULT_TRACE_PACKAGE_ID,
  DEFAULT_TRACE_REGISTRY_ID,
  liveNetwork,
  RecordingSuiClient,
  resolveSigner
} from "./live-common.ts";

function buildSelfTransfer(recipient: string, amountMist: bigint): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  tx.transferObjects([coin], tx.pure.address(recipient));
  return tx;
}

const network = liveNetwork();
const signer = await resolveSigner();
const address = signer.toSuiAddress();
const recipient = process.env.SUIMESH_LIVE_RECIPIENT ?? address;
const amountMist = BigInt(process.env.SUIMESH_LIVE_AMOUNT_MIST ?? "1");
const packageId = process.env.SUIMESH_TRACE_PACKAGE_ID ?? DEFAULT_TRACE_PACKAGE_ID;
const registryId = process.env.SUIMESH_TRACE_REGISTRY_ID ?? DEFAULT_TRACE_REGISTRY_ID;
const sessionId = `ses_live_heavy_${crypto.randomUUID()}`;
const traceId = `tr_live_heavy_${crypto.randomUUID()}`;

const suiClient = createLiveSuiClient(network);
const traceClient = new RecordingSuiClient(suiClient);
const traceGuard = new SuiOnchainTraceGuard(
  new SuiMoveTraceGuardDriver({
    client: traceClient,
    signer,
    packageId,
    registryId
  })
);
const client = createSuiMeshClient({ traceGuard });

const light = await client.light.sendMessage({
  sessionId,
  actor: { role: "user", id: "live-user", address },
  content: `Transfer ${amountMist.toString()} MIST to ${recipient}`
});

const ptbBytes = await buildSelfTransfer(recipient, amountMist).build({ onlyTransactionKind: true });
const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
  actionId: `act_live_${crypto.randomUUID()}`,
  traceId,
  semanticType: "transfer",
  template: "transfer",
  summary: `Transfer ${amountMist.toString()} MIST to ${recipient}`,
  riskLevel: "medium",
  valueAtRisk: { amount: amountMist.toString(), coinType: "SUI" },
  objectsTouched: ["gas"],
  policyRequirements: ["max_value_at_risk", "recipient_allowlist", "expiration_check"],
  expiresAtMs: Date.now() + 10 * 60_000,
  idempotencyKey: `idem_live_${crypto.randomUUID()}`
};
const proposed = await client.actions.proposePtb({
  sessionId,
  traceId,
  actor: { role: "agent", id: "live-agent", address },
  ptbBytes,
  manifest,
  previousEventHash: light.eventHash
});
const simulated = await client.actions.simulate(proposed.action);
const decisionRecord = await client.policy.evaluateAndRecord({
  sessionId,
  traceId,
  policy: createDefaultPolicy({
    rules: [
      { name: "max_value_at_risk", params: { maxAmount: amountMist.toString(), coinType: "SUI" } },
      { name: "recipient_allowlist", params: { recipients: [recipient] } },
      { name: "expiration_check", params: {} }
    ]
  }),
  facts: simulated.facts,
  decider: { role: "policy", id: "live-policy" },
  previousEventHash: proposed.envelope.eventHash
});
if (decisionRecord.decision.decision !== "approved") {
  throw new Error(`Live policy did not approve action: ${decisionRecord.decision.reason}`);
}

const anchorRecord = await client.trace.anchorAndRecord({
  sessionId,
  traceId,
  actor: { role: "policy", id: "live-policy" },
  actionHash: simulated.facts.actionHash,
  proposalHash: proposed.envelope.eventHash,
  decisionHash: decisionRecord.envelope.eventHash,
  authorizedExecutor: address,
  expiresAtMs: manifest.expiresAtMs,
  previousEventHash: decisionRecord.envelope.eventHash
});
const claimRecord = await client.trace.claimAndRecord({
  sessionId,
  traceId,
  actor: { role: "executor", id: "live-executor", address },
  actionHash: simulated.facts.actionHash,
  decision: decisionRecord.decision,
  previousEventHash: anchorRecord.envelope.eventHash
});
const receiptRecord = await client.trace.executeApprovedAndRecord({
  sessionId,
  traceId,
  actionHash: simulated.facts.actionHash,
  claim: claimRecord.claim,
  decision: decisionRecord.decision,
  executor: { role: "executor", id: "live-executor", address },
  previousEventHash: claimRecord.envelope.eventHash,
  execute: async () => {
    const tx = buildSelfTransfer(recipient, amountMist);
    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer,
      options: { showEffects: true, showEvents: true, showObjectChanges: true }
    });
    await suiClient.waitForTransaction({ digest: result.digest });
    return {
      txDigest: result.digest,
      effectsHash: hashJson((result.effects ?? {}) as JsonValue)
    };
  }
});
let duplicateClaimAfterExecution: { claimed: boolean; duplicate: boolean; error?: string };
try {
  const duplicateClaim = await traceGuard.claim({
    actionHash: simulated.facts.actionHash,
    decision: decisionRecord.decision
  });
  duplicateClaimAfterExecution = {
    claimed: duplicateClaim.claimed,
    duplicate: duplicateClaim.duplicate
  };
} catch (error) {
  duplicateClaimAfterExecution = {
    claimed: false,
    duplicate: true,
    error: error instanceof Error ? error.message : "duplicate claim rejected"
  };
}
const verified = await client.trace.verify(sessionId);

console.log(JSON.stringify({
  network,
  address,
  recipient,
  amountMist: amountMist.toString(),
  packageId,
  registryId,
  sessionId,
  traceId,
  actionHash: simulated.facts.actionHash,
  decision: decisionRecord.decision.decision,
  anchorStatus: anchorRecord.anchor.status,
  claim: {
    claimed: claimRecord.claim.claimed,
    duplicate: claimRecord.claim.duplicate
  },
  duplicateClaimAfterExecution,
  executionReceipt: {
    status: receiptRecord.receipt.status,
    txDigest: receiptRecord.receipt.txDigest
  },
  traceTxDigests: traceClient.digests,
  restoredEvents: (await client.trace.restore(sessionId)).length,
  verified
}, null, 2));
