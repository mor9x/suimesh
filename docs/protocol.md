# SuiMesh v0.1 Protocol Specification

SuiMesh is an Agent Action Communication Protocol on Sui.

It defines how users, agents, policy engines, executors, wallets, dApps, and memory providers communicate around agent actions in a way that is user-owned, recoverable, and verifiable.

Slogan:

```text
Own the Context. Verify the Action.
```

## 1. What The Protocol Does

SuiMesh turns these records into protocol state:

```text
conversation messages
user intents
agent proposals
Sui PTB actions
policy decisions
execution receipts
audit events
memory receipts
```

The core value is portable interaction state: conversations, policies, actions, receipts, and audit records can be recovered and verified across clients, agents, and applications.

For SDK usage, see [Usage guide](usage.md).
For the complete execution chain, see [End-to-end flow](end-to-end-flow.md).

## 2. Core Objects

| Object | Meaning |
| --- | --- |
| `Session` | Long-lived communication space owned by the user or group. |
| `Actor` | Writer of an event: user, agent, policy, executor, wallet, dApp, memory, system. |
| `Event` | One protocol message. Light events use JSON; heavy events use BCS inside a JSON envelope. |
| `Trace` | One heavy action workflow from intent to receipt and audit. |
| `SuiPtbAction` | Canonical heavy action: Sui PTB bytes plus Action Manifest. |
| `ActionManifest` | Human/policy-readable explanation of the PTB. |
| `PolicyFacts` | Facts extracted by inspection and simulation. |
| `PolicyDecision` | Approved, rejected, or requires confirmation. |
| `ActionAnchor` | On-chain ref/hash/status for a heavy action. |
| `ActionClaim` | On-chain execution lock to prevent duplicate execution. |
| `ExecutionReceipt` | Result of executing an approved and claimed action. |
| `AuditEvent` | Verifiable trace transition record. |
| `MemoryReceipt` | Record that a memory provider recalled or wrote memory. |

## 3. Two Paths

### Light Path

Light Path is for ordinary conversation and context messages.

```text
UserMessage
-> AgentMessage
-> optional MemoryReceipt
```

Properties:

```text
encoding = json-v1
transport = EventTransport adapter
storage = optional encrypted archive adapter
on-chain claim = no
```

Use Light Path for:

```text
chat
question answering
non-financial explanation
agent status updates
general context
```

### Heavy Path

Heavy Path is for money, permissions, contract state, trading, copy-trading, prediction markets, and any external side effect.

```text
Intent
-> Proposal
-> SuiPtbAction
-> Inspect
-> Simulate
-> PolicyDecision
-> ActionAnchor
-> ActionClaim
-> ExecutionReceipt
-> AuditEvent
```

Rule:

```text
Chat is light. Money, permissions, contract state, and external side effects are heavy.
```

## 4. Event Envelope

All events move through a JSON envelope so transports and clients can route them consistently.

```json
{
  "protocol": "suimesh",
  "version": "0.1",
  "encoding": "bcs-v1",
  "eventType": "decision.sui_ptb_action.v1",
  "eventId": "evt_...",
  "sessionId": "ses_...",
  "traceId": "tr_...",
  "actor": "agent:demo-agent@0x...",
  "eventHash": "0x...",
  "previousEventHash": "0x...",
  "payload": {
    "bcs": "BASE64URL_BCS_BYTES"
  },
  "signature": "optional_actor_signature"
}
```

Required routing fields:

```text
protocol
version
encoding
eventType
eventId
sessionId
actor
eventHash
payload
```

Heavy events also require:

```text
traceId
previousEventHash, unless it is the first heavy event in a trace
idempotencyKey inside the BCS payload
```

## 5. Event Types

v0.1 defines these event types:

```text
conversation.user_message.v1
conversation.agent_message.v1
context.memory_receipt.v1
decision.intent.v1
decision.proposal.v1
decision.sui_ptb_action.v1
decision.policy_decision.v1
trace.action_anchor.v1
trace.action_claim.v1
outcome.execution_receipt.v1
outcome.audit_event.v1
```

Allowed writers:

| Event Type | Expected Actor |
| --- | --- |
| `conversation.user_message.v1` | `user`, `wallet`, `dapp` |
| `conversation.agent_message.v1` | `agent` |
| `context.memory_receipt.v1` | `memory`, `agent`, `system` |
| `decision.intent.v1` | `user`, `wallet`, `dapp` |
| `decision.proposal.v1` | `agent` |
| `decision.sui_ptb_action.v1` | `agent`, `dapp`, `wallet` |
| `decision.policy_decision.v1` | `policy` |
| `trace.action_anchor.v1` | `system`, `executor`, `wallet`, `dapp` |
| `trace.action_claim.v1` | `executor`, `wallet`, `dapp` |
| `outcome.execution_receipt.v1` | `executor`, `wallet`, `dapp` |
| `outcome.audit_event.v1` | `system`, `executor`, `policy` |

The SDK should reject or flag events written by unexpected actors.

## 6. Encoding Rules

SuiMesh uses JSON + BCS.

```text
Light Path = json-v1
Heavy Path = bcs-v1 inside JSON envelope
```

Principle:

```text
JSON routes the event.
BCS proves the event.
```

For `json-v1`:

```text
JSON is used for light messages and external integration.
High-value actions use BCS heavy events as the security root.
If a light conversation becomes a heavy action, create a new BCS heavy event.
```

For `bcs-v1`:

```text
hash/signature target = BCS bytes
event_hash = blake2b-256(bcs_bytes)
JSON envelope fields must match decoded BCS fields
previous_event_hash links the trace chain
idempotency_key supports deduplication
```

The decoded BCS payload must include:

```text
protocol
version
event_id
session_id
trace_id
event_type
actor_role
actor_id
actor_address
previous_event_hash
idempotency_key
created_at_ms
payload
```

## 7. Canonical Heavy Action

v0.1 defines one canonical Heavy Action format:

```text
action_type = sui.ptb.v1
```

This does not mean SuiMesh only supports one business action. It means all heavy operations normalize to one Sui-native execution format: PTB.

Business meaning is expressed by `semantic_type` and templates:

```text
action_type = sui.ptb.v1
semantic_type = transfer | move_call | swap | copy_trade | prediction_market | unknown
template = transfer | move_call | custom
```

So transfer and contract call are not separate low-level action types. They are templates or semantic labels on top of `sui.ptb.v1`.

```text
SuiPtbAction = PTB bytes + ActionManifest + PolicyRequirements
```

## 8. Action Manifest

Raw PTB bytes are too abstract for users and policies. Every heavy action must include an Action Manifest.

Required fields:

```text
action_id
trace_id
action_type
semantic_type
template
summary
risk_level
value_at_risk
primary_target
objects_touched
policy_requirements
ptb_hash
expires_at
idempotency_key
```

Example:

```json
{
  "actionId": "act_...",
  "traceId": "tr_...",
  "actionType": "sui.ptb.v1",
  "semanticType": "move_call",
  "template": "move_call",
  "summary": "Deposit 10 SUI into escrow",
  "riskLevel": "high",
  "valueAtRisk": {
    "amount": "10",
    "coinType": "SUI"
  },
  "primaryTarget": {
    "packageId": "0x...",
    "module": "escrow",
    "function": "deposit"
  },
  "objectsTouched": ["0x..."],
  "policyRequirements": ["max_value_at_risk", "package_allowlist"],
  "ptbHash": "0x...",
  "expiresAtMs": 4000000000000,
  "idempotencyKey": "idem_..."
}
```

Security rules:

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Manifest must match inspected PTB facts.
Manifest must not omit touched objects.
Manifest must not understate value at risk.
Manifest must not understate risk level.
Unknown contract = high risk by default.
```

## 9. Inspect And Simulate

Before policy approval, the SDK must inspect and simulate the PTB.

```text
PTB bytes
-> PtbInspector
-> ActionManifest validation
-> devInspect / dry-run
-> PolicyFacts
-> PolicyDecision
```

`PtbInspector` extracts:

```text
MoveCall package/module/function
transfer recipient and amount
coin usage
touched objects
touched packages
semantic type
risk level
warnings
```

Implementation rule:

```text
First parse real Sui TransactionKind / TransactionData BCS bytes.
If bytes are not valid Sui PTB bytes, fall back to local inspectable fixtures for unit tests.
If neither parser can understand the bytes, mark the action as opaque/unknown and require policy handling.
```

Current parser coverage:

```text
MoveCall selectors
TransferObjects
SplitCoins -> TransferObjects SUI amount inference
MergeCoins
MakeMoveVec
Publish
Upgrade
pure address arguments
touched object IDs when present in PTB inputs
```

Judgement rule:

```text
Policy approval is allowed only after Manifest facts match parsed PTB facts.
Unknown or opaque PTB bytes cannot silently pass as low risk.
```

Simulation adds:

```text
estimated gas
balance changes
object changes
events
execution error, if any
```

The PTB inspector supports real Sui SDK decoding and deterministic fixtures. Integrations should connect simulation to `devInspect`/dry-run for chain-state facts.

## 10. Policy

Policy is a protocol object, not a UI approve button.

`PolicyDecision` records:

```text
action_hash
policy_hash
policy_version
policy_snapshot_ref
evaluated_facts_hash
decision
reason
decider
created_at
```

Decision values:

```text
approved
rejected
requires_confirmation
```

Built-in v0.1 policy checks:

```text
max_value_at_risk
recipient_allowlist
package_allowlist
function_allowlist
slippage_limit
expiration_check
risk_level_guard
unknown_contract_guard
```

The default policy uses `risk_level_guard` to require confirmation for `high` and `critical`
actions. Domain adapters may add richer semantic facts for apps like exchanges or prediction
markets, but they are optional extensions and not required by SuiMesh core.

Rule:

```text
No successful inspect/simulate, no policy approval.
No approved PolicyDecision, no execution.
```

## 11. Trace State Machine

Heavy Trace states:

```text
proposed
inspected
simulated
policy_approved
policy_rejected
requires_confirmation
anchored
claimed
executed
failed
expired
revoked
```

Execution rules:

```text
No successful inspect/simulate, no policy approval.
No approved PolicyDecision, no execution.
No successful ActionClaim, no execution.
No ExecutionReceipt, no completed trace.
```

On-chain trace guards must treat claim as an authorization lock, not just a marker:

```text
anchor records owner, authorized_executor, action expiry
claim requires sender == authorized_executor
claim records claimant and claim lease expiry
complete/fail requires sender == claimant
expired claim lease can be reclaimed
```

Duplicate handling:

```text
duplicate event = eventId / eventHash / idempotencyKey
duplicate processing = consumer checkpoint
duplicate execution = ActionClaim
```

## 12. Storage And Privacy

Walrus stores encrypted full context:

```text
messages
proposal detail
PTB payload
manifest detail
policy facts
simulation result
execution report
audit detail
memory receipt
```

Sui stores lightweight proof and coordination:

```text
trace_id
proposal_ref/hash
action_ref/hash
decision_ref/hash
receipt_ref/hash
status
claim state
timestamps
```

Seal controls access:

```text
who can read
who can recover
who can rotate access
who is revoked
```

Principle:

```text
Walrus stores the context.
Sui proves the trace.
Seal controls access.
```

## 13. Registry

The action registry maps known package/module/function selectors to protocol meaning.

v0.1 separates:

```text
LocalActionRegistry
OnchainActionRegistry
```

Registry entries describe:

```text
package/module/function selector
semantic_type
protocol_name
risk_category
required_policy_checks
```

The SDK exposes this as `LocalActionRegistry` and `OnchainActionRegistry`.
`DefaultPtbInspector` can use a local registry to enrich known Move calls into
semantic types such as `swap`, `copy_trade`, or `prediction_market`.
Async registries such as `OnchainActionRegistry` are supported through SDK methods
and `inspectAsync(...)`; direct synchronous `inspect(...)` is for local registries.

Unknown selector behavior:

```text
semantic_type = move_call
risk = high
policy = reject or requires_confirmation
```

Opaque PTB bytes that cannot be parsed are treated as `unknown` and high risk.

Policy requirements declared by the manifest or registry must be present in the
evaluated policy. Missing required checks force `requires_confirmation`. If a
`slippage_limit` rule is configured but no slippage facts are available, the
default decision is also `requires_confirmation`.

## 14. Memory Provider

MemWal is a memory provider, not the communication layer.

Supported modes:

```text
memory_provider = memwal | external | none
default = memwal
```

Memory provider behavior:

```text
recall before proposal, if enabled
remember after receipt, if enabled
write MemoryReceipt back into SuiMesh
```

SuiMesh still works if the agent does not use MemWal.

## 15. Adapter Model

SuiMesh should be integrated through adapters:

```text
EventTransport         # delivery adapter, transport-agnostic
SessionDiscovery       # optional authorized session discovery adapter
SessionAccessControl   # optional create/grant/revoke adapter
MemoryAdapter          # memwal | external | none
StorageAdapter         # walrus | local encrypted context refs
ActionRegistry         # local | onchain selector metadata
PtbInspector           # Sui PTB decode and facts
PolicyEngine           # strategy and user policy
TraceGuard             # local | onchain
ActionExecutor         # wallet, dApp, contract adapter
EventCodec             # json-v1 | bcs-v1
```

The Walrus adapter has two levels:

```text
WalrusStorageAdapter   # protocol StorageAdapter wrapper
WalrusHttpClient       # live HTTP publisher/aggregator implementation
```

An agent framework does not need to become SuiMesh-native. Its tool call can be adapted:

```text
agent tool call
-> AgentAdapter
-> SuiPtbAction
-> SuiMesh Heavy Path
```

External IM clients also do not own the state. They are just entry points:

```text
Telegram / Discord / Web / CLI
-> ChannelAdapter
-> SuiMesh Event
-> EventTransport
-> optional encrypted archive recovery
```

## 16. SDK Event Recording

The SDK records heavy trace events back into the transport stream when the
`*AndRecord` helpers are used:

```text
SuiPtbAction
-> PolicyDecision
-> ActionAnchor
-> ActionClaim
-> ExecutionReceipt
```
