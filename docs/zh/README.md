# SuiMesh 中文文档

**Own the Context. Verify the Action.**

SuiMesh v0.1 是 Sui 上的 Agent Action Communication Protocol。它把用户与 Agent 的对话、意图、Sui PTB 行为、策略决策、执行回执和审计链路，变成用户拥有、可恢复、可验证的通信协议状态。

SuiMesh 定义一套可被不同客户端、Agent、钱包、dApp、策略引擎、执行器和记忆系统共同读写、恢复和验证的协议状态。

## 核心定位

```text
SuiMesh is a transport-agnostic communication protocol
for verifiable agent actions and user-owned context.
```

中文：

```text
SuiMesh 是一个 transport-agnostic 的 Agent 通信协议，
用于承载可验证的 Agent 行为和用户拥有的上下文。
```

协议核心定义：

```text
Event
Actor
Session
Trace
Action
PolicyDecision
ActionClaim
ExecutionReceipt
AuditEvent
MemoryReceipt
hash / signature / refs
```

具体消息如何送达、session 如何发现、权限如何 grant/revoke，由 adapter 或 binding 实现。

## 两条路径

Light Path 用于普通对话和上下文：

```text
UserMessage
-> AgentMessage
-> optional MemoryReceipt
```

Heavy Path 用于资金、权限、合约状态、交易、跟单、预测市场和任何外部副作用：

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

规则：

```text
Chat is light.
Money, permissions, contract state, and external side effects are heavy.
```

## 关键设计

v0.1 只有一种底层 Heavy Action：

```text
action_type = sui.ptb.v1
```

这不代表只能做转账。转账、Move call、swap、跟单交易、预测市场等业务动作，都表达为 `sui.ptb.v1` 上的 `semantic_type` 或 template：

```text
semantic_type = transfer | move_call | swap | copy_trade | prediction_market | unknown
template = transfer | move_call | custom
```

安全原则：

```text
Agent summary is untrusted.
PTB bytes are the source of truth.
Manifest must match inspected PTB facts.
Policy approves facts, not prose.
```

## 分层

```text
Application / Agent Framework
-> SuiMesh SDK Core
-> EventTransport binding
-> Storage / Memory / Policy / Trace adapters
-> Sui / Walrus / Seal / external executors
```

| 层 | 职责 |
| --- | --- |
| `protocol` | Event、Actor、Trace、PTB Action、PolicyDecision、Receipt、Audit 类型。 |
| `codec` | JSON envelope、BCS heavy payload、event hash、hash chain 校验。 |
| `transport` | 发送、读取、订阅事件；可选发现已授权 session。 |
| `ptb-inspector` | 解析 Sui PTB bytes，提取客观事实。 |
| `policy-engine` | 用用户或系统策略评估事实。 |
| `trace-guard` | Anchor、Claim、Complete、Fail、防重复执行。 |
| `storage` | 加密上下文归档和可验证 ref/digest。 |
| `memwal-adapter` | 可选 memory provider。 |

## 文档入口

- [使用文档](usage.md)
- [完整链路说明](end-to-end-flow.md)
- [英文协议规范](../protocol.md)
- [英文使用文档](../usage.md)
- [英文端到端链路](../end-to-end-flow.md)
- [Sui Stack Messaging transport binding](../sui-stack-messaging.md)

## 测试网覆盖

可运行的真实 testnet flow：

```text
test:live:messaging        transport send / reconnect / restore / verify
test:live:messaging:remote persistent relayer recovery
test:live:heavy            PTB inspect / policy / on-chain anchor / claim / execute / verify
test:live:walrus           encrypted archive upload / restore / digest verify
test:live:business         full integrated flow
```

`test:live:business` 是集成链路：

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
