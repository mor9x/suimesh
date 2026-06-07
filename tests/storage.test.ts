import { describe, expect, test } from "bun:test";
import { InMemoryStorageAdapter, WalrusHttpClient, WalrusStorageAdapter } from "../src/index.ts";

describe("storage adapters", () => {
  test("stores encrypted context refs with stable digests", async () => {
    const storage = new InMemoryStorageAdapter();
    const bytes = new TextEncoder().encode("encrypted-context");
    const ref = await storage.put({ bytes, contentType: "application/octet-stream" });

    expect(ref.provider).toBe("local");
    expect(ref.encrypted).toBe(true);
    expect(await storage.get(ref)).toEqual(bytes);
  });

  test("wraps Walrus client write/read without owning encryption", async () => {
    const blobs = new Map<string, Uint8Array>();
    const storage = new WalrusStorageAdapter({
      async write(input) {
        blobs.set("blob_1", input.bytes);
        return { blobId: "blob_1" };
      },
      async read(input) {
        return blobs.get(input.blobId) ?? new Uint8Array();
      }
    });
    const bytes = new TextEncoder().encode("ciphertext");
    const ref = await storage.put({ bytes, encrypted: true });

    expect(ref.provider).toBe("walrus");
    expect(ref.blobId).toBe("blob_1");
    expect(await storage.get(ref)).toEqual(bytes);
  });

  test("Walrus HTTP client writes through publisher and reads through aggregator", async () => {
    const stored = new Map<string, Uint8Array>();
    const fetchCalls: string[] = [];
    const client = new WalrusHttpClient({
      publisherUrl: "https://publisher.example",
      aggregatorUrl: "https://aggregator.example",
      epochs: 3,
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.startsWith("https://publisher.example/v1/blobs")) {
          stored.set("blob_live", new Uint8Array(init?.body as ArrayBuffer));
          return Response.json({
            newlyCreated: {
              blobObject: {
                blobId: "blob_live"
              }
            }
          });
        }
        return new Response(stored.get("blob_live")?.buffer.slice(0) as ArrayBuffer);
      }
    });

    const storage = new WalrusStorageAdapter(client);
    const bytes = new TextEncoder().encode("archive-context");
    const ref = await storage.put({ bytes, contentType: "application/json", encrypted: true });
    const restored = await storage.get(ref);

    expect(ref.provider).toBe("walrus");
    expect(ref.blobId).toBe("blob_live");
    expect(restored).toEqual(bytes);
    expect(fetchCalls[0]).toContain("PUT https://publisher.example/v1/blobs?epochs=3");
    expect(fetchCalls[1]).toBe("GET https://aggregator.example/v1/blobs/blob_live");
  });
});
