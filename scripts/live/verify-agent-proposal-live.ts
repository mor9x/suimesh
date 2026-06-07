import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";
import {
  createSuiMeshClient,
  decodeEvent,
  SuiStackEventTransport,
  type EventEnvelope,
  type SuiPtbAction
} from "../../src/index.ts";
import {
  createLiveSuiClient,
  DEFAULT_RELAYER_URL,
  liveNetwork,
  requireEnv,
  resolveSealServerConfigs,
  resolveSealThreshold,
  resolveSigner
} from "./live-common.ts";

type GroupRef = { uuid: string };

function assertEqual(name: string, actual: string | undefined, expected: string | undefined): void {
  if (expected && actual !== expected) {
    throw new Error(`${name} mismatch: expected ${expected}, got ${actual ?? "<missing>"}`);
  }
}

function requireEvent(events: EventEnvelope[], eventType: EventEnvelope["eventType"]): EventEnvelope {
  const event = events.find((entry) => entry.eventType === eventType);
  if (!event) {
    throw new Error(`Missing ${eventType}; restored event types: ${events.map((entry) => entry.eventType).join(", ")}`);
  }
  return event;
}

const network = liveNetwork();
const sessionId = requireEnv("SUIMESH_GROUP_UUID");
const relayerUrl = process.env.SUIMESH_RELAYER_URL ?? DEFAULT_RELAYER_URL;
const signer = await resolveSigner();
const address = signer.toSuiAddress();
const sealServerConfigs = resolveSealServerConfigs(network);
const sealThreshold = resolveSealThreshold(sealServerConfigs);

const relayerHealth = await fetch(`${relayerUrl.replace(/\/$/, "")}/health_check`);
if (!relayerHealth.ok) {
  throw new Error(`Relayer health check failed: ${relayerHealth.status} ${await relayerHealth.text()}`);
}

const suiClient = createLiveSuiClient(network);
const stackClient = createSuiStackMessagingClient(suiClient, {
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
const groupRef: GroupRef = { uuid: sessionId };
const suimesh = createSuiMeshClient({
  transport: new SuiStackEventTransport({
    client: stackClient.messaging,
    signer,
    groupRefForSession: () => groupRef
  })
});

const events = await suimesh.trace.restore(sessionId);
const verified = await suimesh.trace.verify(sessionId);
if (!verified.ok) {
  throw new Error(`SuiMesh verify failed: ${verified.errors.join("; ")}`);
}

const userEvent = requireEvent(events, "conversation.user_message.v1");
const agentEvent = requireEvent(events, "conversation.agent_message.v1");
const proposalEvent = requireEvent(events, "decision.sui_ptb_action.v1");
assertEqual("proposalEventHash", proposalEvent.eventHash, process.env.SUIMESH_EXPECTED_PROPOSAL_EVENT_HASH);

const decodedProposal = decodeEvent(proposalEvent);
const action = decodedProposal.payload as unknown as SuiPtbAction;
const inspected = await suimesh.actions.inspect(action);
assertEqual("actionHash", inspected.facts.actionHash, process.env.SUIMESH_EXPECTED_ACTION_HASH);
assertEqual("ptbHash", inspected.facts.ptbHash, process.env.SUIMESH_EXPECTED_PTB_HASH);

stackClient.messaging.disconnect();

console.log(JSON.stringify({
  network,
  address,
  relayerUrl,
  sessionId,
  eventCount: events.length,
  restoredEventTypes: events.map((event) => event.eventType),
  userEventHash: userEvent.eventHash,
  agentMessageEventHash: agentEvent.eventHash,
  proposalEventHash: proposalEvent.eventHash,
  actionHash: inspected.facts.actionHash,
  ptbHash: inspected.facts.ptbHash,
  manifest: action.manifest,
  inspectedFacts: {
    semanticType: inspected.facts.semanticType,
    riskLevel: inspected.facts.riskLevel,
    transfers: inspected.facts.transfers,
    valueAtRisk: inspected.facts.valueAtRisk,
    objectsTouched: inspected.facts.objectsTouched
  },
  verified
}, null, 2));
