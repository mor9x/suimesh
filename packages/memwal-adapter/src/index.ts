import type { MemoryReceipt } from "../../protocol/src/index.ts";
import { hashJson } from "../../codec/src/index.ts";

export type MemoryProviderMode = "memwal" | "external" | "none";

export interface MemoryAdapter {
  provider: MemoryProviderMode;
  recall(input: { namespace: string; query: string; nowMs?: number }): Promise<{ memories: unknown[]; receipt: MemoryReceipt }>;
  remember(input: { namespace: string; content: unknown; nowMs?: number }): Promise<MemoryReceipt>;
}

export class NoneMemoryAdapter implements MemoryAdapter {
  provider: MemoryProviderMode = "none";

  async recall(input: { namespace: string; query: string; nowMs?: number }): Promise<{ memories: unknown[]; receipt: MemoryReceipt }> {
    return {
      memories: [],
      receipt: {
        provider: "none",
        operation: "recall",
        namespace: input.namespace,
        createdAtMs: input.nowMs ?? Date.now()
      }
    };
  }

  async remember(input: { namespace: string; content: unknown; nowMs?: number }): Promise<MemoryReceipt> {
    return {
      provider: "none",
      operation: "remember",
      namespace: input.namespace,
      memoryHash: hashJson({ skipped: true, content: String(input.content) }),
      createdAtMs: input.nowMs ?? Date.now()
    };
  }
}

export interface MemWalClientLike {
  recall?: (input: { namespace: string; query: string }) => Promise<unknown[]>;
  remember?: (input: { namespace: string; content: unknown }) => Promise<{ ref?: string } | void>;
}

export class MemWalAdapter implements MemoryAdapter {
  provider: MemoryProviderMode = "memwal";

  constructor(private readonly client: MemWalClientLike) {}

  async recall(input: { namespace: string; query: string; nowMs?: number }): Promise<{ memories: unknown[]; receipt: MemoryReceipt }> {
    const memories = this.client.recall ? await this.client.recall({ namespace: input.namespace, query: input.query }) : [];
    return {
      memories,
      receipt: {
        provider: "memwal",
        operation: "recall",
        namespace: input.namespace,
        memoryHash: hashJson({ memories: memories.length, query: input.query }),
        createdAtMs: input.nowMs ?? Date.now()
      }
    };
  }

  async remember(input: { namespace: string; content: unknown; nowMs?: number }): Promise<MemoryReceipt> {
    const result = this.client.remember ? await this.client.remember({ namespace: input.namespace, content: input.content }) : undefined;
    return {
      provider: "memwal",
      operation: "remember",
      namespace: input.namespace,
      memoryRef: result && "ref" in result ? result.ref : undefined,
      memoryHash: hashJson({ content: JSON.stringify(input.content) ?? String(input.content) }),
      createdAtMs: input.nowMs ?? Date.now()
    };
  }
}
