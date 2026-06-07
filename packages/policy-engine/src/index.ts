import {
  type Actor,
  type JsonValue,
  type Policy,
  type PolicyDecision,
  type PolicyDecisionValue,
  type PolicyFacts,
  type PolicyRule,
  type PolicySnapshot,
  type RiskLevel
} from "../../protocol/src/index.ts";
import { hashJson } from "../../codec/src/index.ts";

export interface PolicyEngine {
  snapshot(policy: Policy): PolicySnapshot;
  evaluate(input: {
    policy: Policy;
    facts: PolicyFacts;
    decider: Actor;
    nowMs?: number;
    policySnapshotRef?: string;
  }): PolicyDecision;
}

function paramsObject(rule: PolicyRule): Record<string, JsonValue> {
  return typeof rule.params === "object" && rule.params !== null && !Array.isArray(rule.params)
    ? (rule.params as Record<string, JsonValue>)
    : {};
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function ruleMode(rule: PolicyRule): "rejected" | "requires_confirmation" {
  const params = paramsObject(rule);
  return params.mode === "requires_confirmation" ? "requires_confirmation" : "rejected";
}

function worseDecision(left: PolicyDecisionValue, right: PolicyDecisionValue): PolicyDecisionValue {
  if (left === "rejected" || right === "rejected") {
    return "rejected";
  }
  if (left === "requires_confirmation" || right === "requires_confirmation") {
    return "requires_confirmation";
  }
  return "approved";
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
}

function riskRank(risk: RiskLevel): number {
  if (risk === "low") return 1;
  if (risk === "medium") return 2;
  if (risk === "high") return 3;
  return 4;
}

function riskLevel(value: JsonValue | undefined, fallback: RiskLevel): RiskLevel {
  return value === "low" || value === "medium" || value === "high" || value === "critical"
    ? value
    : fallback;
}

export class DefaultPolicyEngine implements PolicyEngine {
  snapshot(policy: Policy): PolicySnapshot {
    return {
      policy,
      policyHash: hashJson(policy as unknown as JsonValue),
      policyVersion: policy.version
    };
  }

  evaluate(input: { policy: Policy; facts: PolicyFacts; decider: Actor; nowMs?: number; policySnapshotRef?: string }): PolicyDecision {
    const nowMs = input.nowMs ?? Date.now();
    const snapshot = this.snapshot(input.policy);
    let decision: PolicyDecisionValue = "approved";
    const reasons: string[] = [];
    const configuredRuleNames = new Set(input.policy.rules.map((rule) => rule.name));
    const missingRequiredChecks = input.facts.policyRequirements.filter((name) => !configuredRuleNames.has(name as PolicyRule["name"]));

    for (const rule of input.policy.rules) {
      const params = paramsObject(rule);
      if (rule.name === "max_value_at_risk" && input.facts.valueAtRisk) {
        const maxAmount = typeof params.maxAmount === "string" ? params.maxAmount : undefined;
        const coinType = typeof params.coinType === "string" ? params.coinType : undefined;
        if (maxAmount && (!coinType || coinType === input.facts.valueAtRisk.coinType)) {
          try {
            if (compareIntegerStrings(input.facts.valueAtRisk.amount, maxAmount) > 0) {
              decision = "rejected";
              reasons.push(`value_at_risk ${input.facts.valueAtRisk.amount} exceeds ${maxAmount}`);
            }
          } catch {
            decision = "requires_confirmation";
            reasons.push("value_at_risk is not an integer amount");
          }
        }
      }

      if (rule.name === "recipient_allowlist") {
        const recipients = stringArray(params.recipients);
        const blocked = input.facts.transfers.filter((transfer) => !recipients.includes(transfer.recipient));
        if (blocked.length > 0) {
          decision = "rejected";
          reasons.push(`recipient not allowed: ${blocked.map((entry) => entry.recipient).join(", ")}`);
        }
      }

      if (rule.name === "package_allowlist") {
        const packages = stringArray(params.packages);
        const blocked = input.facts.packagesTouched.filter((packageId) => !packages.includes(packageId));
        if (blocked.length > 0) {
          decision = "rejected";
          reasons.push(`package not allowed: ${blocked.join(", ")}`);
        }
      }

      if (rule.name === "function_allowlist") {
        const selectors = stringArray(params.selectors);
        const blocked = input.facts.moveCalls.filter((call) => !selectors.includes(call.selector));
        if (blocked.length > 0) {
          decision = "rejected";
          reasons.push(`function not allowed: ${blocked.map((call) => call.selector).join(", ")}`);
        }
      }

      if (rule.name === "expiration_check") {
        const expiresAtMs = typeof params.expiresAtMs === "number" ? params.expiresAtMs : input.facts.expiresAtMs;
        if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
          decision = "rejected";
          reasons.push("action is expired");
        }
      }

      if (rule.name === "risk_level_guard") {
        const minRisk = riskLevel(params.minRisk, "high");
        if (riskRank(input.facts.riskLevel) >= riskRank(minRisk)) {
          const mode = ruleMode(rule);
          decision = worseDecision(decision, mode);
          reasons.push(
            mode === "rejected"
              ? `risk level ${input.facts.riskLevel} rejected`
              : `risk level ${input.facts.riskLevel} requires confirmation`
          );
        }
      }

      if (rule.name === "unknown_contract_guard" && input.facts.semanticType === "unknown") {
        const mode = ruleMode(rule);
        decision = worseDecision(decision, mode);
        reasons.push(mode === "rejected" ? "unknown contract rejected" : "unknown contract requires confirmation");
      }

      if (rule.name === "slippage_limit") {
        const maxBps = typeof params.maxBps === "number" ? params.maxBps : undefined;
        const simulation = input.facts.simulation as unknown as Record<string, JsonValue> | undefined;
        const actualBps = typeof simulation?.slippageBps === "number"
          ? (simulation.slippageBps as number)
          : undefined;
        if (maxBps !== undefined) {
          if (actualBps === undefined) {
            const mode = params.mode === "rejected" ? "rejected" : "requires_confirmation";
            decision = worseDecision(decision, mode);
            reasons.push(
              mode === "rejected"
                ? "slippage facts missing"
                : "slippage facts missing; confirmation required"
            );
          } else if (actualBps > maxBps) {
            decision = "rejected";
            reasons.push(`slippage ${actualBps} exceeds ${maxBps}`);
          }
        }
      }
    }

    if (missingRequiredChecks.length > 0) {
      decision = worseDecision(decision, "requires_confirmation");
      reasons.push(`missing required policy checks: ${missingRequiredChecks.join(", ")}`);
    }

    if (input.facts.simulation && !input.facts.simulation.ok) {
      decision = "rejected";
      reasons.push(input.facts.simulation.error ?? "simulation failed");
    }

    return {
      actionHash: input.facts.actionHash,
      policyHash: snapshot.policyHash,
      policyVersion: snapshot.policyVersion,
      policySnapshotRef: input.policySnapshotRef,
      evaluatedFactsHash: hashJson(input.facts as unknown as JsonValue),
      decision,
      reason: reasons.length > 0 ? reasons.join("; ") : "policy approved",
      decider: input.decider,
      createdAtMs: nowMs
    };
  }
}

export interface CreateDefaultPolicyOverrides extends Partial<Omit<Policy, "rules">> {
  rules?: PolicyRule[];
  extraRules?: PolicyRule[];
  replaceRules?: boolean;
}

const DEFAULT_POLICY_RULES: PolicyRule[] = [
  { name: "expiration_check", params: {} },
  { name: "risk_level_guard", params: { minRisk: "high", mode: "requires_confirmation" } },
  { name: "unknown_contract_guard", params: { mode: "requires_confirmation" } }
];

export function createDefaultPolicy(overrides: CreateDefaultPolicyOverrides = {}): Policy {
  const { rules, extraRules, replaceRules, ...policyOverrides } = overrides;
  return {
    id: "default-policy",
    version: "0.1",
    ...policyOverrides,
    rules: replaceRules
      ? (rules ?? [...DEFAULT_POLICY_RULES])
      : [...DEFAULT_POLICY_RULES, ...(rules ?? []), ...(extraRules ?? [])]
  };
}
