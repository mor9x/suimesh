# SuiMesh 使用文档

这份文档说明如何使用 SuiMesh v0.1 SDK。

应用可以先用默认 in-memory adapter 测协议行为，也可以接入真实 transport、memory、storage、policy、trace adapter 跑 live flow。

## 安装和运行

在项目根目录执行：

```bash
bun install
bun run typecheck
bun test
bun run example:minimal
```

直接使用源码时，可以从 `src/index.ts` 引入：

```ts
import { createSuiMeshClient } from "./src/index.ts";
```

## 创建 Client

默认 client 使用本地 in-memory adapters，适合快速测试协议行为。

```ts
import { createSuiMeshClient } from "./src/index.ts";

const client = createSuiMeshClient();
```

真实环境或 live test 建议显式传入 adapter：

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

各 adapter 的职责：

| Adapter | 作用 |
| --- | --- |
| `transport` | 发送、读取、订阅 SuiMesh events。 |
| `storage` | 存储加密上下文 archive，并返回 refs/digests。 |
| `memory` | 记录 memory recall/remember receipts。 |
| `inspector` | 把 Sui PTB bytes 解析成客观事实。 |
| `simulator` | 补充 dry-run/devInspect facts。 |
| `policyEngine` | 用策略评估 facts。 |
| `traceGuard` | Anchor、claim、complete，并阻止重复执行。 |

## 发送 Light Context

普通对话和上下文走 Light Path。

```ts
const user = { role: "user" as const, id: "alice", address: "0xalice" };

const light = await client.light.sendMessage({
  sessionId: "ses_demo",
  actor: user,
  content: "Prepare a small SUI transfer to Bob.",
});
```

Light event 适合聊天、解释、状态更新和 memory receipt。高价值行动以 Heavy Path 的 BCS payload 作为安全根。

## 提出 Heavy PTB Action

资金、权限、合约状态、交易、预测市场和任何外部副作用都走 Heavy Path。

v0.1 只有一种底层 Heavy Action：

```text
action_type = sui.ptb.v1
```

本地确定性测试可以用 `encodeInspectablePtb(...)`。真实链路里传入真实 Sui `TransactionKind` 或 `TransactionData` BCS bytes。

```ts
import {
  createSuiMeshClient,
  encodeInspectablePtb,
  type ActionManifest,
} from "./src/index.ts";

const client = createSuiMeshClient();
const agent = { role: "agent" as const, id: "agent-1", address: "0xagent" };

const ptbBytes = encodeInspectablePtb([
  {
    kind: "transfer",
    recipient: "0xbob",
    amount: "10",
    coinType: "SUI",
    objectIds: ["0xcoin"],
  },
]);

const manifest: Omit<ActionManifest, "actionType" | "ptbHash"> = {
  actionId: "act_demo",
  traceId: "tr_demo",
  semanticType: "transfer",
  template: "transfer",
  summary: "Send 10 SUI to Bob",
  riskLevel: "medium",
  valueAtRisk: { amount: "10", coinType: "SUI" },
  objectsTouched: ["0xcoin"],
  policyRequirements: ["max_value_at_risk", "recipient_allowlist"],
  expiresAtMs: Date.now() + 60_000,
  idempotencyKey: "idem_demo_transfer",
};

const proposed = await client.actions.proposePtb({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: agent,
  ptbBytes,
  manifest,
  previousEventHash: light.eventHash,
});
```

`proposePtb(...)` 会 inspect PTB，并在 manifest 与 PTB facts 不一致时拒绝 action。

安全规则：

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Policy approves facts, not prose.
```

## Inspect、Simulate 和 Policy

```ts
import { createDefaultPolicy } from "./src/index.ts";

const simulated = await client.actions.simulate(proposed.action);

const decision = client.policy.evaluate({
  policy: createDefaultPolicy({
    rules: [
      { name: "max_value_at_risk", params: { maxAmount: "20", coinType: "SUI" } },
      { name: "recipient_allowlist", params: { recipients: ["0xbob"] } },
      { name: "expiration_check", params: {} },
    ],
  }),
  facts: simulated.facts,
  decider: { role: "policy", id: "default-policy" },
});
```

`createDefaultPolicy({ rules })` 会把传入规则追加到默认 guard 后面，包括 `risk_level_guard`
和 `unknown_contract_guard`。只有明确想替换默认安全 guard 时，才使用 `replaceRules: true`。

如果需要可恢复 trace，使用 `evaluateAndRecord(...)`：

```ts
const recordedDecision = await client.policy.evaluateAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  policy: createDefaultPolicy(),
  facts: simulated.facts,
  decider: { role: "policy", id: "default-policy" },
  previousEventHash: proposed.envelope.eventHash,
});
```

决策结果：

```text
approved
rejected
requires_confirmation
```

## Anchor、Claim、Execute 和 Receipt

涉及资金或合约状态变化的执行，必须由 trace guard 协调。

```ts
const anchor = await client.trace.anchorAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: { role: "system", id: "trace-guard" },
  actionHash: simulated.facts.actionHash,
  decisionHash: recordedDecision.envelope.eventHash,
  authorizedExecutor: "0xexecutor",
  expiresAtMs: manifest.expiresAtMs,
  previousEventHash: recordedDecision.envelope.eventHash,
});

const claim = await client.trace.claimAndRecord({
  sessionId: "ses_demo",
  traceId: "tr_demo",
  actor: { role: "executor", id: "executor-1", address: "0xexecutor" },
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
  executor: { role: "executor", id: "executor-1", address: "0xexecutor" },
  previousEventHash: claim.envelope.eventHash,
  execute: async () => ({
    txDigest: "demo_tx_digest",
    effectsHash: "demo_effects_hash",
  }),
});
```

执行规则：

```text
No approved PolicyDecision, no execution.
No successful ActionClaim, no execution.
No ExecutionReceipt, no completed trace.
```

链上 trace guard 会在 anchor 时记录授权 executor 和 action 过期时间。Claim 和 completion
交易必须由授权 executor / claimant 发起。

真实 Sui 协调使用 `SuiOnchainTraceGuard` 和 `SuiMoveTraceGuardDriver`。本地 trace guard 只适合测试和确定性示例。

## 恢复和验证

任何有 session transport 访问权的 client，都可以恢复和验证 trace。

```ts
const events = await client.trace.restore("ses_demo");
const verification = await client.trace.verify("ses_demo");

console.log({
  events: events.length,
  ok: verification.ok,
  errors: verification.errors,
});
```

验证会检查事件能否 decode，以及 `previousEventHash` 链是否连续。Heavy Path events 的 BCS payload hash 由 event codec 校验。

## 存储上下文 Archive

使用 `storage.put(...)` 存加密上下文 archive。默认 adapter 是本地内存。Walrus 可以用 `WalrusStorageAdapter` 加 `WalrusHttpClient`。

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

除非 adapter 内部负责加密，否则调用方应该先加密敏感内容再存储。

## 使用 Sui Stack Messaging 作为 Transport

Sui Stack Messaging 可以作为可选的 SuiMesh transport binding。

```ts
import { SuiStackEventTransport, createSuiMeshClient } from "./src/index.ts";

const transport = new SuiStackEventTransport({
  client: suiStackClient.messaging,
  signer,
  groupRefForSession: (sessionId) => ({ uuid: sessionId }),
});

const client = createSuiMeshClient({ transport });
```

Group 创建、成员权限、Seal key-server、relayer 配置和轮询式 session discovery，见 [Sui Stack Messaging transport binding](../sui-stack-messaging.md)。

## Live Testnet 命令

Live scripts 会访问真实基础设施、花费 gas，并依赖外部服务。

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

`test:live:agent-proposal` 会创建真实 messaging group，通过 transport 发送用户消息，使用 OpenAI
作为 agent planner，写入 agent reply，写入 `decision.sui_ptb_action.v1` proposal event，恢复事件流并验证 hash chain。
设置 `SUIMESH_OPENAI_MODEL=gpt-5.4-mini` 可以用 GPT-5.4 mini 跑同一条链路。
`test:live:agent-proposal:verify` 会通过 `SUIMESH_GROUP_UUID` 恢复已有 session，并验证事件和 PTB proposal facts。

`test:live:full-regression` 会用一个命令跑完整协议和 live 集成回归：typecheck、unit tests、relayer health、
remote messaging recovery、OpenAI agent proposal 及恢复验证、heavy action 执行、Walrus archive、
以及 integrated business flow。如果没有 `OPENAI_API_KEY`，也可以通过下面的变量验证一条已有 agent proposal：

```bash
SUIMESH_AGENT_VERIFY_GROUP_UUID=...
SUIMESH_AGENT_VERIFY_PROPOSAL_EVENT_HASH=...
SUIMESH_AGENT_VERIFY_ACTION_HASH=...
SUIMESH_AGENT_VERIFY_PTB_HASH=...
```

`test:live:business` 会跑通集成使用示例：

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
