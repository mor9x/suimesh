import { DEFAULT_RELAYER_URL } from "./live-common.ts";

type JsonObject = Record<string, unknown>;

type StepSummary = {
  name: string;
  durationMs: number;
  ok: true;
  summary?: JsonObject;
};

class StepError extends Error {
  constructor(
    readonly step: string,
    readonly exitCode: number | undefined,
    readonly stdout: string,
    readonly stderr: string
  ) {
    super(`Step ${step} failed${exitCode === undefined ? "" : ` with exit code ${exitCode}`}`);
  }
}

const repoRoot = new URL("../..", import.meta.url).pathname;
const relayerUrl = process.env.SUIMESH_RELAYER_URL ?? DEFAULT_RELAYER_URL;
const network = process.env.SUIMESH_NETWORK ?? "testnet";

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

function mergedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return cleanEnv({
    ...Bun.env,
    SUIMESH_NETWORK: network,
    SUIMESH_RELAYER_URL: relayerUrl,
    ...extra
  });
}

function tail(text: string, max = 6_000): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

function parseJsonObject(output: string): JsonObject {
  const start = output.indexOf("{");
  if (start < 0) {
    throw new Error("No JSON object found in command output");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < output.length; index += 1) {
    const char = output[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(output.slice(start, index + 1)) as JsonObject;
      }
    }
  }
  throw new Error("Unterminated JSON object in command output");
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function asObject(value: unknown, name: string): JsonObject {
  expect(value && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value as JsonObject;
}

function asString(value: unknown, name: string): string {
  expect(typeof value === "string" && value.length > 0, `${name} must be a non-empty string`);
  return value;
}

function asNumber(value: unknown, name: string): number {
  expect(typeof value === "number" && Number.isFinite(value), `${name} must be a finite number`);
  return value;
}

function arrayLength(value: unknown, name: string): number {
  expect(Array.isArray(value), `${name} must be an array`);
  return value.length;
}

function verifiedOk(value: unknown, name: string): void {
  const verified = asObject(value, name);
  expect(verified.ok === true, `${name}.ok must be true`);
}

async function runCommand(input: {
  name: string;
  cmd: string[];
  env?: Record<string, string | undefined>;
  parseJson?: boolean;
  assert?: (json: JsonObject) => JsonObject | void;
}): Promise<{ step: StepSummary; json?: JsonObject }> {
  const started = performance.now();
  const proc = Bun.spawn(input.cmd, {
    cwd: repoRoot,
    env: mergedEnv(input.env),
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new StepError(input.name, exitCode, stdout, stderr);
  }
  let json: JsonObject | undefined;
  let summary: JsonObject | undefined;
  if (input.parseJson) {
    json = parseJsonObject(`${stdout}\n${stderr}`);
    summary = input.assert?.(json) ?? json;
  }
  return {
    json,
    step: {
      name: input.name,
      durationMs: Math.round(performance.now() - started),
      ok: true,
      summary
    }
  };
}

async function runHealthCheck(): Promise<StepSummary> {
  const started = performance.now();
  const response = await fetch(`${relayerUrl.replace(/\/$/, "")}/health_check`);
  const body = await response.text();
  expect(response.ok, `Relayer health check failed: ${response.status} ${body}`);
  return {
    name: "relayer-health",
    durationMs: Math.round(performance.now() - started),
    ok: true,
    summary: {
      relayerUrl,
      status: response.status,
      body: body ? JSON.parse(body) as JsonObject : {}
    }
  };
}

function summarizeMessaging(json: JsonObject): JsonObject {
  verifiedOk(json.verified, "verified");
  verifiedOk(json.verifiedAfterReconnect, "verifiedAfterReconnect");
  expect(json.relayer === "http", "messaging remote test must use the HTTP relayer");
  expect(asNumber(json.restoredEvents, "restoredEvents") >= 1, "messaging restore must include at least one event");
  expect(
    asNumber(json.restoredAfterReconnectEvents, "restoredAfterReconnectEvents") >= 1,
    "messaging reconnect restore must include at least one event"
  );
  const discovered = asObject(json.discoveredTargetSession, "discoveredTargetSession");
  return {
    sessionId: json.sessionId,
    groupId: json.groupId,
    groupCreateDigest: json.groupCreateDigest,
    discoveredGroupId: discovered.groupId,
    restoredEvents: json.restoredEvents,
    restoredAfterReconnectEvents: json.restoredAfterReconnectEvents
  };
}

function summarizeAgentProposal(json: JsonObject): JsonObject {
  verifiedOk(json.verified, "verified");
  expect(arrayLength(json.restoredEventTypes, "restoredEventTypes") >= 3, "agent proposal must restore three events");
  asString(json.sessionId, "sessionId");
  asString(json.proposalEventHash, "proposalEventHash");
  asString(json.actionHash, "actionHash");
  asString(json.ptbHash, "ptbHash");
  return {
    sessionId: json.sessionId,
    traceId: json.traceId,
    openAiModel: json.openAiModel,
    proposalEventHash: json.proposalEventHash,
    actionHash: json.actionHash,
    ptbHash: json.ptbHash,
    restoredEventTypes: json.restoredEventTypes
  };
}

function summarizeAgentVerify(json: JsonObject): JsonObject {
  verifiedOk(json.verified, "verified");
  expect(asNumber(json.eventCount, "eventCount") >= 3, "agent verify must restore at least three events");
  const inspectedFacts = asObject(json.inspectedFacts, "inspectedFacts");
  expect(inspectedFacts.semanticType === "transfer", "agent verify expected transfer semantic type");
  return {
    sessionId: json.sessionId,
    eventCount: json.eventCount,
    proposalEventHash: json.proposalEventHash,
    actionHash: json.actionHash,
    ptbHash: json.ptbHash,
    semanticType: inspectedFacts.semanticType,
    riskLevel: inspectedFacts.riskLevel
  };
}

function summarizeHeavy(json: JsonObject): JsonObject {
  verifiedOk(json.verified, "verified");
  expect(json.decision === "approved", "heavy live policy decision must be approved");
  expect(json.anchorStatus === "anchored", "heavy live anchor status must be anchored");
  const claim = asObject(json.claim, "claim");
  expect(claim.claimed === true && claim.duplicate === false, "heavy live first claim must succeed");
  const duplicate = asObject(json.duplicateClaimAfterExecution, "duplicateClaimAfterExecution");
  expect(duplicate.duplicate === true, "heavy live duplicate claim must be blocked");
  const receipt = asObject(json.executionReceipt, "executionReceipt");
  expect(receipt.status === "success", "heavy live execution receipt must be success");
  expect(asNumber(json.restoredEvents, "restoredEvents") >= 6, "heavy live restore must include the full trace");
  return {
    sessionId: json.sessionId,
    traceId: json.traceId,
    actionHash: json.actionHash,
    executionTxDigest: receipt.txDigest,
    traceTxDigests: json.traceTxDigests,
    restoredEvents: json.restoredEvents
  };
}

function summarizeWalrus(json: JsonObject): JsonObject {
  expect(json.verified === true, "walrus live archive must be verified");
  expect(json.encrypted === true, "walrus live archive must be marked encrypted");
  asString(json.blobId, "blobId");
  asString(json.digest, "digest");
  expect(asNumber(json.restoredBytes, "restoredBytes") > 0, "walrus restore must return bytes");
  expect(asNumber(json.restoredPlaintextBytes, "restoredPlaintextBytes") > 0, "walrus decrypt must return plaintext bytes");
  return {
    blobId: json.blobId,
    digest: json.digest,
    plaintextDigest: json.plaintextDigest,
    restoredBytes: json.restoredBytes,
    restoredPlaintextBytes: json.restoredPlaintextBytes
  };
}

function summarizeBusiness(json: JsonObject): JsonObject {
  verifiedOk(json.verified, "verified");
  verifiedOk(json.verifiedAfterReconnect, "verifiedAfterReconnect");
  expect(json.decision === "approved", "business live policy decision must be approved");
  const simulation = asObject(json.simulation, "simulation");
  expect(simulation.ok === true, "business live devInspect simulation must succeed");
  expect(json.anchorStatus === "anchored", "business live anchor status must be anchored");
  const claim = asObject(json.claim, "claim");
  expect(claim.claimed === true && claim.duplicate === false, "business live first claim must succeed");
  const duplicate = asObject(json.duplicateClaimAfterExecution, "duplicateClaimAfterExecution");
  expect(duplicate.duplicate === true, "business live duplicate claim must be blocked");
  const receipt = asObject(json.executionReceipt, "executionReceipt");
  expect(receipt.status === "success", "business live execution receipt must be success");
  const archive = asObject(json.walrusArchive, "walrusArchive");
  const archiveAfterReconnect = asObject(json.walrusArchiveAfterReconnect, "walrusArchiveAfterReconnect");
  expect(
    archive.plaintextDigest === archiveAfterReconnect.plaintextDigest,
    "business live Walrus archive plaintext digest must match after reconnect"
  );
  expect(asNumber(json.restoredEvents, "restoredEvents") >= 7, "business live restore must include audit event");
  expect(
    asNumber(json.restoredAfterReconnectEvents, "restoredAfterReconnectEvents") >= 7,
    "business live reconnect restore must include audit event"
  );
  return {
    sessionId: json.sessionId,
    traceId: json.traceId,
    actionHash: json.actionHash,
    executionTxDigest: receipt.txDigest,
    walrusBlobId: archive.blobId,
    walrusDigest: archive.digest,
    restoredEvents: json.restoredEvents,
    restoredAfterReconnectEvents: json.restoredAfterReconnectEvents
  };
}

function hasExistingAgentVerifyEnv(): boolean {
  return Boolean(
    process.env.SUIMESH_AGENT_VERIFY_GROUP_UUID &&
      process.env.SUIMESH_AGENT_VERIFY_PROPOSAL_EVENT_HASH &&
      process.env.SUIMESH_AGENT_VERIFY_ACTION_HASH &&
      process.env.SUIMESH_AGENT_VERIFY_PTB_HASH
  );
}

const steps: StepSummary[] = [];

try {
  steps.push((await runCommand({ name: "typecheck", cmd: ["bun", "run", "typecheck"] })).step);
  steps.push((await runCommand({ name: "unit-tests", cmd: ["bun", "test"] })).step);
  steps.push(await runHealthCheck());

  steps.push(
    (await runCommand({
      name: "live-messaging-remote",
      cmd: ["bun", "run", "test:live:messaging:remote"],
      parseJson: true,
      assert: summarizeMessaging
    })).step
  );

  let proposalJson: JsonObject | undefined;
  if (process.env.OPENAI_API_KEY && process.env.SUIMESH_FULL_REGRESSION_AGENT_MODE !== "verify") {
    const result = await runCommand({
      name: "live-openai-agent-proposal",
      cmd: ["bun", "run", "test:live:agent-proposal"],
      env: {
        SUIMESH_OPENAI_MODEL: process.env.SUIMESH_OPENAI_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-5.5"
      },
      parseJson: true,
      assert: summarizeAgentProposal
    });
    proposalJson = result.json;
    steps.push(result.step);
  }

  if (proposalJson) {
    steps.push(
      (await runCommand({
        name: "live-openai-agent-proposal-verify",
        cmd: ["bun", "run", "test:live:agent-proposal:verify"],
        env: {
          SUIMESH_GROUP_UUID: asString(proposalJson.sessionId, "proposal.sessionId"),
          SUIMESH_EXPECTED_PROPOSAL_EVENT_HASH: asString(
            proposalJson.proposalEventHash,
            "proposal.proposalEventHash"
          ),
          SUIMESH_EXPECTED_ACTION_HASH: asString(proposalJson.actionHash, "proposal.actionHash"),
          SUIMESH_EXPECTED_PTB_HASH: asString(proposalJson.ptbHash, "proposal.ptbHash")
        },
        parseJson: true,
        assert: summarizeAgentVerify
      })).step
    );
  } else {
    expect(
      hasExistingAgentVerifyEnv(),
      [
        "Full live regression needs either OPENAI_API_KEY for a fresh agent proposal,",
        "or SUIMESH_AGENT_VERIFY_GROUP_UUID plus expected proposal/action/PTB hashes for verify-only mode."
      ].join(" ")
    );
    steps.push(
      (await runCommand({
        name: "live-existing-agent-proposal-verify",
        cmd: ["bun", "run", "test:live:agent-proposal:verify"],
        env: {
          SUIMESH_GROUP_UUID: process.env.SUIMESH_AGENT_VERIFY_GROUP_UUID,
          SUIMESH_EXPECTED_PROPOSAL_EVENT_HASH: process.env.SUIMESH_AGENT_VERIFY_PROPOSAL_EVENT_HASH,
          SUIMESH_EXPECTED_ACTION_HASH: process.env.SUIMESH_AGENT_VERIFY_ACTION_HASH,
          SUIMESH_EXPECTED_PTB_HASH: process.env.SUIMESH_AGENT_VERIFY_PTB_HASH
        },
        parseJson: true,
        assert: summarizeAgentVerify
      })).step
    );
  }

  steps.push(
    (await runCommand({
      name: "live-heavy-action",
      cmd: ["bun", "run", "test:live:heavy"],
      parseJson: true,
      assert: summarizeHeavy
    })).step
  );

  steps.push(
    (await runCommand({
      name: "live-walrus-archive",
      cmd: ["bun", "run", "test:live:walrus"],
      parseJson: true,
      assert: summarizeWalrus
    })).step
  );

  steps.push(
    (await runCommand({
      name: "live-business-e2e",
      cmd: ["bun", "run", "test:live:business"],
      parseJson: true,
      assert: summarizeBusiness
    })).step
  );

  console.log(JSON.stringify({
    ok: true,
    network,
    relayerUrl,
    steps
  }, null, 2));
} catch (error) {
  if (error instanceof StepError) {
    console.error(JSON.stringify({
      ok: false,
      failedStep: error.step,
      exitCode: error.exitCode,
      stdoutTail: tail(error.stdout),
      stderrTail: tail(error.stderr),
      completedSteps: steps
    }, null, 2));
  } else {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      completedSteps: steps
    }, null, 2));
  }
  process.exit(1);
}
