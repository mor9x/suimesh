import { hashBytes } from "../../codec/src/index.ts";

export type ContextStorageProvider = "walrus" | "local";

export interface ContextRef {
  provider: ContextStorageProvider;
  blobId: string;
  digest: string;
  contentType?: string;
  encrypted: boolean;
}

export interface StorageAdapter {
  provider: ContextStorageProvider;
  put(input: { bytes: Uint8Array; contentType?: string; encrypted?: boolean }): Promise<ContextRef>;
  get(ref: ContextRef): Promise<Uint8Array | undefined>;
}

export interface WalrusClientLike {
  write(input: { bytes: Uint8Array; contentType?: string }): Promise<{ blobId: string }>;
  read(input: { blobId: string }): Promise<Uint8Array>;
}

export type WalrusFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface WalrusHttpClientOptions {
  publisherUrl: string;
  aggregatorUrl: string;
  epochs?: number;
  deletable?: boolean;
  permanent?: boolean;
  sendObjectTo?: string;
  fetch?: WalrusFetch;
  readRetry?: {
    attempts?: number;
    delayMs?: number;
  };
}

export class InMemoryStorageAdapter implements StorageAdapter {
  provider: ContextStorageProvider = "local";
  private readonly blobs = new Map<string, Uint8Array>();

  async put(input: { bytes: Uint8Array; contentType?: string; encrypted?: boolean }): Promise<ContextRef> {
    const digest = hashBytes(input.bytes);
    const blobId = `local:${digest}`;
    this.blobs.set(blobId, input.bytes);
    return {
      provider: "local",
      blobId,
      digest,
      contentType: input.contentType,
      encrypted: input.encrypted ?? true
    };
  }

  async get(ref: ContextRef): Promise<Uint8Array | undefined> {
    return this.blobs.get(ref.blobId);
  }
}

export class WalrusStorageAdapter implements StorageAdapter {
  provider: ContextStorageProvider = "walrus";

  constructor(private readonly client: WalrusClientLike) {}

  async put(input: { bytes: Uint8Array; contentType?: string; encrypted?: boolean }): Promise<ContextRef> {
    const result = await this.client.write({
      bytes: input.bytes,
      contentType: input.contentType
    });
    return {
      provider: "walrus",
      blobId: result.blobId,
      digest: hashBytes(input.bytes),
      contentType: input.contentType,
      encrypted: input.encrypted ?? true
    };
  }

  async get(ref: ContextRef): Promise<Uint8Array | undefined> {
    return this.client.read({ blobId: ref.blobId });
  }
}

export class WalrusHttpClient implements WalrusClientLike {
  private readonly publisherUrl: string;
  private readonly aggregatorUrl: string;
  private readonly fetchFn: WalrusFetch;
  private readonly epochs: number;
  private readonly deletable?: boolean;
  private readonly permanent?: boolean;
  private readonly sendObjectTo?: string;
  private readonly readAttempts: number;
  private readonly readDelayMs: number;

  constructor(options: WalrusHttpClientOptions) {
    this.publisherUrl = trimTrailingSlash(options.publisherUrl);
    this.aggregatorUrl = trimTrailingSlash(options.aggregatorUrl);
    this.fetchFn = options.fetch ?? fetch;
    this.epochs = options.epochs ?? 1;
    this.deletable = options.deletable;
    this.permanent = options.permanent;
    this.sendObjectTo = options.sendObjectTo;
    this.readAttempts = options.readRetry?.attempts ?? 6;
    this.readDelayMs = options.readRetry?.delayMs ?? 2_000;
  }

  async write(input: { bytes: Uint8Array; contentType?: string }): Promise<{ blobId: string }> {
    const url = new URL(`${this.publisherUrl}/v1/blobs`);
    url.searchParams.set("epochs", String(this.epochs));
    if (this.deletable !== undefined) {
      url.searchParams.set("deletable", String(this.deletable));
    }
    if (this.permanent !== undefined) {
      url.searchParams.set("permanent", String(this.permanent));
    }
    if (this.sendObjectTo) {
      url.searchParams.set("send_object_to", this.sendObjectTo);
    }

    const response = await this.fetchFn(url, {
      method: "PUT",
      headers: input.contentType ? { "content-type": input.contentType } : undefined,
      body: bytesToRequestBody(input.bytes)
    });
    if (!response.ok) {
      throw new Error(`Walrus publisher failed: ${response.status} ${await safeResponseText(response)}`);
    }

    const body = (await response.json()) as unknown;
    const blobId = extractWalrusBlobId(body);
    if (!blobId) {
      throw new Error(`Walrus publisher response did not include blobId: ${JSON.stringify(body)}`);
    }
    return { blobId };
  }

  async read(input: { blobId: string }): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.readAttempts; attempt += 1) {
      try {
        const response = await this.fetchFn(`${this.aggregatorUrl}/v1/blobs/${encodeURIComponent(input.blobId)}`);
        if (!response.ok) {
          throw new Error(`Walrus aggregator failed: ${response.status} ${await safeResponseText(response)}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        lastError = error;
        if (attempt < this.readAttempts) {
          await sleep(this.readDelayMs);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function bytesToRequestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function extractWalrusBlobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if ("blobId" in value && typeof value.blobId === "string") {
    return value.blobId;
  }
  if ("newlyCreated" in value) {
    return extractWalrusBlobId(value.newlyCreated);
  }
  if ("alreadyCertified" in value) {
    return extractWalrusBlobId(value.alreadyCertified);
  }
  if ("blobObject" in value) {
    return extractWalrusBlobId(value.blobObject);
  }
  for (const entry of Object.values(value)) {
    const found = extractWalrusBlobId(entry);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
