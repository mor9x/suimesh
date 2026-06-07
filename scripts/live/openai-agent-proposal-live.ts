import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";
import { Transaction } from "@mysten/sui/transactions";
import {
  createSuiMeshClient,
  SuiStackEventTransport,
  type ActionManifest,
  type EventEnvelope,
  type JsonValue
} from "../../src/index.ts";
import {
  createLiveSuiClient,
  DEFAULT_RELAYER_URL,
  liveNetwork,
  resolveSealServerConfigs,
  resolveSealThreshold,
  resolveSigner,
  sleep
} from "./live-common.ts";

type GroupRef = { uuid: string };

type OpenAiChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type AgentProposalPlan = {
  semanticType: "transfer" | "move_call" | "swap" | "copy_trade" | "prediction_market" | "unknown";
  template: "transfer" | "move_call" | "custom";
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  recipient: string;
  amountMist: string;
  policyRequirements: string[];
};

function buildTransfer(recipient: string, amountMist: bigint): Transaction {
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

function userMessageContent(event: EventEnvelope): string {
  const payload = event.payload as Record<string, JsonValue>;
  const content = payload.content;
  if (typeof content !== "string") {
    throw new Error(`User message payload does not include string content: ${JSON.stringify(payload)}`);
  }
  return content;
}

function validatePlan(plan: AgentProposalPlan): AgentProposalPlan {
  if (plan.semanticType !== "transfer" || plan.template !== "transfer") {
    throw new Error(`This live test expects a transfer proposal, got ${plan.semanticType}/${plan.template}`);
  }
  if (!/^0x[a-fA-F0-9]+$/.test(plan.recipient)) {
    throw new Error(`OpenAI returned invalid Sui recipient address: ${plan.recipient}`);
  }
  try {
    if (BigInt(plan.amountMist) <= 0n) {
      throw new Error("amount must be positive");
    }
  } catch {
    throw new Error(`OpenAI returned invalid amountMist: ${plan.amountMist}`);
  }
  return {
    ...plan,
    policyRequirements: plan.policyRequirements.length > 0
      ? plan.policyRequirements
      : ["max_value_at_risk", "recipient_allowlist", "expiration_check"]
  };
}

function riskFloorForPlan(plan: AgentProposalPlan): AgentProposalPlan["riskLevel"] {
  if (plan.semanticType === "transfer") {
    return "medium";
  }
  if (plan.semanticType === "unknown") {
    return "high";
  }
  return "medium";
}

function maxRiskLevel(left: AgentProposalPlan["riskLevel"], right: AgentProposalPlan["riskLevel"]): AgentProposalPlan["riskLevel"] {
  const order = ["low", "medium", "high", "critical"] as const;
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}

async function callOpenAiAgent(input: {
  apiKey: string;
  model: string;
  userMessage: string;
  defaultRecipient: string;
  defaultAmountMist: string;
}): Promise<AgentProposalPlan> {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["semanticType", "template", "summary", "riskLevel", "recipient", "amountMist", "policyRequirements"],
    properties: {
      semanticType: { type: "string", enum: ["transfer", "move_call", "swap", "copy_trade", "prediction_market", "unknown"] },
      template: { type: "string", enum: ["transfer", "move_call", "custom"] },
      summary: { type: "string" },
      riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
      recipient: { type: "string" },
      amountMist: { type: "string", pattern: "^[0-9]+$" },
      policyRequirements: {
        type: "array",
        items: { type: "string" }
      }
    }
  };
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${input.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: "system",
          content: [
            "You are a SuiMesh agent adapter.",
            "Read a user message and create exactly one Sui PTB proposal plan.",
            "For this test, only transfer proposals are allowed.",
            "Return a JSON object matching the schema.",
            "Use amountMist as an integer MIST string.",
            `Default recipient: ${input.defaultRecipient}.`,
            `Default amountMist: ${input.defaultAmountMist}.`
          ].join("\n")
        },
        {
          role: "user",
          content: input.userMessage
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "suimesh_agent_proposal",
          strict: true,
          schema
        }
      }
    })
  });
  const body = (await response.json()) as OpenAiChatResponse;
  if (!response.ok) {
    throw new Error(`OpenAI request failed: ${response.status} ${body.error?.message ?? JSON.stringify(body)}`);
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`OpenAI response did not include message content: ${JSON.stringify(body)}`);
  }
  return validatePlan(JSON.parse(content) as AgentProposalPlan);
}

const openAiApiKey = process.env.OPENAI_API_KEY;
if (!openAiApiKey) {
  throw new Error("Missing OPENAI_API_KEY. Set it in the environment to run the OpenAI agent proposal live test.");
}

const network = liveNetwork();
const signer = await resolveSigner();
const address = signer.toSuiAddress();
const recipient = process.env.SUIMESH_AGENT_DEFAULT_RECIPIENT ?? address;
const amountMist = BigInt(process.env.SUIMESH_AGENT_DEFAULT_AMOUNT_MIST ?? "1");
const relayerUrl = process.env.SUIMESH_RELAYER_URL ?? DEFAULT_RELAYER_URL;
const sessionId = process.env.SUIMESH_GROUP_UUID ?? `suimesh-agent-proposal-${crypto.randomUUID()}`;
const traceId = `tr_agent_proposal_${crypto.randomUUID()}`;
const openAiModel = process.env.SUIMESH_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5";
const userMessage = process.env.SUIMESH_AGENT_USER_MESSAGE ??
  `Please prepare a Sui transfer proposal for ${amountMist.toString()} MIST to ${recipient}. Do not execute it.`;

const relayerHealth = await fetch(`${relayerUrl.replace(/\/$/, "")}/health_check`);
if (!relayerHealth.ok) {
  throw new Error(`Relayer health check failed: ${relayerHealth.status} ${await relayerHealth.text()}`);
}

const suiClient = createLiveSuiClient(network);
const sealServerConfigs = resolveSealServerConfigs(network);
const sealThreshold = resolveSealThreshold(sealServerConfigs);

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
const groupRef: GroupRef = { uuid: sessionId };
const createResult = await stackClient.messaging.createAndShareGroup({
  signer,
  uuid: sessionId,
  name: `SuiMesh agent proposal ${new Date().toISOString()}`
});
await suiClient.waitForTransaction({ digest: createResult.digest });

const suimesh = createSuiMeshClient({
  transport: new SuiStackEventTransport({
    client: stackClient.messaging,
    signer,
    groupRefForSession: () => groupRef
  })
});

const userEvent = await suimesh.light.sendMessage({
  sessionId,
  traceId,
  actor: { role: "user", id: "live-user", address },
  content: userMessage
});

const restoredForAgent = await waitForEventCount(suimesh, sessionId, 1);
const restoredUserMessage = userMessageContent(restoredForAgent.at(-1) ?? userEvent);
const agentPlan = await callOpenAiAgent({
  apiKey: openAiApiKey,
  model: openAiModel,
  userMessage: restoredUserMessage,
  defaultRecipient: recipient,
  defaultAmountMist: amountMist.toString()
});

const agentMessage = await suimesh.light.sendMessage({
  sessionId,
  traceId,
  actor: { role: "agent", id: "openai-agent", address },
  content: agentPlan.summary,
  previousEventHash: userEvent.eventHash
});

const ptbBytes = await buildTransfer(agentPlan.recipient, BigInt(agentPlan.amountMist)).build({ onlyTransactionKind: true });
const manifestRiskLevel = maxRiskLevel(agentPlan.riskLevel, riskFloorForPlan(agentPlan));
const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
  actionId: `act_agent_${crypto.randomUUID()}`,
  traceId,
  semanticType: agentPlan.semanticType,
  template: agentPlan.template,
  summary: agentPlan.summary,
  riskLevel: manifestRiskLevel,
  valueAtRisk: { amount: agentPlan.amountMist, coinType: "SUI" },
  objectsTouched: ["gas"],
  policyRequirements: agentPlan.policyRequirements,
  expiresAtMs: Date.now() + 10 * 60_000,
  idempotencyKey: `idem_agent_${crypto.randomUUID()}`
};
const proposed = await suimesh.actions.proposePtb({
  sessionId,
  traceId,
  actor: { role: "agent", id: "openai-agent", address },
  ptbBytes,
  manifest,
  previousEventHash: agentMessage.eventHash
});
const inspected = await suimesh.actions.inspect(proposed.action);
const restoredAfterProposal = await waitForEventCount(suimesh, sessionId, 3);
const verified = await suimesh.trace.verify(sessionId);
stackClient.messaging.disconnect();

console.log(JSON.stringify({
  network,
  address,
  relayerUrl,
  openAiModel,
  sessionId,
  traceId,
  groupCreateDigest: createResult.digest,
  userEventHash: userEvent.eventHash,
  agentMessageEventHash: agentMessage.eventHash,
  proposalEventHash: proposed.envelope.eventHash,
  actionHash: inspected.facts.actionHash,
  ptbHash: inspected.facts.ptbHash,
  agentPlan,
  manifestRiskLevel,
  inspectedFacts: {
    semanticType: inspected.facts.semanticType,
    riskLevel: inspected.facts.riskLevel,
    transfers: inspected.facts.transfers,
    valueAtRisk: inspected.facts.valueAtRisk,
    objectsTouched: inspected.facts.objectsTouched
  },
  restoredEventTypes: restoredAfterProposal.map((event) => event.eventType),
  verified
}, null, 2));
