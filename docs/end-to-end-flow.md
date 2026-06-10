# SuiMesh End-to-End Flow

This document explains the full SuiMesh v0.1 chain from session access to action execution and audit recovery.

SuiMesh is transport-agnostic. The protocol defines event semantics, encoding, verification, trace state, policy decisions, execution receipts, and audit records. A transport binding decides how events are delivered.

## Layer Boundaries

```text
Application / Agent Framework
-> SuiMesh SDK Core
-> EventTransport binding
-> Storage / Memory / Policy / Trace adapters
-> Sui / Walrus / Seal / external executors
```

Layering keeps SuiMesh core semantics independent from any specific transport, memory provider, or wallet integration.

| Layer | Responsibility |
| --- | --- |
| `protocol` | Event schema, actors, traces, PTB actions, policy decisions, receipts, audit records. |
| `codec` | JSON envelopes, BCS heavy payloads, event hashes, hash-chain validation. |
| `transport` | Send/list/subscribe events and optionally discover authorized sessions. |
| `ptb-inspector` | Decode Sui PTB bytes and extract objective facts. |
| `policy-engine` | Evaluate user or system policy against inspected and simulated facts. |
| `trace-guard` | Anchor, claim, complete, fail, and prevent duplicate execution. |
| `storage` | Store encrypted context archives and return verifiable refs/digests. |
| `memwal-adapter` | Optional memory recall/remember provider. |

## The Full Chain

```text
0. Session access
1. Light context
2. Heavy boundary
3. Proposal + SuiPtbAction
4. Inspect + simulate
5. PolicyDecision
6. ActionAnchor + ActionClaim
7. ExecutionReceipt
8. AuditEvent + encrypted archive
9. Restore + verify
```

## Who Writes What

Each actor or adapter writes the event for the step it owns.

| Step | Event | Typical writer |
| --- | --- | --- |
| User message | `conversation.user_message.v1` | Client, dApp, bridge, or user-side gateway. |
| Agent message | `conversation.agent_message.v1` | Agent adapter or agent framework integration. |
| Memory receipt | `context.memory_receipt.v1` | Memory adapter such as MemWal, external memory, or no-op provider. |
| Proposal | `decision.proposal.v1` | Agent, dApp, or workflow coordinator. |
| Sui PTB action | `decision.sui_ptb_action.v1` | Agent, dApp, transaction builder, or action template helper. |
| Policy decision | `decision.policy_decision.v1` | Policy engine, user policy service, wallet policy, or confirmation flow. |
| Action anchor | `trace.action_anchor.v1` | Trace guard after the action is approved. |
| Action claim | `trace.action_claim.v1` | Executor through the trace guard before execution. |
| Execution receipt | `outcome.execution_receipt.v1` | Executor, wallet, dApp, or contract adapter. |
| Audit event | `outcome.audit_event.v1` | SDK, storage adapter, executor, or audit coordinator. |

The transport binding delivers events while protocol semantics remain defined by SuiMesh core.

## 0. Session Access

The application decides how an actor becomes authorized to a session.

Examples:

```text
owner creates a session
owner grants an agent access
dApp workflow grants a wallet or executor access
transport binding discovers authorized sessions
```

In SuiMesh core, this is only an adapter concern:

```text
SessionDiscoveryAdapter
SessionAccessController
EventTransport
```

Session invitation and membership are implemented by the chosen access adapter. A Sui Stack Messaging binding may use Sui Groups membership events. A Telegram bridge may use chat membership. Another transport may use its own access model.

## 1. Light Context

Light Path is for normal conversation and context:

```text
conversation.user_message.v1
conversation.agent_message.v1
context.memory_receipt.v1
```

These are JSON events. High-value actions use BCS heavy events as the security root.

Use this path for:

```text
chat
agent explanations
status updates
memory recall/remember receipts
non-financial context
```

If the conversation leads to money, permissions, contract state, trading, prediction markets, or any external side effect, the flow must move to Heavy Path.

## 2. Heavy Boundary

Rule:

```text
Chat is light. Money, permissions, contract state, and external side effects are heavy.
```

Heavy Path creates a trace:

```text
trace_id
previous_event_hash
idempotency_key
BCS payload hash
```

This separates casual conversation from verifiable action state.

## 3. Proposal And SuiPtbAction

An agent or dApp proposes a concrete action:

```text
decision.proposal.v1
decision.sui_ptb_action.v1
```

v0.1 has one low-level heavy action type:

```text
action_type = sui.ptb.v1
```

Business meaning is expressed above PTB:

```text
semantic_type = transfer | move_call | swap | copy_trade | prediction_market | unknown
template = transfer | move_call | custom
```

Every `sui.ptb.v1` action must include:

```text
PTB bytes
ActionManifest
PolicyRequirements
```

Key security rule:

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Manifest must match inspected PTB facts.
```

## 4. Inspect And Simulate

Before policy approval:

```text
PTB bytes
-> PtbInspector
-> Manifest validation
-> devInspect / dry-run
-> PolicyFacts
```

The inspector extracts:

```text
MoveCall package/module/function
transfer recipient and amount
coin usage
touched objects
touched packages
risk hints
warnings
```

Simulation adds:

```text
estimated gas
balance changes
object changes
events
execution errors
```

If the manifest lies about value, target, touched objects, or contract risk, the action cannot proceed to normal approval.

## 5. PolicyDecision

Policy is a protocol object, not a manual approve button.

```text
decision.policy_decision.v1
```

The decision records:

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

v0.1 built-in checks:

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

By default, high-risk and critical actions require confirmation. Without a domain adapter, a complex
contract call remains a high-risk MoveCall with package/function facts rather than an app-specific
business interpretation.

## 6. ActionAnchor And ActionClaim

After approval, the trace guard coordinates execution:

```text
trace.action_anchor.v1
trace.action_claim.v1
```

`ActionAnchor` records a lightweight trace proof, authorized executor, expiry, and status.
`ActionClaim` is the execution lock that prevents duplicate execution and binds completion to the
claimant.

Rules:

```text
No approved PolicyDecision, no execution.
No successful ActionClaim, no execution.
PolicyDecision, ActionClaim, and ExecutionReceipt must reference the same action hash.
Duplicate event handling is not enough for money.
Duplicate execution must be blocked by ActionClaim.
Only the authorized executor can claim.
Only the claimant can complete or fail the action.
```

The trace guard can be local for tests or on-chain for verifiable coordination. The Sui Move driver
restores anchor, claim, and completion state from emitted Move events.

## 7. ExecutionReceipt

The executor, wallet, dApp, or contract adapter performs the approved action and records the result:

```text
outcome.execution_receipt.v1
```

The receipt contains:

```text
action_hash
claim_id
executor
status
tx_digest
effects_hash
error
created_at
```

No receipt means no completed trace.

## 8. AuditEvent And Encrypted Archive

The final audit event links the trace to detailed context:

```text
outcome.audit_event.v1
```

Full details can be encrypted and archived:

```text
messages
proposal detail
PTB payload
manifest detail
policy facts
simulation result
execution report
audit detail
memory receipts
```

Default privacy boundary:

```text
Walrus stores encrypted context.
Sui proves the trace.
Seal controls access.
```

Sui should store only lightweight refs, hashes, statuses, timestamps, and claim state. Walrus stores encrypted detail. Seal or the chosen access adapter controls who can decrypt and recover the archive.

## 9. Restore And Verify

A different client or agent can restore the same state:

```text
EventTransport.list(session_id)
-> decode all events
-> validate BCS heavy payload hashes
-> verify JSON envelope fields match decoded BCS fields
-> verify previous_event_hash chain
-> fetch encrypted archive refs if available
-> verify Walrus digest
-> decrypt archive if access is allowed
```

This proves the main product claim:

```text
The interaction is not locked inside one app, bot backend, wallet, or agent framework.
It is recoverable and verifiable communication state owned by the user or session.
```

## Testnet Coverage

Available live testnet flows:

```text
test:live:messaging        transport send / reconnect / restore / verify
test:live:messaging:remote persistent relayer recovery
test:live:heavy            PTB inspect / policy / on-chain anchor / claim / execute / verify
test:live:walrus           encrypted archive upload / restore / digest verify
test:live:business         full integrated flow
```

`test:live:business` runs the integrated end-to-end path:

```text
session creation
event delivery through a real transport binding
Sui PTB devInspect
policy approval
on-chain ActionAnchor
on-chain ActionClaim
1 MIST execution
on-chain complete
Seal-managed encrypted Walrus audit archive
fresh client reconnect
event hash-chain verification
archive digest verification
archive decrypt through access policy
```
