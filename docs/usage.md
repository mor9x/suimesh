# SuiMesh Usage Guide

This guide shows how to use the SuiMesh v0.1 SDK.

Your application can run SuiMesh with the default in-memory adapters for tests,
or plug in real transport, memory, storage, policy, and trace adapters for live flows.

## Install And Run

From the project root:

```bash
bun install
bun run typecheck
bun test
bun run example:minimal
```

When using the source checkout directly, import from `src/index.ts`:

```ts
import { createSuiMeshClient } from "./src/index.ts";
```

## Create A Client

The default client uses local in-memory adapters. This is the fastest way to test protocol behavior.

```ts
import { createSuiMeshClient } from "./src/index.ts";

const client = createSuiMeshClient();
```

Production or live-test clients should pass explicit adapters:

```ts
const client = createSuiMeshClient({
  transport,
  storage,
  memory,
  inspector,
  simulator,
  policyEngine,
  traceGuard,
});
```

Adapter responsibilities:

| Adapter | What it does |
| --- | --- |
| `transport` | Sends, lists, and subscribes to SuiMesh events. |
| `storage` | Stores encrypted context archives and returns refs/digests. |
| `memory` | Records memory recall/remember receipts. |
| `inspector` | Parses Sui PTB bytes into objective facts. |
| `simulator` | Adds dry-run/devInspect facts. |
| `policyEngine` | Evaluates facts against policy. |
| `traceGuard` | Anchors, claims, completes, and blocks duplicate execution. |

## Friendly Builders

Most application code should not hard-code protocol strings. Use the SDK builders and exported constants instead:

```ts
import { SuiMeshConstants, policyRules } from "./src/index.ts";

const user = client.actors.user("alice", { address: "0xalice" });
const agent = client.actors.agent("agent-1", { address: "0xagent" });

const manifest = client.manifest.transfer({
  traceId: "tr_demo",
  amount: "10",
  coinType: "SUI",
  recipient: "0xbob",
});

const rule = policyRules.maxValueAtRisk({ maxAmount: "20", coinType: "SUI" });

console.log(SuiMeshConstants.eventTypes.SuiPtbAction);
```

The low-level protocol types are still exported for advanced integrations, but builders are the recommended default.

## Send Light Context

Use Light Path for ordinary conversation and context events.

```ts
const user = client.actors.user("alice", { address: "0xalice" });

const light = await client.light.sendMessage({
  sessionId: "ses_demo",
  actor: user,
  content: "Prepare a small SUI transfer to Bob.",
});
```

Light events are useful for chat, explanations, status updates, and memory receipts. They are not the
security root for high-value actions.

## Propose A Heavy PTB Action

Use Heavy Path for money, permissions, contract state, trading, prediction markets, and external side
effects.

v0.1 has one low-level heavy action type:

```text
action_type = sui.ptb.v1
```

For deterministic local tests, use `encodeInspectablePtb(...)`. For live flows,
pass real Sui `TransactionKind` or `TransactionData` BCS bytes.

```ts
import {
  createSuiMeshClient,
  encodeInspectablePtb,
} from "./src/index.ts";

const client = createSuiMeshClient();
const agent = client.actors.agent("agent-1", { address: "0xagent" });

const ptbBytes = encodeInspectablePtb([
  {
    kind: "transfer",
    recipient: "0xbob",
    amount: "10",
    coinType: "SUI",
    objectIds: ["0xcoin"],
  },
]);

const manifest = client.manifest.transfer({
  actionId: "act_demo",
  traceId: "tr_demo",
  amount: "10",
  coinType: "SUI",
  recipient: "0xbob",
  objectIds: ["0xcoin"],
  expiresAtMs: Date.now() + 60_000,
  idempotencyKey: "idem_demo_transfer",
});

const proposed = await client.actions.proposePtb({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: agent,
  ptbBytes,
  manifest,
  previousEventHash: light.eventHash,
});
```

`proposePtb(...)` inspects the PTB and rejects the action if the manifest does not match the
inspected facts.

Security rule:

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Policy approves facts, not prose.
```

## Inspect, Simulate, And Evaluate Policy

```ts
import { createDefaultPolicy, policyRules } from "./src/index.ts";

const simulated = await client.actions.simulate(proposed.action);

const decision = client.policy.evaluate({
  policy: createDefaultPolicy({
    rules: [
      policyRules.maxValueAtRisk({ maxAmount: "20", coinType: "SUI" }),
      policyRules.recipientAllowlist(["0xbob"]),
      policyRules.expirationCheck(),
    ],
  }),
  facts: simulated.facts,
  decider: client.actors.policy("default-policy"),
});
```

`createDefaultPolicy({ rules })` appends your rules to the default guards, including
`risk_level_guard` and `unknown_contract_guard`. Use `replaceRules: true` only when you intentionally
want to replace the default safety guards.

For a recoverable trace, use `evaluateAndRecord(...)` instead of `evaluate(...)`:

```ts
const recordedDecision = await client.policy.evaluateAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  policy: createDefaultPolicy(),
  facts: simulated.facts,
  decider: client.actors.policy("default-policy"),
  previousEventHash: proposed.envelope.eventHash,
});
```

Decision values:

```text
approved
rejected
requires_confirmation
```

## Anchor, Claim, Execute, And Record A Receipt

Money-moving or contract-changing execution must be coordinated by a trace guard.

```ts
const anchor = await client.trace.anchorAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: client.actors.system("trace-guard"),
  actionHash: simulated.facts.actionHash,
  decisionHash: recordedDecision.envelope.eventHash,
  authorizedExecutor: "0xexecutor",
  expiresAtMs: manifest.expiresAtMs,
  previousEventHash: recordedDecision.envelope.eventHash,
});

const claim = await client.trace.claimAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: client.actors.executor("executor-1", { address: "0xexecutor" }),
  actionHash: simulated.facts.actionHash,
  decision: recordedDecision.decision,
  previousEventHash: anchor.envelope.eventHash,
});

const receipt = await client.trace.executeApprovedAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actionHash: simulated.facts.actionHash,
  claim: claim.claim,
  decision: recordedDecision.decision,
  executor: client.actors.executor("executor-1", { address: "0xexecutor" }),
  previousEventHash: claim.envelope.eventHash,
  execute: async () => ({
    txDigest: "demo_tx_digest",
    effectsHash: "demo_effects_hash",
  }),
});
```

Execution rules:

```text
No approved PolicyDecision, no execution.
No successful ActionClaim, no execution.
No ExecutionReceipt, no completed trace.
```

The on-chain trace guard records the authorized executor and action expiry at anchor time. Claim and
completion transactions must be sent by the authorized executor/claimant.

For live Sui coordination, use `SuiOnchainTraceGuard` with a `SuiMoveTraceGuardDriver`. The local
trace guard is for tests and deterministic examples.

## Restore And Verify

Any client with access to the session transport can restore and verify the trace.

```ts
const events = await client.trace.restore("ses_demo");
const verification = await client.trace.verify("ses_demo");

console.log({
  events: events.length,
  ok: verification.ok,
  errors: verification.errors,
});
```

Verification checks event decoding and the `previousEventHash` chain. For Heavy Path events, BCS
payload hashes are checked by the event codec.

## Store Context Archives

Use `storage.put(...)` to store encrypted context archives. The default adapter is local memory.
For Walrus, construct a `WalrusStorageAdapter` with `WalrusHttpClient`.

```ts
import { WalrusHttpClient, WalrusStorageAdapter } from "./src/index.ts";

const storage = new WalrusStorageAdapter(
  new WalrusHttpClient({
    publisherUrl: "https://publisher.walrus-testnet.walrus.space",
    aggregatorUrl: "https://aggregator.walrus-testnet.walrus.space",
    epochs: 5,
  }),
);

const ref = await storage.put({
  bytes: new TextEncoder().encode("encrypted archive bytes"),
  contentType: "application/octet-stream",
  encrypted: true,
});
```

SuiMesh expects the caller to encrypt sensitive content before storage unless the chosen adapter
performs encryption internally.

## Use Sui Stack Messaging As A Transport

Sui Stack Messaging can be used as an optional SuiMesh transport binding.

```ts
import { SuiStackEventTransport, createSuiMeshClient } from "./src/index.ts";

const transport = new SuiStackEventTransport({
  client: suiStackClient.messaging,
  signer,
  groupRefForSession: (sessionId) => ({ uuid: sessionId }),
});

const client = createSuiMeshClient({ transport });
```

For group creation, membership, Seal key-server config, relayer config, and polling-based session
discovery, see [Sui Stack Messaging transport binding](sui-stack-messaging.md).

## Live Testnet Commands

Live scripts exercise real infrastructure, spend gas, and depend on external services.

```bash
bun run test:live:messaging
SUIMESH_RELAYER_URL=http://localhost:3000 bun run test:live:messaging:remote
OPENAI_API_KEY=... SUIMESH_OPENAI_MODEL=gpt-5.5 SUIMESH_RELAYER_URL=http://localhost:3000 bun run test:live:agent-proposal
SUIMESH_GROUP_UUID=... SUIMESH_RELAYER_URL=http://localhost:3000 bun run test:live:agent-proposal:verify
bun run test:live:heavy
bun run test:live:walrus
SUIMESH_RELAYER_URL=http://localhost:3000 bun run test:live:business
SUIMESH_RELAYER_URL=http://localhost:3000 OPENAI_API_KEY=... bun run test:live:full-regression
```

`test:live:agent-proposal` creates a real messaging group, sends a user message through the transport,
uses OpenAI as the agent planner, writes an agent reply, writes a `decision.sui_ptb_action.v1`
proposal event, restores the event stream, and verifies the hash chain.
Set `SUIMESH_OPENAI_MODEL=gpt-5.4-mini` to run the same flow with GPT-5.4 mini.
`test:live:agent-proposal:verify` restores an existing session by `SUIMESH_GROUP_UUID` and verifies
the recovered events and PTB proposal facts.

`test:live:full-regression` runs the protocol and live integration regression suite in one command:
typecheck, unit tests, relayer health, remote messaging recovery, OpenAI agent proposal plus verify,
heavy action execution, Walrus archive, and the integrated business flow. If `OPENAI_API_KEY` is not
available, it can verify an existing agent proposal by setting:

```bash
SUIMESH_AGENT_VERIFY_GROUP_UUID=...
SUIMESH_AGENT_VERIFY_PROPOSAL_EVENT_HASH=...
SUIMESH_AGENT_VERIFY_ACTION_HASH=...
SUIMESH_AGENT_VERIFY_PTB_HASH=...
```

`test:live:business` runs an integrated usage example:

```text
real messaging group
event delivery through a real transport binding
Sui PTB devInspect
policy approval
on-chain ActionAnchor
on-chain ActionClaim
PTB execution
ExecutionReceipt
Seal-managed encrypted Walrus audit archive
fresh client reconnect
event hash-chain verification
archive digest verification
archive decrypt through access policy
```
