import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1";
import { fromBase64 } from "@mysten/sui/utils";
import type {
  SuiMoveTraceGuardClient,
  SuiMoveTraceGuardTransactionResult
} from "../../src/index.ts";

export type LiveNetwork = "testnet" | "mainnet" | "devnet" | "localnet";
export type LiveSigner = Ed25519Keypair | Secp256k1Keypair | Secp256r1Keypair;

export const DEFAULT_RELAYER_URL = "https://relay.suimesh.link";
export const DEFAULT_TRACE_PACKAGE_ID = "0x038caadb65def30619e6ec762715ea6ca232ac1195bc077086bc9a6b7e11bb80";
export const DEFAULT_TRACE_REGISTRY_ID = "0x95c630c93000d9aeb9ff9512ead6209e0568eb327abb489dd5fc7390d034046b";
export const DEFAULT_WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space";
export const DEFAULT_WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space";

const LIVE_NETWORKS = ["testnet", "mainnet", "devnet", "localnet"] as const;
const TESTNET_OPEN_SEAL_SERVER_CONFIGS = [
  { objectId: "0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75", weight: 1 },
  { objectId: "0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8", weight: 1 }
];

export function liveNetwork(): LiveNetwork {
  const value = process.env.SUIMESH_NETWORK ?? "testnet";
  if (!isLiveNetwork(value)) {
    throw new Error(`Invalid SUIMESH_NETWORK ${value}; expected one of ${LIVE_NETWORKS.join(", ")}`);
  }
  return value;
}

export function createLiveSuiClient(network = liveNetwork()): SuiJsonRpcClient {
  return new SuiJsonRpcClient({
    network,
    url: process.env.SUIMESH_FULLNODE_URL ?? getJsonRpcFullnodeUrl(network)
  });
}

export function resolveSealServerConfigs(network: LiveNetwork): { objectId: string; weight: number }[] {
  if (process.env.SUIMESH_SEAL_SERVER_CONFIGS) {
    return parseSealServerConfigs(process.env.SUIMESH_SEAL_SERVER_CONFIGS);
  }
  if (network === "testnet") {
    return TESTNET_OPEN_SEAL_SERVER_CONFIGS;
  }
  throw new Error("Missing SUIMESH_SEAL_SERVER_CONFIGS for non-testnet live messaging");
}

export function resolveSealThreshold(configs: { objectId: string; weight: number }[]): number {
  const threshold = Number(process.env.SUIMESH_SEAL_THRESHOLD ?? Math.min(2, configs.length));
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new Error(`Invalid SUIMESH_SEAL_THRESHOLD ${process.env.SUIMESH_SEAL_THRESHOLD ?? threshold}`);
  }
  const totalWeight = configs.reduce((sum, config) => sum + config.weight, 0);
  if (threshold > totalWeight) {
    throw new Error(`SUIMESH_SEAL_THRESHOLD ${threshold} exceeds total Seal server weight ${totalWeight}`);
  }
  return threshold;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

export async function resolveSigner(): Promise<LiveSigner> {
  return process.env.SUIMESH_SUI_PRIVATE_KEY
    ? keypairFromPrivateKey(process.env.SUIMESH_SUI_PRIVATE_KEY)
    : signerFromSuiCli();
}

export async function sleep(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

export class RecordingSuiClient implements SuiMoveTraceGuardClient {
  readonly digests: string[] = [];

  constructor(private readonly client: SuiJsonRpcClient) {}

  async signAndExecuteTransaction(
    input: Parameters<SuiMoveTraceGuardClient["signAndExecuteTransaction"]>[0]
  ): Promise<SuiMoveTraceGuardTransactionResult> {
    const result = await this.client.signAndExecuteTransaction(input as never);
    if (result.digest) {
      this.digests.push(result.digest);
      await this.client.waitForTransaction({ digest: result.digest });
    }
    return result as SuiMoveTraceGuardTransactionResult;
  }
}

function keypairFromPrivateKey(value: string): LiveSigner {
  const decoded = decodeSuiPrivateKey(value);
  if (decoded.scheme === "ED25519") {
    return Ed25519Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256k1") {
    return Secp256k1Keypair.fromSecretKey(decoded.secretKey);
  }
  if (decoded.scheme === "Secp256r1") {
    return Secp256r1Keypair.fromSecretKey(decoded.secretKey);
  }
  throw new Error(`Unsupported key scheme ${decoded.scheme}`);
}

function keypairFromKeystoreEntry(value: string): LiveSigner {
  const bytes = fromBase64(value);
  const secretKey = bytes.slice(1);
  if (bytes[0] === 0) {
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  if (bytes[0] === 1) {
    return Secp256k1Keypair.fromSecretKey(secretKey);
  }
  if (bytes[0] === 2) {
    return Secp256r1Keypair.fromSecretKey(secretKey);
  }
  throw new Error(`Unsupported Sui keystore key scheme flag ${bytes[0]}`);
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${Bun.env.HOME}${path.slice(1)}` : path;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(expandHome(path)).text();
  } catch {
    return undefined;
  }
}

async function signerFromSuiCli(): Promise<LiveSigner> {
  const configPath = process.env.SUIMESH_SUI_CONFIG ?? "~/.sui/sui_config/client.yaml";
  const config = await readTextIfExists(configPath);
  const activeAddress =
    process.env.SUIMESH_SUI_ADDRESS ??
    config?.match(/active_address:\s*"?([^"\n]+)"?/)?.[1]?.trim();
  const keystorePath =
    process.env.SUIMESH_SUI_KEYSTORE ??
    config?.match(/keystore:\s*(?:File:\s*)?["']?([^"'\n]+)["']?/)?.[1]?.trim() ??
    "~/.sui/sui_config/sui.keystore";
  const rawKeystore = await readTextIfExists(keystorePath);
  if (!rawKeystore) {
    throw new Error("Missing SUIMESH_SUI_PRIVATE_KEY, and Sui CLI keystore was not found");
  }
  const entries = JSON.parse(rawKeystore) as string[];
  for (const entry of entries) {
    const signer = keypairFromKeystoreEntry(entry);
    if (!activeAddress || signer.toSuiAddress().toLowerCase() === activeAddress.toLowerCase()) {
      return signer;
    }
  }
  throw new Error(`No Sui CLI keystore entry matched active address ${activeAddress}`);
}

function isLiveNetwork(value: string): value is LiveNetwork {
  return (LIVE_NETWORKS as readonly string[]).includes(value);
}

function parseSealServerConfigs(value: string): { objectId: string; weight: number }[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SUIMESH_SEAL_SERVER_CONFIGS must be a non-empty JSON array");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`SUIMESH_SEAL_SERVER_CONFIGS[${index}] must be an object`);
    }
    const record = entry as { objectId?: unknown; weight?: unknown };
    if (typeof record.objectId !== "string" || record.objectId.length === 0) {
      throw new Error(`SUIMESH_SEAL_SERVER_CONFIGS[${index}].objectId must be a non-empty string`);
    }
    const weight = record.weight;
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight <= 0) {
      throw new Error(`SUIMESH_SEAL_SERVER_CONFIGS[${index}].weight must be a positive integer`);
    }
    return {
      objectId: record.objectId,
      weight
    };
  });
}
