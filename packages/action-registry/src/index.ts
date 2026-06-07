import type { PolicyRule, PrimaryTarget, RiskLevel, SemanticType } from "../../protocol/src/index.ts";

export type ActionSelector = `${string}::${string}::${string}`;

export interface ActionRegistryEntry extends PrimaryTarget {
  selector: ActionSelector;
  semanticType: SemanticType;
  protocolName?: string;
  riskCategory: RiskLevel;
  requiredPolicyChecks: PolicyRule["name"][];
}

export interface ActionRegistry {
  resolve(target: PrimaryTarget | ActionSelector): Promise<ActionRegistryEntry | undefined> | ActionRegistryEntry | undefined;
}

export interface OnchainActionRegistryDriver {
  resolve(selector: ActionSelector): Promise<ActionRegistryEntry | undefined>;
}

export class LocalActionRegistry implements ActionRegistry {
  private readonly entries = new Map<ActionSelector, ActionRegistryEntry>();

  constructor(entries: ActionRegistryEntry[] = []) {
    for (const entry of entries) {
      this.register(entry);
    }
  }

  register(entry: ActionRegistryEntry): void {
    this.entries.set(entry.selector, entry);
  }

  resolve(target: PrimaryTarget | ActionSelector): ActionRegistryEntry | undefined {
    return this.entries.get(typeof target === "string" ? target : selectorForTarget(target));
  }

  list(): ActionRegistryEntry[] {
    return Array.from(this.entries.values());
  }
}

export class OnchainActionRegistry implements ActionRegistry {
  constructor(private readonly driver: OnchainActionRegistryDriver) {}

  resolve(target: PrimaryTarget | ActionSelector): Promise<ActionRegistryEntry | undefined> {
    return this.driver.resolve(typeof target === "string" ? target : selectorForTarget(target));
  }
}

export function selectorForTarget(target: PrimaryTarget): ActionSelector {
  return `${target.packageId}::${target.module}::${target.function}`;
}
