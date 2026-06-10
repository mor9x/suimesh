import {
  PolicyDecisionValues,
  PolicyRuleNames,
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
  return params.mode === PolicyDecisionValues.RequiresConfirmation
    ? PolicyDecisionValues.RequiresConfirmation
    : PolicyDecisionValues.Rejected;
}

function worseDecision(left: PolicyDecisionValue, right: PolicyDecisionValue): PolicyDecisionValue {
  if (left === PolicyDecisionValues.Rejected || right === PolicyDecisionValues.Rejected) {
    return PolicyDecisionValues.Rejected;
  }
  if (left === PolicyDecisionValues.RequiresConfirmation || right === PolicyDecisionValues.RequiresConfirmation) {
    return PolicyDecisionValues.RequiresConfirmation;
  }
  return PolicyDecisionValues.Approved;
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
    let decision: PolicyDecisionValue = PolicyDecisionValues.Approved;
    const reasons: string[] = [];
    const configuredRuleNames = new Set(input.policy.rules.map((rule) => rule.name));
    const missingRequiredChecks = input.facts.policyRequirements.filter((name) => !configuredRuleNames.has(name as PolicyRule["name"]));

    for (const rule of input.policy.rules) {
      const params = paramsObject(rule);
      if (rule.name === PolicyRuleNames.MaxValueAtRisk && input.facts.valueAtRisk) {
        const maxAmount = typeof params.maxAmount === "string" ? params.maxAmount : undefined;
        const coinType = typeof params.coinType === "string" ? params.coinType : undefined;
        if (maxAmount && (!coinType || coinType === input.facts.valueAtRisk.coinType)) {
          try {
            if (compareIntegerStrings(input.facts.valueAtRisk.amount, maxAmount) > 0) {
              decision = PolicyDecisionValues.Rejected;
              reasons.push(`value_at_risk ${input.facts.valueAtRisk.amount} exceeds ${maxAmount}`);
            }
          } catch {
            decision = PolicyDecisionValues.RequiresConfirmation;
            reasons.push("value_at_risk is not an integer amount");
          }
        }
      }

      if (rule.name === PolicyRuleNames.RecipientAllowlist) {
        const recipients = stringArray(params.recipients);
        const blocked = input.facts.transfers.filter((transfer) => !recipients.includes(transfer.recipient));
        if (blocked.length > 0) {
          decision = PolicyDecisionValues.Rejected;
          reasons.push(`recipient not allowed: ${blocked.map((entry) => entry.recipient).join(", ")}`);
        }
      }

      if (rule.name === PolicyRuleNames.PackageAllowlist) {
        const packages = stringArray(params.packages);
        const blocked = input.facts.packagesTouched.filter((packageId) => !packages.includes(packageId));
        if (blocked.length > 0) {
          decision = PolicyDecisionValues.Rejected;
          reasons.push(`package not allowed: ${blocked.join(", ")}`);
        }
      }

      if (rule.name === PolicyRuleNames.FunctionAllowlist) {
        const selectors = stringArray(params.selectors);
        const blocked = input.facts.moveCalls.filter((call) => !selectors.includes(call.selector));
        if (blocked.length > 0) {
          decision = PolicyDecisionValues.Rejected;
          reasons.push(`function not allowed: ${blocked.map((call) => call.selector).join(", ")}`);
        }
      }

      if (rule.name === PolicyRuleNames.ExpirationCheck) {
        const expiresAtMs = typeof params.expiresAtMs === "number" ? params.expiresAtMs : input.facts.expiresAtMs;
        if (expiresAtMs !== undefined && expiresAtMs <= nowMs) {
          decision = PolicyDecisionValues.Rejected;
          reasons.push("action is expired");
        }
      }

      if (rule.name === PolicyRuleNames.RiskLevelGuard) {
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

      if (rule.name === PolicyRuleNames.UnknownContractGuard && input.facts.semanticType === "unknown") {
        const mode = ruleMode(rule);
        decision = worseDecision(decision, mode);
        reasons.push(mode === "rejected" ? "unknown contract rejected" : "unknown contract requires confirmation");
      }

      if (rule.name === PolicyRuleNames.SlippageLimit) {
        const maxBps = typeof params.maxBps === "number" ? params.maxBps : undefined;
        const simulation = input.facts.simulation as unknown as Record<string, JsonValue> | undefined;
        const actualBps = typeof simulation?.slippageBps === "number"
          ? (simulation.slippageBps as number)
          : undefined;
        if (maxBps !== undefined) {
          if (actualBps === undefined) {
            const mode = params.mode === PolicyDecisionValues.Rejected
              ? PolicyDecisionValues.Rejected
              : PolicyDecisionValues.RequiresConfirmation;
            decision = worseDecision(decision, mode);
            reasons.push(
              mode === "rejected"
                ? "slippage facts missing"
                : "slippage facts missing; confirmation required"
            );
          } else if (actualBps > maxBps) {
            decision = PolicyDecisionValues.Rejected;
            reasons.push(`slippage ${actualBps} exceeds ${maxBps}`);
          }
        }
      }
    }

    if (missingRequiredChecks.length > 0) {
      decision = worseDecision(decision, PolicyDecisionValues.RequiresConfirmation);
      reasons.push(`missing required policy checks: ${missingRequiredChecks.join(", ")}`);
    }

    if (input.facts.simulation && !input.facts.simulation.ok) {
      decision = PolicyDecisionValues.Rejected;
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
  { name: PolicyRuleNames.ExpirationCheck, params: {} },
  { name: PolicyRuleNames.RiskLevelGuard, params: { minRisk: "high", mode: PolicyDecisionValues.RequiresConfirmation } },
  { name: PolicyRuleNames.UnknownContractGuard, params: { mode: PolicyDecisionValues.RequiresConfirmation } }
];

export const policyRules = {
  maxValueAtRisk: (input: { maxAmount: string; coinType?: string }): PolicyRule => ({
    name: PolicyRuleNames.MaxValueAtRisk,
    params: input.coinType ? { maxAmount: input.maxAmount, coinType: input.coinType } : { maxAmount: input.maxAmount }
  }),
  recipientAllowlist: (recipients: string[]): PolicyRule => ({
    name: PolicyRuleNames.RecipientAllowlist,
    params: { recipients }
  }),
  packageAllowlist: (packages: string[]): PolicyRule => ({
    name: PolicyRuleNames.PackageAllowlist,
    params: { packages }
  }),
  functionAllowlist: (selectors: string[]): PolicyRule => ({
    name: PolicyRuleNames.FunctionAllowlist,
    params: { selectors }
  }),
  slippageLimit: (input: { maxBps: number; mode?: Exclude<PolicyDecisionValue, "approved"> }): PolicyRule => ({
    name: PolicyRuleNames.SlippageLimit,
    params: { maxBps: input.maxBps, mode: input.mode ?? PolicyDecisionValues.RequiresConfirmation }
  }),
  expirationCheck: (expiresAtMs?: number): PolicyRule => ({
    name: PolicyRuleNames.ExpirationCheck,
    params: expiresAtMs === undefined ? {} : { expiresAtMs }
  }),
  riskLevelGuard: (input: { minRisk?: RiskLevel; mode?: Exclude<PolicyDecisionValue, "approved"> } = {}): PolicyRule => ({
    name: PolicyRuleNames.RiskLevelGuard,
    params: {
      minRisk: input.minRisk ?? "high",
      mode: input.mode ?? PolicyDecisionValues.RequiresConfirmation
    }
  }),
  unknownContractGuard: (mode: Exclude<PolicyDecisionValue, "approved"> = PolicyDecisionValues.RequiresConfirmation): PolicyRule => ({
    name: PolicyRuleNames.UnknownContractGuard,
    params: { mode }
  })
} as const;

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
