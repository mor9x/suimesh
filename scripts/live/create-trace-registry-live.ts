import { Transaction } from "@mysten/sui/transactions";
import { createLiveSuiClient, liveNetwork, resolveSigner } from "./live-common.ts";

const packageId = process.env.SUIMESH_TRACE_PACKAGE_ID ?? process.argv[2];
if (!packageId) {
  throw new Error("Missing package id. Pass it as argv[2] or SUIMESH_TRACE_PACKAGE_ID.");
}

const network = liveNetwork();
const signer = await resolveSigner();
const client = createLiveSuiClient(network);

const tx = new Transaction();
tx.moveCall({
  target: `${packageId}::trace::create_shared_registry`
});

const result = await client.signAndExecuteTransaction({
  signer,
  transaction: tx,
  options: {
    showEffects: true,
    showObjectChanges: true
  }
});
await client.waitForTransaction({ digest: result.digest });

const registry = result.objectChanges?.find((change) =>
  change.type === "created" &&
  change.objectType === `${packageId}::trace::Registry` &&
  typeof change.owner === "object" &&
  change.owner !== null &&
  "Shared" in change.owner
);
if (!registry || registry.type !== "created") {
  throw new Error(`Registry object was not found in objectChanges: ${JSON.stringify(result.objectChanges)}`);
}

console.log(JSON.stringify({
  network,
  packageId,
  registryId: registry.objectId,
  txDigest: result.digest,
  owner: signer.toSuiAddress()
}, null, 2));
