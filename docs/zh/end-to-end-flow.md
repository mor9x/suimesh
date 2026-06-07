# SuiMesh 完整链路

这份文档说明 SuiMesh v0.1 如何从 session 接入，一直走到 Agent 行为执行、审计归档、恢复验证。

SuiMesh 是 transport-agnostic protocol。协议核心定义事件语义、编码、hash、trace 状态、策略决策、执行回执和审计记录；具体事件怎么送达，由 transport binding 决定。

## 分层边界

```text
Application / Agent Framework
-> SuiMesh SDK Core
-> EventTransport binding
-> Storage / Memory / Policy / Trace adapters
-> Sui / Walrus / Seal / external executors
```

分层设计让 SuiMesh core 的语义独立于具体 transport、memory provider 或 wallet integration。

| 层 | 职责 |
| --- | --- |
| `protocol` | Event schema、actor、trace、PTB action、policy decision、receipt、audit record。 |
| `codec` | JSON envelope、BCS heavy payload、event hash、hash chain 校验。 |
| `transport` | 发送、读取、订阅事件；可选发现已授权 session。 |
| `ptb-inspector` | 解码 Sui PTB bytes，并提取客观事实。 |
| `policy-engine` | 用用户或系统策略评估 inspect/simulate 后的事实。 |
| `trace-guard` | Anchor、claim、complete、fail，并防止重复执行。 |
| `storage` | 存储加密上下文 archive，并返回可验证 refs/digests。 |
| `memwal-adapter` | 可选 memory provider，只负责 recall/remember 结果接入。 |

## 完整链路

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

## 谁写入哪个事件

每个 actor 或 adapter 只写入自己负责的那一步。

| 步骤 | 事件 | 典型写入者 |
| --- | --- | --- |
| 用户消息 | `conversation.user_message.v1` | Client、dApp、bridge 或 user-side gateway。 |
| Agent 消息 | `conversation.agent_message.v1` | Agent adapter 或 agent framework integration。 |
| 记忆回执 | `context.memory_receipt.v1` | MemWal、external memory 或 none provider。 |
| 行为提案 | `decision.proposal.v1` | Agent、dApp 或 workflow coordinator。 |
| Sui PTB 行为 | `decision.sui_ptb_action.v1` | Agent、dApp、transaction builder 或 action template helper。 |
| 策略决策 | `decision.policy_decision.v1` | Policy engine、用户策略服务、钱包策略或确认流程。 |
| 行为锚定 | `trace.action_anchor.v1` | Action approved 后的 trace guard。 |
| 行为占用 | `trace.action_claim.v1` | Executor 在执行前通过 trace guard claim。 |
| 执行回执 | `outcome.execution_receipt.v1` | Executor、wallet、dApp 或 contract adapter。 |
| 审计事件 | `outcome.audit_event.v1` | SDK、storage adapter、executor 或 audit coordinator。 |

Transport binding 负责传递事件，协议语义由 SuiMesh core 定义。

## 0. Session Access

应用决定一个 actor 如何获得某个 session 的访问权。

例子：

```text
owner creates a session
owner grants an agent access
dApp workflow grants a wallet or executor access
transport binding discovers authorized sessions
```

在 SuiMesh core 里，这属于 adapter 关心的问题：

```text
SessionDiscoveryAdapter
SessionAccessController
EventTransport
```

Session 邀请和成员关系由所选 access adapter 实现。Sui Stack Messaging binding 可以使用 Sui Groups membership events；Telegram bridge 可以使用群成员关系；其他 transport 也可以使用自己的访问模型。

## 1. Light Context

Light Path 用于普通对话和上下文：

```text
conversation.user_message.v1
conversation.agent_message.v1
context.memory_receipt.v1
```

这些事件是 JSON 事件，不作为高价值行动的安全根。

适合 Light Path 的内容：

```text
chat
agent explanations
status updates
memory recall/remember receipts
non-financial context
```

如果对话引出了资金、权限、合约状态、交易、预测市场或任何外部副作用，就必须进入 Heavy Path。

## 2. Heavy Boundary

规则：

```text
Chat is light. Money, permissions, contract state, and external side effects are heavy.
```

Heavy Path 会创建 trace：

```text
trace_id
previous_event_hash
idempotency_key
BCS payload hash
```

这样普通聊天和可验证行动状态被明确分开。

## 3. Proposal And SuiPtbAction

Agent 或 dApp 提出一个具体行动：

```text
decision.proposal.v1
decision.sui_ptb_action.v1
```

v0.1 只有一种底层 Heavy Action：

```text
action_type = sui.ptb.v1
```

业务语义在 PTB 之上表达：

```text
semantic_type = transfer | move_call | swap | copy_trade | prediction_market | unknown
template = transfer | move_call | custom
```

每个 `sui.ptb.v1` action 必须包含：

```text
PTB bytes
ActionManifest
PolicyRequirements
```

安全规则：

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Manifest must match inspected PTB facts.
```

## 4. Inspect And Simulate

Policy approval 之前必须先做：

```text
PTB bytes
-> PtbInspector
-> Manifest validation
-> devInspect / dry-run
-> PolicyFacts
```

Inspector 提取：

```text
MoveCall package/module/function
transfer recipient and amount
coin usage
touched objects
touched packages
risk hints
warnings
```

Simulation 补充：

```text
estimated gas
balance changes
object changes
events
execution errors
```

如果 manifest 对金额、目标、触碰对象或合约风险描述不一致，action 不能进入正常 approve。

## 5. PolicyDecision

Policy 是协议对象，用于记录策略评估结果。

```text
decision.policy_decision.v1
```

PolicyDecision 记录：

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

决策结果：

```text
approved
rejected
requires_confirmation
```

v0.1 内置检查：

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

默认情况下，high-risk 和 critical action 需要确认。没有 domain adapter 时，复杂合约调用只会被视为
high-risk MoveCall，并提供 package/function facts，不会被解释成某个 dApp 的完整业务语义。

## 6. ActionAnchor And ActionClaim

Policy approved 后，trace guard 负责协调执行：

```text
trace.action_anchor.v1
trace.action_claim.v1
```

`ActionAnchor` 记录轻量 trace proof、授权 executor、过期时间和状态。`ActionClaim`
是执行锁，用来防止重复执行，并把 complete/fail 绑定到 claimant。

规则：

```text
No approved PolicyDecision, no execution.
No successful ActionClaim, no execution.
Duplicate event handling is not enough for money.
Duplicate execution must be blocked by ActionClaim.
Only the authorized executor can claim.
Only the claimant can complete or fail the action.
```

Trace guard 可以是测试用的 local guard，也可以是可验证协调用的 on-chain guard。

## 7. ExecutionReceipt

Executor、wallet、dApp 或 contract adapter 执行已批准的 action，并写入结果：

```text
outcome.execution_receipt.v1
```

Receipt 包含：

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

没有 receipt，就没有 completed trace。

## 8. AuditEvent And Encrypted Archive

最终 audit event 把 trace 链接到完整上下文：

```text
outcome.audit_event.v1
```

完整细节可以加密归档：

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

默认隐私边界：

```text
Walrus stores encrypted context.
Sui proves the trace.
Seal controls access.
```

Sui 只应该存轻量 refs、hash、status、timestamp 和 claim state。Walrus 存加密细节。Seal 或用户选择的访问控制 adapter 决定谁能解密和恢复 archive。

## 9. Restore And Verify

另一个客户端或 Agent 可以恢复同一份状态：

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

这证明 SuiMesh 的核心价值：

```text
The interaction is not locked inside one app, bot backend, wallet, or agent framework.
It is recoverable and verifiable communication state owned by the user or session.
```

## Testnet Coverage

可运行的真实 testnet flow：

```text
test:live:messaging        transport send / reconnect / restore / verify
test:live:messaging:remote persistent relayer recovery
test:live:heavy            PTB inspect / policy / on-chain anchor / claim / execute / verify
test:live:walrus           encrypted archive upload / restore / digest verify
test:live:business         full integrated flow
```

`test:live:business` 跑通集成端到端链路：

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
