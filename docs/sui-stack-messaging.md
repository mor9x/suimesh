# Sui Stack Messaging Transport Binding

SuiMesh can use `@mysten/sui-stack-messaging` through a transport binding.

The binding stores each SuiMesh event envelope as the plaintext `text` payload passed into `client.messaging.sendMessage(...)`. The official SDK then handles encryption, sender verification, relayer delivery, and recovery support.

## Installed Version

```text
@mysten/sui-stack-messaging = 0.0.2
@mysten/seal = 1.1.3
@mysten/sui-groups = 0.0.1
```

The npm package points to:

```text
https://github.com/MystenLabs/sui-stack-messaging
```

## Binding Shape

```ts
import { SuiStackEventTransport, createSuiMeshClient } from "../src/index.ts";

const transport = new SuiStackEventTransport({
  client: suiStackClient.messaging,
  signer,
  groupRefForSession: (sessionId) => ({ uuid: sessionId }),
});

const client = createSuiMeshClient({ transport });
```

`groupRefForSession` controls how SuiMesh sessions map to official messaging groups. The default is:

```ts
(sessionId) => ({ uuid: sessionId })
```

For production deployments, you can map sessions to explicit group IDs instead:

```ts
groupRefForSession: (sessionId) => ({
  groupId: "...",
  encryptionHistoryId: "...",
})
```

## Group Discovery By Polling

`sui-stack-messaging` does not provide a direct inbox API like `listGroupsForAddress(address)`.
Membership is represented by Sui Groups permission events. For v0.1, this binding uses a lightweight
session discovery poller instead of running a local indexer.

```text
Owner grants Agent membership or messaging permissions
-> Sui emits MemberAdded / PermissionsGranted events
-> SuiStackSessionDiscovery polls queryEvents
-> discovery filters events by agent address
-> discovery calls groupsMetadata(groupIds) to recover uuid/name
-> Agent opens the discovered SuiMesh session through SuiStackEventTransport
```

Minimal SDK shape:

```ts
import {
  membershipEventTypesFromSuiStackClient,
  SuiStackSessionDiscovery,
} from "../src/index.ts";

const discovery = new SuiStackSessionDiscovery({
  actorAddress: agentAddress,
  suiClient,
  eventTypes: membershipEventTypesFromSuiStackClient(suiStackClient),
  metadataView: suiStackClient.messaging.view,
});

const result = await discovery.poll();

for (const session of result.addedSessions) {
  // session.groupId is the on-chain group object.
  // session.uuid can be used as the default SuiMesh session id.
}
```

The polling mode is lightweight and avoids a dedicated indexer:

```text
no local indexer required
no new relayer endpoint required
dedupe is handled by event IDs and cursors
access control is still enforced by Sui Groups, Seal, and the official messaging relayer
```

If `initialCursorByEventType` is empty, the first poll backfills historical membership events for
the actor and can discover old active groups. Persist `result.cursorByEventType` and pass it back on
restart when the caller only wants new membership or permission notifications.

For production, replace the polling discovery with an indexed session discovery service that persists:

```text
(user_address, group_id) -> permission set
group_id -> uuid / encryption history metadata
last processed checkpoint / cursor
```

## Creating The Official Client

The official SDK composes Sui, Sui Groups, Seal, and the messaging extension. The exact setup depends on network, Seal key servers, and relayer URL.

```ts
import { SuiClient } from "@mysten/sui/client";
import { createSuiStackMessagingClient } from "@mysten/sui-stack-messaging";

const suiStackClient = createSuiStackMessagingClient(
  new SuiClient({ url: "https://fullnode.testnet.sui.io:443" }),
  {
    seal: {
      serverConfigs: [
        // Fill with Seal key server configs for your network.
      ],
    },
    encryption: {
      sessionKey: { signer },
    },
    relayer: {
      relayerUrl: "https://your-relayer.example.com",
    },
  },
);
```

Then pass `suiStackClient.messaging` into `SuiStackEventTransport`.

## Test Layers

The binding has two test layers:

```text
offline unit tests:
  fake official client with the same sendMessage/getMessages/subscribe shape
  no network, no Seal, no relayer

live integration test:
  require a real Sui signer
  creates a real messaging group
  require Seal key-server config
  uses either the local HTTP relayer or a remote persistent relayer URL
```

The current test suite verifies:

```text
the real @mysten/sui-stack-messaging package loads
SuiMesh envelopes serialize into official message text
adapter send/list calls use the official SDK method shape
the in-memory adapter remains available for pure protocol tests
```

Live tests are excluded from `bun test` because they spend gas and depend on external
infrastructure.

```bash
export SUIMESH_NETWORK=testnet

bun run test:live:messaging
```

By default the live test:

```text
uses the Sui CLI active wallet from ~/.sui/sui_config
uses Mysten's verified open testnet Seal key servers
starts a local HTTP relayer and exercises the official HTTPRelayerTransport
disconnects the first client and restores the same event through a new client
```

For an external relayer or custom key servers, set:

```bash
export SUIMESH_RELAYER_URL=https://your-relayer.example.com
export SUIMESH_SEAL_SERVER_CONFIGS='[{"objectId":"0x...","weight":1}]'
export SUIMESH_SUI_PRIVATE_KEY=suiprivkey...
```

To force a remote persistent relayer test, run:

```bash
export SUIMESH_RELAYER_URL=https://your-relayer.example.com
bun run test:live:messaging:remote
```

That path fails fast if `SUIMESH_RELAYER_URL` is not set. It proves the event was not just kept in a
process-local cache: SuiMesh sends through `@mysten/sui-stack-messaging`, disconnects, constructs a
fresh official client, fetches/decrypts from the same relayer, then verifies the SuiMesh hash chain.

What it does:

```text
createSuiStackMessagingClient
-> createAndShareGroup on Sui
-> send SuiMesh event through SuiStackEventTransport
-> encrypted delivery through relayer
-> fetch/decrypt through official getMessages
-> restore and verify SuiMesh event chain
```

There is a separate heavy-action live test:

```bash
bun run test:live:heavy
```

It runs a real testnet `sui.ptb.v1` flow:

```text
TransactionKind BCS -> inspect -> policy approval -> on-chain ActionAnchor
-> on-chain ActionClaim -> execute 1 MIST transfer -> on-chain complete
-> duplicate claim rejection -> restored SuiMesh trace verification
```

Optional env:

```text
SUIMESH_FULLNODE_URL
SUIMESH_GROUP_UUID
SUIMESH_GROUP_NAME
SUIMESH_TRACE_PACKAGE_ID
SUIMESH_TRACE_REGISTRY_ID
SUIMESH_LIVE_RECIPIENT
SUIMESH_LIVE_AMOUNT_MIST
```

Walrus archive live test:

```bash
bun run test:live:walrus
```

It uploads a small encrypted SuiMesh context archive through the Walrus HTTP publisher, restores it
through the aggregator, and verifies the byte digest. The default storage duration is 5 Walrus
epochs unless `SUIMESH_WALRUS_EPOCHS` is set.

Full business live test:

```bash
SUIMESH_RELAYER_URL=http://localhost:3000 bun run test:live:business
```

It creates a real testnet messaging group, sends the SuiMesh light/heavy trace through the official
relayer, dev-inspects and executes a 1 MIST PTB transfer, records on-chain anchor/claim/complete
state, stores the audit detail on Walrus using the messaging group's Seal-managed encryption, then
reconnects with a fresh client and verifies both the event hash chain and Walrus archive decryption
through the group policy.

Optional env:

```text
SUIMESH_WALRUS_PUBLISHER_URL
SUIMESH_WALRUS_AGGREGATOR_URL
SUIMESH_WALRUS_EPOCHS
SUIMESH_WALRUS_READ_ATTEMPTS
SUIMESH_WALRUS_READ_DELAY_MS
```
