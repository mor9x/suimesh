import {
  SUI_PTB_ACTION_TYPE,
  type ActionManifest,
  type JsonValue,
  type MoveCallFact,
  type PolicyFacts,
  type PrimaryTarget,
  type RiskLevel,
  type SemanticType,
  type SimulationResult,
  type TransferFact,
  type ValueAtRisk
} from "../../protocol/src/index.ts";
import { bytesToBase64Url, base64UrlToBytes, hashBytes, hashJson } from "../../codec/src/index.ts";
import type { ActionRegistry, ActionRegistryEntry } from "../../action-registry/src/index.ts";
import { fromBase64 } from "@mysten/bcs";
import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";

export type NormalizedPtbCommand =
  | {
      kind: "transfer";
      recipient: string;
      amount: string;
      coinType: string;
      objectIds?: string[];
    }
  | {
      kind: "moveCall";
      packageId: string;
      module: string;
      function: string;
      typeArguments?: string[];
      arguments?: JsonValue[];
      objects?: string[];
    }
  | {
      kind: "mergeCoins";
      destinationObjects: string[];
      sourceObjects: string[];
    }
  | {
      kind: "makeMoveVec";
      type?: string;
      objects: string[];
      arguments?: JsonValue[];
    }
  | {
      kind: "publish";
      moduleCount: number;
      dependencyCount: number;
      dependencies: string[];
    }
  | {
      kind: "upgrade";
      packageId: string;
      moduleCount: number;
      dependencyCount: number;
      dependencies: string[];
      ticketObjects: string[];
    }
  | {
      kind: "custom";
      name: string;
      objects?: string[];
      data?: JsonValue;
    };

export interface InspectablePtb {
  format: "suimesh.inspectable-ptb.v1";
  commands: NormalizedPtbCommand[];
}

type SuiTransactionInput = {
  Pure?: { bytes: string };
  Object?: unknown;
  UnresolvedObject?: { objectId?: string };
  $kind?: string;
};

type SuiTransactionArgument =
  | { GasCoin: true; $kind?: string }
  | { Input: number; $kind?: string }
  | { Result: number; $kind?: string }
  | { NestedResult: [number, number]; $kind?: string };

type SuiTransactionCommand = {
  MoveCall?: {
    package: string;
    module: string;
    function: string;
    typeArguments?: string[];
    arguments?: SuiTransactionArgument[];
  };
  TransferObjects?: {
    objects: SuiTransactionArgument[];
    address: SuiTransactionArgument;
  };
  SplitCoins?: {
    coin: SuiTransactionArgument;
    amounts: SuiTransactionArgument[];
  };
  MergeCoins?: {
    destination: SuiTransactionArgument;
    sources: SuiTransactionArgument[];
  };
  Publish?: {
    modules?: string[];
    dependencies?: string[];
  };
  MakeMoveVec?: {
    type?: string | null;
    elements: SuiTransactionArgument[];
  };
  Upgrade?: {
    modules?: string[];
    dependencies?: string[];
    package: string;
    ticket: SuiTransactionArgument;
  };
  $kind?: string;
};

type SuiTransactionSnapshot = {
  inputs: SuiTransactionInput[];
  commands: SuiTransactionCommand[];
};

export interface PtbInspectionResult {
  facts: PolicyFacts;
  commands: NormalizedPtbCommand[];
}

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PtbInspector {
  inspect(ptbBytes: Uint8Array, manifest?: ActionManifest): PtbInspectionResult;
  inspectAsync?(ptbBytes: Uint8Array, manifest?: ActionManifest): Promise<PtbInspectionResult>;
  validateManifest(manifest: ActionManifest, facts: PolicyFacts): ManifestValidationResult;
}

export interface PtbSimulator {
  simulate(input: { ptbBytes: Uint8Array; manifest: ActionManifest; facts: PolicyFacts }): Promise<SimulationResult>;
}

export function encodeInspectablePtb(commands: NormalizedPtbCommand[]): Uint8Array {
  const body: InspectablePtb = {
    format: "suimesh.inspectable-ptb.v1",
    commands
  };
  return new TextEncoder().encode(JSON.stringify(body));
}

export function ptbBytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64Url(bytes);
}

export function ptbBytesFromBase64Url(value: string): Uint8Array {
  return base64UrlToBytes(value);
}

function parseInspectablePtb(ptbBytes: Uint8Array): InspectablePtb | undefined {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(ptbBytes)) as InspectablePtb;
    if (parsed.format === "suimesh.inspectable-ptb.v1" && Array.isArray(parsed.commands)) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parseSuiPtb(ptbBytes: Uint8Array): NormalizedPtbCommand[] | undefined {
  let snapshot: SuiTransactionSnapshot;
  try {
    snapshot = Transaction.fromKind(ptbBytes).getData() as SuiTransactionSnapshot;
  } catch {
    try {
      snapshot = Transaction.from(ptbBytes).getData() as SuiTransactionSnapshot;
    } catch {
      return undefined;
    }
  }

  const commands: NormalizedPtbCommand[] = [];
  const splitResults = new Map<string, { amount: string; coinType: string; objectIds: string[] }>();

  for (const [index, command] of snapshot.commands.entries()) {
    if (command.MoveCall) {
      commands.push({
        kind: "moveCall",
        packageId: command.MoveCall.package,
        module: command.MoveCall.module,
        function: command.MoveCall.function,
        typeArguments: command.MoveCall.typeArguments ?? [],
        arguments: (command.MoveCall.arguments ?? []).map((argument) => argumentToJson(argument)),
        objects: (command.MoveCall.arguments ?? []).flatMap((argument) => objectIdsFromArgument(argument, snapshot.inputs))
      });
    }

    if (command.SplitCoins) {
      for (const [resultIndex, amountArgument] of command.SplitCoins.amounts.entries()) {
        splitResults.set(`${index}:${resultIndex}`, {
          amount: decodeU64Argument(amountArgument, snapshot.inputs) ?? "unknown",
          coinType: "SUI",
          objectIds: objectIdsFromArgument(command.SplitCoins.coin, snapshot.inputs)
        });
      }
    }

    if (command.MergeCoins) {
      commands.push({
        kind: "mergeCoins",
        destinationObjects: objectIdsFromArgument(command.MergeCoins.destination, snapshot.inputs),
        sourceObjects: command.MergeCoins.sources.flatMap((argument) => objectIdsFromArgument(argument, snapshot.inputs))
      });
    }

    if (command.TransferObjects) {
      const splitTransfers = command.TransferObjects.objects
        .map((argument) => splitTransferFromArgument(argument, splitResults))
        .filter((entry): entry is { amount: string; coinType: string; objectIds: string[] } => entry !== undefined);
      const directObjects = command.TransferObjects.objects.flatMap((argument) => objectIdsFromArgument(argument, snapshot.inputs));
      const amount = sumKnownAmounts(splitTransfers.map((entry) => entry.amount)) ?? "unknown";
      const coinType = splitTransfers.length > 0 && splitTransfers.every((entry) => entry.coinType === splitTransfers[0].coinType)
        ? splitTransfers[0].coinType
        : "unknown";

      commands.push({
        kind: "transfer",
        recipient: decodeAddressArgument(command.TransferObjects.address, snapshot.inputs) ?? "unknown",
        amount,
        coinType,
        objectIds: [...new Set([...directObjects, ...splitTransfers.flatMap((entry) => entry.objectIds)])]
      });
    }

    if (command.MakeMoveVec) {
      commands.push({
        kind: "makeMoveVec",
        type: command.MakeMoveVec.type ?? undefined,
        objects: command.MakeMoveVec.elements.flatMap((argument) => objectIdsFromArgument(argument, snapshot.inputs)),
        arguments: command.MakeMoveVec.elements.map((argument) => argumentToJson(argument))
      });
    }

    if (command.Publish) {
      commands.push({
        kind: "publish",
        moduleCount: command.Publish.modules?.length ?? 0,
        dependencyCount: command.Publish.dependencies?.length ?? 0,
        dependencies: command.Publish.dependencies ?? []
      });
    }

    if (command.Upgrade) {
      commands.push({
        kind: "upgrade",
        packageId: command.Upgrade.package,
        moduleCount: command.Upgrade.modules?.length ?? 0,
        dependencyCount: command.Upgrade.dependencies?.length ?? 0,
        dependencies: command.Upgrade.dependencies ?? [],
        ticketObjects: objectIdsFromArgument(command.Upgrade.ticket, snapshot.inputs)
      });
    }
  }

  return commands.length > 0 ? commands : undefined;
}

function selector(target: PrimaryTarget): string {
  return `${target.packageId}::${target.module}::${target.function}`;
}

function inferSemanticType(commands: NormalizedPtbCommand[]): SemanticType {
  if (commands.length === 1 && commands[0].kind === "transfer") {
    return "transfer";
  }
  if (commands.some((command) => command.kind === "moveCall")) {
    return "move_call";
  }
  return "unknown";
}

function inferRisk(commands: NormalizedPtbCommand[]): RiskLevel {
  if (commands.some((command) => command.kind === "publish" || command.kind === "upgrade")) {
    return "critical";
  }
  if (commands.some((command) => command.kind === "custom")) {
    return "high";
  }
  if (commands.some((command) => command.kind === "moveCall")) {
    return "high";
  }
  if (commands.some((command) => command.kind === "transfer")) {
    return "medium";
  }
  return "high";
}

function inferValueAtRisk(transfers: TransferFact[]): ValueAtRisk | undefined {
  if (transfers.length === 0) {
    return undefined;
  }
  const firstCoin = transfers[0].coinType;
  if (transfers.some((transfer) => transfer.coinType !== firstCoin)) {
    return { amount: "unknown", coinType: "mixed" };
  }
  if (transfers.some((transfer) => transfer.amount === "unknown")) {
    return { amount: "unknown", coinType: firstCoin };
  }
  const total = transfers.reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  return {
    amount: total.toString(),
    coinType: firstCoin
  };
}

export class DefaultPtbInspector implements PtbInspector {
  constructor(private readonly actionRegistry?: ActionRegistry) {}

  inspect(ptbBytes: Uint8Array, manifest?: ActionManifest): PtbInspectionResult {
    const { parsed, commands } = this.parseCommands(ptbBytes);
    const { moveCalls, transfers, objectsTouched, packagesTouched } = this.collectCommandFacts(commands);
    const registryEntry = this.resolveRegistryEntrySync(moveCalls);
    return this.buildInspection({
      ptbBytes,
      manifest,
      parsed,
      commands,
      registryEntry,
      moveCalls,
      transfers,
      objectsTouched,
      packagesTouched
    });
  }

  async inspectAsync(ptbBytes: Uint8Array, manifest?: ActionManifest): Promise<PtbInspectionResult> {
    const { parsed, commands } = this.parseCommands(ptbBytes);
    const { moveCalls, transfers, objectsTouched, packagesTouched } = this.collectCommandFacts(commands);
    const registryEntry = await this.resolveRegistryEntryAsync(moveCalls);
    return this.buildInspection({
      ptbBytes,
      manifest,
      parsed,
      commands,
      registryEntry,
      moveCalls,
      transfers,
      objectsTouched,
      packagesTouched
    });
  }

  private parseCommands(ptbBytes: Uint8Array): { parsed: InspectablePtb | undefined; commands: NormalizedPtbCommand[] } {
    const parsed = parseInspectablePtb(ptbBytes);
    const commands = parsed?.commands ?? parseSuiPtb(ptbBytes) ?? [{ kind: "custom", name: "opaque_ptb" } satisfies NormalizedPtbCommand];
    return { parsed, commands };
  }

  private collectCommandFacts(commands: NormalizedPtbCommand[]): {
    moveCalls: MoveCallFact[];
    transfers: TransferFact[];
    objectsTouched: Set<string>;
    packagesTouched: Set<string>;
  } {
    const moveCalls: MoveCallFact[] = [];
    const transfers: TransferFact[] = [];
    const objectsTouched = new Set<string>();
    const packagesTouched = new Set<string>();

    for (const command of commands) {
      if (command.kind === "transfer") {
        for (const objectId of command.objectIds ?? []) {
          objectsTouched.add(objectId);
        }
        transfers.push({
          recipient: command.recipient,
          amount: command.amount,
          coinType: command.coinType,
          objectIds: command.objectIds ?? []
        });
      }
      if (command.kind === "moveCall") {
        const fact: MoveCallFact = {
          packageId: command.packageId,
          module: command.module,
          function: command.function,
          selector: selector(command),
          typeArguments: command.typeArguments ?? [],
          arguments: command.arguments ?? []
        };
        moveCalls.push(fact);
        packagesTouched.add(command.packageId);
        for (const objectId of command.objects ?? []) {
          objectsTouched.add(objectId);
        }
      }
      if (command.kind === "custom") {
        for (const objectId of command.objects ?? []) {
          objectsTouched.add(objectId);
        }
      }
      if (command.kind === "mergeCoins") {
        for (const objectId of [...command.destinationObjects, ...command.sourceObjects]) {
          objectsTouched.add(objectId);
        }
      }
      if (command.kind === "makeMoveVec") {
        for (const objectId of command.objects) {
          objectsTouched.add(objectId);
        }
      }
      if (command.kind === "publish") {
        for (const packageId of command.dependencies) {
          packagesTouched.add(packageId);
        }
      }
      if (command.kind === "upgrade") {
        packagesTouched.add(command.packageId);
        for (const packageId of command.dependencies) {
          packagesTouched.add(packageId);
        }
        for (const objectId of command.ticketObjects) {
          objectsTouched.add(objectId);
        }
      }
    }

    return {
      moveCalls,
      transfers,
      objectsTouched,
      packagesTouched
    };
  }

  private buildInspection(input: {
    ptbBytes: Uint8Array;
    manifest?: ActionManifest;
    parsed: InspectablePtb | undefined;
    commands: NormalizedPtbCommand[];
    registryEntry?: ActionRegistryEntry;
    moveCalls: MoveCallFact[];
    transfers: TransferFact[];
    objectsTouched: Set<string>;
    packagesTouched: Set<string>;
  }): PtbInspectionResult {
    const {
      ptbBytes,
      manifest,
      parsed,
      commands,
      registryEntry,
      moveCalls,
      transfers,
      objectsTouched,
      packagesTouched
    } = input;
    const semanticType = registryEntry?.semanticType ?? inferSemanticType(commands);
    const riskLevel = registryEntry?.riskCategory ?? inferRisk(commands);
    const inferredValueAtRisk = inferValueAtRisk(transfers);
    const valueAtRisk = inferredValueAtRisk ?? manifest?.valueAtRisk;
    const policyRequirements = Array.from(
      new Set([...(manifest?.policyRequirements ?? []), ...(registryEntry?.requiredPolicyChecks ?? [])])
    ).sort();
    const baseFacts: PolicyFacts = {
      actionHash: "",
      manifestHash: manifest ? hashJson(manifest as unknown as JsonValue) : "",
      ptbHash: hashBytes(ptbBytes),
      semanticType,
      riskLevel,
      expiresAtMs: manifest?.expiresAtMs,
      moveCalls,
      transfers,
      objectsTouched: Array.from(objectsTouched).sort(),
      packagesTouched: Array.from(packagesTouched).sort(),
      valueAtRisk,
      policyRequirements,
      warnings: parsed || commands[0]?.kind !== "custom" ? [] : ["PTB bytes are opaque to the default inspector"]
    };
    baseFacts.actionHash = hashJson({
      ptbHash: baseFacts.ptbHash,
      manifestHash: baseFacts.manifestHash,
      semanticType: baseFacts.semanticType
    });
    return { facts: baseFacts, commands };
  }

  private resolveRegistryEntrySync(moveCalls: MoveCallFact[]): ActionRegistryEntry | undefined {
    if (!this.actionRegistry || moveCalls.length === 0) {
      return undefined;
    }
    const resolved = this.actionRegistry.resolve(moveCalls[0]);
    if (resolved instanceof Promise) {
      throw new Error("Async ActionRegistry requires inspectAsync(...) or SuiMeshClient SDK methods");
    }
    return resolved;
  }

  private async resolveRegistryEntryAsync(moveCalls: MoveCallFact[]): Promise<ActionRegistryEntry | undefined> {
    if (!this.actionRegistry || moveCalls.length === 0) {
      return undefined;
    }
    return this.actionRegistry.resolve(moveCalls[0]);
  }

  validateManifest(manifest: ActionManifest, facts: PolicyFacts): ManifestValidationResult {
    const errors: string[] = [];
    if (manifest.actionType !== SUI_PTB_ACTION_TYPE) {
      errors.push("manifest.actionType must be sui.ptb.v1");
    }
    if (manifest.ptbHash !== facts.ptbHash) {
      errors.push("manifest.ptbHash does not match PTB bytes");
    }
    if (manifest.traceId.length === 0) {
      errors.push("manifest.traceId is required");
    }
    if (manifest.semanticType !== facts.semanticType && manifest.semanticType !== "unknown") {
      errors.push(`manifest.semanticType ${manifest.semanticType} does not match inspected ${facts.semanticType}`);
    }
    if (manifest.primaryTarget && facts.moveCalls.length > 0) {
      const primary = facts.moveCalls[0];
      if (
        manifest.primaryTarget.packageId !== primary.packageId ||
        manifest.primaryTarget.module !== primary.module ||
        manifest.primaryTarget.function !== primary.function
      ) {
        errors.push("manifest.primaryTarget does not match first MoveCall");
      }
    }
    for (const objectId of manifest.objectsTouched) {
      if (!facts.objectsTouched.includes(objectId)) {
        errors.push(`manifest.objectsTouched includes uninspected object ${objectId}`);
      }
    }
    for (const objectId of facts.objectsTouched) {
      if (!manifest.objectsTouched.includes(objectId)) {
        errors.push(`manifest.objectsTouched omits inspected object ${objectId}`);
      }
    }
    if (facts.valueAtRisk && manifest.valueAtRisk) {
      if (
        facts.valueAtRisk.amount !== manifest.valueAtRisk.amount ||
        facts.valueAtRisk.coinType !== manifest.valueAtRisk.coinType
      ) {
        errors.push("manifest.valueAtRisk does not match inspected value at risk");
      }
    }
    if (riskRank(manifest.riskLevel) < riskRank(facts.riskLevel)) {
      errors.push(`manifest.riskLevel ${manifest.riskLevel} understates inspected risk ${facts.riskLevel}`);
    }
    if (manifest.expiresAtMs <= 0) {
      errors.push("manifest.expiresAtMs must be set");
    }
    return {
      ok: errors.length === 0,
      errors
    };
  }
}

function pureBytes(input: SuiTransactionInput | undefined): Uint8Array | undefined {
  return input?.Pure?.bytes ? fromBase64(input.Pure.bytes) : undefined;
}

function decodeAddressArgument(argument: SuiTransactionArgument, inputs: SuiTransactionInput[]): string | undefined {
  if (!("Input" in argument)) {
    return undefined;
  }
  const bytes = pureBytes(inputs[argument.Input]);
  if (!bytes) {
    return undefined;
  }
  try {
    return bcs.Address.parse(bytes);
  } catch {
    return undefined;
  }
}

function decodeU64Argument(argument: SuiTransactionArgument, inputs: SuiTransactionInput[]): string | undefined {
  if (!("Input" in argument)) {
    return undefined;
  }
  const bytes = pureBytes(inputs[argument.Input]);
  if (!bytes) {
    return undefined;
  }
  try {
    return String(bcs.U64.parse(bytes));
  } catch {
    return undefined;
  }
}

function objectIdsFromArgument(argument: SuiTransactionArgument, inputs: SuiTransactionInput[]): string[] {
  if ("GasCoin" in argument) {
    return ["gas"];
  }
  if (!("Input" in argument)) {
    return [];
  }
  return objectIdsFromInput(inputs[argument.Input]);
}

function objectIdsFromInput(input: SuiTransactionInput | undefined): string[] {
  if (!input) {
    return [];
  }
  if (input.UnresolvedObject?.objectId) {
    return [input.UnresolvedObject.objectId];
  }
  const encoded = JSON.stringify(input.Object ?? {});
  const matches = encoded.match(/0x[a-fA-F0-9]{64}/g) ?? [];
  return [...new Set(matches)];
}

function argumentToJson(argument: SuiTransactionArgument): JsonValue {
  if ("GasCoin" in argument) {
    return { kind: "GasCoin" };
  }
  if ("Input" in argument) {
    return { kind: "Input", index: argument.Input };
  }
  if ("Result" in argument) {
    return { kind: "Result", index: argument.Result };
  }
  return { kind: "NestedResult", command: argument.NestedResult[0], result: argument.NestedResult[1] };
}

function splitTransferFromArgument(
  argument: SuiTransactionArgument,
  splitResults: Map<string, { amount: string; coinType: string; objectIds: string[] }>
): { amount: string; coinType: string; objectIds: string[] } | undefined {
  if (!("NestedResult" in argument)) {
    return undefined;
  }
  return splitResults.get(`${argument.NestedResult[0]}:${argument.NestedResult[1]}`);
}

function sumKnownAmounts(amounts: string[]): string | undefined {
  if (amounts.length === 0 || amounts.some((amount) => amount === "unknown")) {
    return undefined;
  }
  return amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString();
}

function riskRank(risk: RiskLevel): number {
  if (risk === "low") return 1;
  if (risk === "medium") return 2;
  if (risk === "high") return 3;
  return 4;
}

export class LocalPtbSimulator implements PtbSimulator {
  async simulate(input: { ptbBytes: Uint8Array; manifest: ActionManifest; facts: PolicyFacts }): Promise<SimulationResult> {
    return {
      ok: input.facts.warnings.length === 0,
      gasEstimate: "1000000",
      balanceChanges: input.facts.transfers.map((transfer) => ({
        owner: transfer.recipient,
        coinType: transfer.coinType,
        amount: transfer.amount
      })),
      objectChanges: input.facts.objectsTouched.map((objectId) => ({ objectId, change: "touched" })),
      events: [
        {
          type: "suimesh.local_simulation.v1",
          ptbHash: input.facts.ptbHash
        }
      ],
      error: input.facts.warnings.length > 0 ? input.facts.warnings.join("; ") : undefined
    };
  }
}
