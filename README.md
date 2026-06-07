# SuiMesh

**Own the Context. Verify the Action.**

SuiMesh v0.1 is an Agent Action Communication Protocol on Sui. It turns agent conversations, intents, Sui PTB actions, policy decisions, execution receipts, and audit trails into user-owned, recoverable, and verifiable communication state.

SuiMesh provides protocol schemas, codecs, SDK adapters, PTB inspection, policy evaluation, trace coordination, storage hooks, and examples for building verifiable agent communication flows.

## Paths

Light Path is for ordinary conversation and context messages:

```text
UserMessage -> AgentMessage -> optional MemoryReceipt
```

Heavy Path is for money, permissions, contract state, trading, copy-trading, prediction markets, and other external side effects:

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

## Canonical Heavy Action

v0.1 has one canonical Heavy Action format:

```text
action_type = sui.ptb.v1
```

Transfer, Move call, swap, copy trading, and prediction-market actions are represented as `semantic_type` or templates on top of `sui.ptb.v1`, not as separate low-level action formats.

```text
SuiPtbAction = PTB bytes + ActionManifest + PolicyRequirements
```

The Agent summary is untrusted. PTB bytes are the source of truth. The SDK inspector must verify that the Manifest matches inspected PTB facts before policy approval.

## Encoding

SuiMesh uses JSON + BCS:

```text
Light Path = json-v1
Heavy Path = bcs-v1 inside JSON envelope
```

JSON routes the event. BCS proves the event. For Heavy Path events, the hash and signature target is the BCS byte payload, not the JSON envelope.

## Protocol Documentation

Documentation entry points:

- [Protocol specification](docs/protocol.md)
- [Usage guide](docs/usage.md)
- [End-to-end flow](docs/end-to-end-flow.md)
- [Transport adapter guide](docs/sui-stack-messaging.md)
- [中文文档](docs/zh/README.md)
- [Minimal example](examples/minimal/minimal.ts)

The important protocol rule is:

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Manifest must match inspected PTB facts.
Policy approves facts, not prose.
```

## Packages

```text
packages/protocol          Event, action, policy, receipt, trace types
packages/codec             JSON envelope + BCS event codec + blake2b-256 hashing
packages/action-registry   Local/on-chain action selector registry interfaces
packages/storage           Walrus/local encrypted context storage adapter interfaces
packages/transport         Transport and session discovery adapter interfaces
packages/ptb-inspector     Real Sui PTB inspector plus local inspectable PTB fixtures
packages/policy-engine     Policy engine and built-in v0.1 guards
packages/trace-guard       Local guard, on-chain guard interface, and Sui Move driver
packages/sui-stack-adapter Optional Sui transport binding
packages/memwal-adapter    Memory provider interface: memwal | external | none
packages/sdk               SuiMeshClient facade
contracts/suimesh_trace    Move trace anchor/claim contract
examples/minimal           Minimal protocol example
```

The SDK can record a complete recoverable heavy trace in the transport stream:

```text
SuiPtbAction -> PolicyDecision -> ActionAnchor -> ActionClaim -> ExecutionReceipt
```

The PTB inspector parses real Sui `TransactionKind` / `TransactionData` BCS bytes first, then falls
back to local fixtures for deterministic unit tests. It recognizes transfers, Move calls,
coin splits, coin merges, MakeMoveVec, Publish, and Upgrade commands.

Live testnet flows are available through:

```bash
bun run test:live:messaging
bun run test:live:messaging:remote
bun run test:live:agent-proposal
bun run test:live:heavy
bun run test:live:walrus
bun run test:live:business
bun run test:live:full-regression
```

`test:live:messaging:remote` requires `SUIMESH_RELAYER_URL` and verifies that a transport adapter can
reconnect to the same persistent relayer and recover the sent SuiMesh event. `test:live:agent-proposal`
uses OpenAI as an agent to turn a user message into a `sui.ptb.v1` proposal event. `test:live:walrus`
uploads a small encrypted SuiMesh archive through a Walrus publisher, reads it back through an
aggregator, and verifies the archive digest. `test:live:business` runs the integrated testnet flow
through a real transport binding: session creation, SuiMesh event delivery, PTB devInspect, policy
approval, on-chain anchor/claim, execution receipt, Seal-managed encrypted Walrus audit archive,
reconnect, archive decrypt through the group policy, and hash-chain verification.
`test:live:full-regression` runs typecheck, unit tests, remote messaging, agent proposal verification,
heavy action execution, Walrus archive, and the integrated business flow as one regression suite.

## Development

```bash
bun install
bun run check:strict
bun run test:move
bun run audit:deps
bun run example:minimal
```
