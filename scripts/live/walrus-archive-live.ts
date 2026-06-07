import { base64UrlToBytes, bytesToBase64Url, hashBytes, WalrusHttpClient, WalrusStorageAdapter } from "../../src/index.ts";
import { DEFAULT_WALRUS_AGGREGATOR_URL, DEFAULT_WALRUS_PUBLISHER_URL } from "./live-common.ts";

const publisherUrl = process.env.SUIMESH_WALRUS_PUBLISHER_URL ?? DEFAULT_WALRUS_PUBLISHER_URL;
const aggregatorUrl = process.env.SUIMESH_WALRUS_AGGREGATOR_URL ?? DEFAULT_WALRUS_AGGREGATOR_URL;
const epochs = Number(process.env.SUIMESH_WALRUS_EPOCHS ?? "5");

const storage = new WalrusStorageAdapter(
  new WalrusHttpClient({
    publisherUrl,
    aggregatorUrl,
    epochs,
    readRetry: {
      attempts: Number(process.env.SUIMESH_WALRUS_READ_ATTEMPTS ?? "8"),
      delayMs: Number(process.env.SUIMESH_WALRUS_READ_DELAY_MS ?? "2500")
    }
  })
);

const archive = {
  protocol: "suimesh",
  version: "0.1",
  kind: "walrus-live-archive",
  createdAtMs: Date.now(),
  events: [
    {
      eventType: "conversation.user_message.v1",
      actor: "user:walrus-live",
      content: "SuiMesh Walrus archive live E2E"
    },
    {
      eventType: "outcome.audit_event.v1",
      actor: "system:walrus-live",
      detail: "Archive uploaded and restored through Walrus publisher/aggregator"
    }
  ]
};

const plaintext = new TextEncoder().encode(JSON.stringify(archive));
const plaintextDigest = hashBytes(plaintext);
const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
const bytes = new TextEncoder().encode(
  JSON.stringify({
    protocol: "suimesh",
    version: "0.1",
    kind: "walrus-live-encrypted-archive",
    algorithm: "AES-GCM-256",
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(ciphertext)
  })
);
const ref = await storage.put({
  bytes,
  contentType: "application/json",
  encrypted: true
});
const restored = await storage.get(ref);

if (!restored) {
  throw new Error("Walrus live archive restore returned no bytes");
}

const restoredDigest = hashBytes(restored);
if (restoredDigest !== ref.digest) {
  throw new Error(`Walrus live archive digest mismatch: expected ${ref.digest}, got ${restoredDigest}`);
}
const restoredPackage = JSON.parse(new TextDecoder().decode(restored)) as { iv: string; ciphertext: string };
const restoredPlaintext = new Uint8Array(
  await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(restoredPackage.iv)) },
    key,
    toArrayBuffer(base64UrlToBytes(restoredPackage.ciphertext))
  )
);
const restoredPlaintextDigest = hashBytes(restoredPlaintext);
if (restoredPlaintextDigest !== plaintextDigest) {
  throw new Error(
    `Walrus live archive plaintext mismatch: expected ${plaintextDigest}, got ${restoredPlaintextDigest}`
  );
}

console.log(
  JSON.stringify(
    {
      publisherUrl,
      aggregatorUrl,
      epochs,
      blobId: ref.blobId,
      digest: ref.digest,
      plaintextDigest,
      restoredBytes: restored.length,
      restoredPlaintextBytes: restoredPlaintext.length,
      encrypted: ref.encrypted,
      verified: true
    },
    null,
    2
  )
);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
