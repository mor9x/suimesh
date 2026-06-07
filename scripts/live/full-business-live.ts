import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";
import type { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createDefaultPolicy,
  createSuiMeshClient,
  encodeEvent,
  hashBytes,
  hashJson,
  SuiMoveTraceGuardDriver,
  SuiOnchainTraceGuard,
  SuiStackEventTransport,
  WalrusHttpClient,
  WalrusStorageAdapter,
  type ActionManifest,
  type EventEnvelope,
  type JsonValue,
  type PtbInspectionResult,
  type PtbSimulator,
  type SimulationResult,
} from "../../src/index.ts";
import {
  createLiveSuiClient,
  DEFAULT_RELAYER_URL,
  DEFAULT_TRACE_PACKAGE_ID,
  DEFAULT_TRACE_REGISTRY_ID,
  DEFAULT_WALRUS_AGGREGATOR_URL,
  DEFAULT_WALRUS_PUBLISHER_URL,
  liveNetwork,
  RecordingSuiClient,
  resolveSealServerConfigs,
  resolveSealThreshold,
  resolveSigner,
  sleep
} from "./live-common.ts";

type GroupRef = { uuid: string };
type SealManagedArchiveEncryption = {
  encrypt(input: {
    uuid: string;
    data: Uint8Array;
    aad?: Uint8Array;
  }): Promise<{
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    keyVersion: bigint;
    aad?: Uint8Array;
  }>;
  decrypt(input: {
    uuid: string;
    envelope: {
      ciphertext: Uint8Array;
      nonce: Uint8Array;
      keyVersion: bigint;
      aad?: Uint8Array;
    };
  }): Promise<Uint8Array>;
};

class LiveDevInspectSimulator implements PtbSimulator {
  constructor(
    private readonly client: SuiJsonRpcClient,
    private readonly sender: string
  ) {}

  async simulate(input: { ptbBytes: Uint8Array; manifest: ActionManifest; facts: PtbInspectionResult["facts"] }): Promise<SimulationResult> {
    const result = await this.client.devInspectTransactionBlock({
      sender: this.sender,
      transactionBlock: input.ptbBytes
    });
    const effects = result.effects as unknown as {
      status?: { status?: string; error?: string };
      gasUsed?: Record<string, string | number>;
    };
    const status = effects.status;
    const gasEstimate = effects.gasUsed
      ? Object.values(effects.gasUsed).reduce((sum, value) => sum + BigInt(String(value)), 0n).toString()
      : undefined;
    return {
      ok: status?.status === "success",
      gasEstimate,
      balanceChanges: [],
      objectChanges: [{ effects: toJsonValue(result.effects) }],
      events: Array.isArray(result.events) ? (toJsonValue(result.events) as JsonValue[]) : [],
      error: status?.status === "success" ? undefined : status?.error ?? "devInspect failed"
    };
  }
}

function buildSelfTransfer(recipient: string, amountMist: bigint): Transaction {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  tx.transferObjects([coin], tx.pure.address(recipient));
  return tx;
}

async function waitForEventCount(client: ReturnType<typeof createSuiMeshClient>, sessionId: string, count: number): Promise<EventEnvelope[]> {
  const deadline = Date.now() + 90_000;
  let last: EventEnvelope[] = [];
  while (Date.now() < deadline) {
    last = await client.trace.restore(sessionId);
    if (last.length >= count) {
      return last;
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out waiting for ${count} events; last restored count=${last.length}`);
}

type SealManagedWalrusArchivePackage = {
  protocol: "suimesh";
  version: "0.1";
  kind: "full-business-live-seal-managed-archive";
  algorithm: "sui-stack-messaging-envelope-v1";
  groupRef: GroupRef;
  keyVersion: string;
  aad: string;
  nonce: string;
  ciphertext: string;
};

async function sealManagedWalrusArchive(input: {
  storage: WalrusStorageAdapter;
  encryption: SealManagedArchiveEncryption;
  groupRef: GroupRef;
  payload: JsonValue;
}): Promise<{
  blobId: string;
  digest: string;
  plaintextDigest: string;
  restoredPlaintextDigest: string;
  restoredBytes: number;
  restoredPlaintextBytes: number;
  algorithm: string;
  keyVersion: string;
}> {
  const plaintext = new TextEncoder().encode(JSON.stringify(input.payload));
  const plaintextDigest = hashBytes(plaintext);
  const aad = new TextEncoder().encode(
    JSON.stringify({
      protocol: "suimesh",
      version: "0.1",
      purpose: "walrus-audit-archive",
      sessionId: input.groupRef.uuid,
      plaintextDigest
    })
  );
  const encrypted = await input.encryption.encrypt({
    uuid: input.groupRef.uuid,
    data: plaintext,
    aad
  });
  const archivePackage: SealManagedWalrusArchivePackage = {
    protocol: "suimesh",
    version: "0.1",
    kind: "full-business-live-seal-managed-archive",
    algorithm: "sui-stack-messaging-envelope-v1",
    groupRef: input.groupRef,
    keyVersion: encrypted.keyVersion.toString(),
    aad: bytesToBase64Url(encrypted.aad ?? aad),
    nonce: bytesToBase64Url(encrypted.nonce),
    ciphertext: bytesToBase64Url(encrypted.ciphertext)
  };
  const packageBytes = new TextEncoder().encode(
    JSON.stringify(archivePackage)
  );
  const ref = await input.storage.put({
    bytes: packageBytes,
    contentType: "application/json",
    encrypted: true
  });
  const restored = await restoreSealManagedWalrusArchive({
    storage: input.storage,
    encryption: input.encryption,
    blobId: ref.blobId,
    digest: ref.digest,
    expectedPlaintextDigest: plaintextDigest
  });
  return {
    blobId: ref.blobId,
    digest: ref.digest,
    plaintextDigest,
    restoredPlaintextDigest: restored.plaintextDigest,
    restoredBytes: restored.restoredBytes,
    restoredPlaintextBytes: restored.restoredPlaintextBytes,
    algorithm: restored.algorithm,
    keyVersion: restored.keyVersion
  };
}

async function restoreSealManagedWalrusArchive(input: {
  storage: WalrusStorageAdapter;
  encryption: SealManagedArchiveEncryption;
  blobId: string;
  digest: string;
  expectedPlaintextDigest?: string;
}): Promise<{
  plaintextDigest: string;
  restoredBytes: number;
  restoredPlaintextBytes: number;
  algorithm: string;
  keyVersion: string;
}> {
  const restored = await input.storage.get({
    provider: "walrus",
    blobId: input.blobId,
    digest: input.digest,
    contentType: "application/json",
    encrypted: true
  });
  if (!restored) {
    throw new Error("Walrus archive restore returned no bytes");
  }
  const restoredDigest = hashBytes(restored);
  if (restoredDigest !== input.digest) {
    throw new Error(`Walrus archive digest mismatch: expected ${input.digest}, got ${restoredDigest}`);
  }
  const restoredPackage = JSON.parse(new TextDecoder().decode(restored)) as SealManagedWalrusArchivePackage;
  const restoredPlaintext = await input.encryption.decrypt({
    uuid: restoredPackage.groupRef.uuid,
    envelope: {
      ciphertext: base64UrlToBytes(restoredPackage.ciphertext),
      nonce: base64UrlToBytes(restoredPackage.nonce),
      keyVersion: BigInt(restoredPackage.keyVersion),
      aad: base64UrlToBytes(restoredPackage.aad)
    }
  });
  const restoredPlaintextDigest = hashBytes(restoredPlaintext);
  if (input.expectedPlaintextDigest && restoredPlaintextDigest !== input.expectedPlaintextDigest) {
    throw new Error(`Walrus plaintext mismatch: expected ${input.expectedPlaintextDigest}, got ${restoredPlaintextDigest}`);
  }
  return {
    plaintextDigest: restoredPlaintextDigest,
    restoredBytes: restored.length,
    restoredPlaintextBytes: restoredPlaintext.length,
    algorithm: restoredPackage.algorithm,
    keyVersion: restoredPackage.keyVersion
  };
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function eventId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

const network = liveNetwork();
const signer = await resolveSigner();
const address = signer.toSuiAddress();
const recipient = process.env.SUIMESH_LIVE_RECIPIENT ?? address;
const amountMist = BigInt(process.env.SUIMESH_LIVE_AMOUNT_MIST ?? "1");
const packageId = process.env.SUIMESH_TRACE_PACKAGE_ID ?? DEFAULT_TRACE_PACKAGE_ID;
const registryId = process.env.SUIMESH_TRACE_REGISTRY_ID ?? DEFAULT_TRACE_REGISTRY_ID;
const relayerUrl = process.env.SUIMESH_RELAYER_URL ?? DEFAULT_RELAYER_URL;
const sessionId = process.env.SUIMESH_GROUP_UUID ?? `suimesh-business-${crypto.randomUUID()}`;
const traceId = `tr_business_${crypto.randomUUID()}`;
const sealServerConfigs = resolveSealServerConfigs(network);
const sealThreshold = resolveSealThreshold(sealServerConfigs);
const publisherUrl = process.env.SUIMESH_WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL;
const aggregatorUrl = process.env.SUIMESH_WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL;

const relayerHealth = await fetch(`${relayerUrl.replace(/\/$/, "")}/health_check`);
if (!relayerHealth.ok) {
  throw new Error(`Relayer health check failed: ${relayerHealth.status} ${await relayerHealth.text()}`);
}

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
const storage = new WalrusStorageAdapter(
  new WalrusHttpClient({
    publisherUrl,
    aggregatorUrl,
    epochs: Number(process.env.SUIMESH_WALRUS_EPOCHS ?? "5"),
    readRetry: {
      attempts: Number(process.env.SUIMESH_WALRUS_READ_ATTEMPTS ?? "8"),
      delayMs: Number(process.env.SUIMESH_WALRUS_READ_DELAY_MS ?? "2500")
    }
  })
);

function createOfficialClient() {
  return createSuiStackMessagingClient(suiClient, {
    seal: {
      serverConfigs: sealServerConfigs
    },
    encryption: {
      sessionKey: {
        ttlMin: 10,
        signer
      },
      sealThreshold
    },
    relayer: { relayerUrl }
  });
}

const stackClient = createOfficialClient();
const groupRef = { uuid: sessionId };
const createResult = await stackClient.messaging.createAndShareGroup({
  signer,
  uuid: sessionId,
  name: `SuiMesh business ${new Date().toISOString()}`
});
await suiClient.waitForTransaction({ digest: createResult.digest });

const adapter = new SuiStackEventTransport({
  client: stackClient.messaging,
  signer,
  groupRefForSession: () => groupRef
});
const suimesh = createSuiMeshClient({
  transport: adapter,
  simulator: new LiveDevInspectSimulator(suiClient, address),
  traceGuard,
  storage
});

const intent = await suimesh.light.sendMessage({
  sessionId,
  traceId,
  actor: { role: "user", id: "business-user", address },
  content: `Intent: transfer ${amountMist.toString()} MIST to ${recipient}`
});

const ptbBytes = await buildSelfTransfer(recipient, amountMist).build({ onlyTransactionKind: true });
const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
  actionId: `act_business_${crypto.randomUUID()}`,
  traceId,
  semanticType: "transfer",
  template: "transfer",
  summary: `Transfer ${amountMist.toString()} MIST to ${recipient}`,
  riskLevel: "medium",
  valueAtRisk: { amount: amountMist.toString(), coinType: "SUI" },
  objectsTouched: ["gas"],
  policyRequirements: ["max_value_at_risk", "recipient_allowlist", "expiration_check"],
  expiresAtMs: Date.now() + 10 * 60_000,
  idempotencyKey: `idem_business_${crypto.randomUUID()}`
};

const proposed = await suimesh.actions.proposePtb({
  sessionId,
  traceId,
  actor: { role: "agent", id: "business-agent", address },
  ptbBytes,
  manifest,
  previousEventHash: intent.eventHash
});
const simulated = await suimesh.actions.simulate(proposed.action);
const decisionRecord = await suimesh.policy.evaluateAndRecord({
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
  decider: { role: "policy", id: "business-policy" },
  previousEventHash: proposed.envelope.eventHash
});
if (decisionRecord.decision.decision !== "approved") {
  throw new Error(`Policy did not approve action: ${decisionRecord.decision.reason}`);
}

const anchorRecord = await suimesh.trace.anchorAndRecord({
  sessionId,
  traceId,
  actor: { role: "policy", id: "business-policy" },
  actionHash: simulated.facts.actionHash,
  proposalHash: proposed.envelope.eventHash,
  decisionHash: decisionRecord.envelope.eventHash,
  authorizedExecutor: address,
  expiresAtMs: manifest.expiresAtMs,
  previousEventHash: decisionRecord.envelope.eventHash
});
const claimRecord = await suimesh.trace.claimAndRecord({
  sessionId,
  traceId,
  actor: { role: "executor", id: "business-executor", address },
  actionHash: simulated.facts.actionHash,
  decision: decisionRecord.decision,
  previousEventHash: anchorRecord.envelope.eventHash
});
const receiptRecord = await suimesh.trace.executeApprovedAndRecord({
  sessionId,
  traceId,
  actionHash: simulated.facts.actionHash,
  claim: claimRecord.claim,
  decision: decisionRecord.decision,
  executor: { role: "executor", id: "business-executor", address },
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
      effectsHash: hashJson(toJsonValue(result.effects ?? {}))
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

const restoredBeforeAudit = await waitForEventCount(suimesh, sessionId, 6);
const archive = await sealManagedWalrusArchive({
  storage,
  encryption: stackClient.messaging.encryption as SealManagedArchiveEncryption,
  groupRef,
  payload: toJsonValue({
    protocol: "suimesh",
    version: "0.1",
    kind: "full-business-live-audit-detail",
    sessionId,
    traceId,
    restoredEvents: restoredBeforeAudit,
    actionHash: simulated.facts.actionHash,
    policyDecision: decisionRecord.decision,
    simulation: simulated.facts.simulation,
    executionReceipt: receiptRecord.receipt,
    duplicateClaimAfterExecution,
    traceTxDigests: traceClient.digests
  })
});

const receiptEventHash = receiptRecord.envelope.eventHash;
if (!receiptEventHash) {
  throw new Error("ExecutionReceipt envelope is missing eventHash");
}

const audit = encodeEvent({
  encoding: "json-v1",
  header: {
    eventId: eventId("evt"),
    sessionId,
    traceId,
    eventType: "outcome.audit_event.v1",
    actor: { role: "system", id: "business-auditor" },
    previousEventHash: receiptEventHash,
    createdAtMs: Date.now()
  },
  payload: toJsonValue({
    traceId,
    state: "executed",
    eventHash: receiptEventHash,
    previousEventHash: receiptRecord.envelope.previousEventHash ?? null,
    detailRef: `walrus:${archive.blobId}#${archive.digest}`,
    createdAtMs: Date.now()
  })
});
await suimesh.messaging.send(audit);

const restoredAfterAudit = await waitForEventCount(suimesh, sessionId, 7);
const verified = await suimesh.trace.verify(sessionId);
stackClient.messaging.disconnect();

const reconnectStackClient = createOfficialClient();
const reconnectSuiMesh = createSuiMeshClient({
  transport: new SuiStackEventTransport({
    client: reconnectStackClient.messaging,
    signer,
    groupRefForSession: () => groupRef
  })
});
const restoredAfterReconnect = await waitForEventCount(reconnectSuiMesh, sessionId, 7);
const verifiedAfterReconnect = await reconnectSuiMesh.trace.verify(sessionId);
const walrusArchiveAfterReconnect = await restoreSealManagedWalrusArchive({
  storage,
  encryption: reconnectStackClient.messaging.encryption as SealManagedArchiveEncryption,
  blobId: archive.blobId,
  digest: archive.digest,
  expectedPlaintextDigest: archive.plaintextDigest
});
reconnectStackClient.messaging.disconnect();

console.log(JSON.stringify({
  network,
  address,
  recipient,
  amountMist: amountMist.toString(),
  relayerUrl,
  sealServerObjectIds: sealServerConfigs.map((config) => config.objectId),
  sealThreshold,
  groupCreateDigest: createResult.digest,
  packageId,
  registryId,
  sessionId,
  traceId,
  actionHash: simulated.facts.actionHash,
  decision: decisionRecord.decision.decision,
  simulation: simulated.facts.simulation,
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
  walrusArchive: archive,
  walrusArchiveAfterReconnect,
  restoredEvents: restoredAfterAudit.length,
  restoredAfterReconnectEvents: restoredAfterReconnect.length,
  verified,
  verifiedAfterReconnect
}, null, 2));
