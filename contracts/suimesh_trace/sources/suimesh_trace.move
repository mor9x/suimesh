module suimesh_trace::trace;

const E_NOT_APPROVED: u64 = 1;
const E_ALREADY_CLAIMED: u64 = 2;
const E_NOT_CLAIMED: u64 = 3;
const E_ALREADY_COMPLETED: u64 = 4;
const E_UNAUTHORIZED_OWNER: u64 = 5;
const E_UNAUTHORIZED_EXECUTOR: u64 = 6;
const E_UNAUTHORIZED_CLAIMANT: u64 = 7;
const E_EXPIRED: u64 = 8;
const E_CLAIM_EXPIRED: u64 = 9;
const E_INVALID_AUTHORIZED_EXECUTOR: u64 = 10;
const E_INVALID_CLAIM_LEASE: u64 = 11;

const STATUS_ANCHORED: u8 = 1;
const STATUS_CLAIMED: u8 = 2;
const STATUS_EXECUTED: u8 = 3;
const STATUS_FAILED: u8 = 4;

public struct Registry has key {
    id: sui::object::UID,
    owner: address,
    anchors: sui::table::Table<vector<u8>, Anchor>,
}

public struct Anchor has store {
    trace_id: vector<u8>,
    action_hash: vector<u8>,
    proposal_hash: vector<u8>,
    decision_hash: vector<u8>,
    receipt_hash: vector<u8>,
    owner: address,
    authorized_executor: address,
    claimant: address,
    approved: bool,
    claimed: bool,
    status: u8,
    expires_at_ms: u64,
    claim_expires_at_ms: u64,
    created_at_ms: u64,
    updated_at_ms: u64,
}

public struct ActionAnchored has copy, drop {
    trace_id: vector<u8>,
    action_hash: vector<u8>,
    proposal_hash: vector<u8>,
    decision_hash: vector<u8>,
    owner: address,
    authorized_executor: address,
    approved: bool,
    expires_at_ms: u64,
    timestamp_ms: u64,
}

public struct ActionClaimed has copy, drop {
    action_hash: vector<u8>,
    claimant: address,
    claim_expires_at_ms: u64,
    timestamp_ms: u64,
}

public struct ActionCompleted has copy, drop {
    action_hash: vector<u8>,
    receipt_hash: vector<u8>,
    claimant: address,
    status: u8,
    timestamp_ms: u64,
}

public fun create_registry(ctx: &mut sui::tx_context::TxContext): Registry {
    Registry {
        id: sui::object::new(ctx),
        owner: sui::tx_context::sender(ctx),
        anchors: sui::table::new(ctx),
    }
}

public fun create_shared_registry(ctx: &mut sui::tx_context::TxContext) {
    let registry = create_registry(ctx);
    sui::transfer::share_object(registry);
}

public fun anchor_action(
    registry: &mut Registry,
    trace_id: vector<u8>,
    action_hash: vector<u8>,
    proposal_hash: vector<u8>,
    decision_hash: vector<u8>,
    approved: bool,
    authorized_executor: address,
    expires_at_ms: u64,
    clock: &sui::clock::Clock,
    ctx: &mut sui::tx_context::TxContext,
) {
    let now = sui::clock::timestamp_ms(clock);
    assert!(sui::tx_context::sender(ctx) == registry.owner, E_UNAUTHORIZED_OWNER);
    assert!(authorized_executor != @0x0, E_INVALID_AUTHORIZED_EXECUTOR);
    assert!(expires_at_ms > now, E_EXPIRED);
    let trace_id_event = copy trace_id;
    let action_hash_event = copy action_hash;
    let proposal_hash_event = copy proposal_hash;
    let decision_hash_event = copy decision_hash;
    let owner = registry.owner;
    let anchor = Anchor {
        trace_id,
        action_hash: action_hash,
        proposal_hash,
        decision_hash,
        receipt_hash: vector[],
        owner,
        authorized_executor,
        claimant: @0x0,
        approved,
        claimed: false,
        status: STATUS_ANCHORED,
        expires_at_ms,
        claim_expires_at_ms: 0,
        created_at_ms: now,
        updated_at_ms: now,
    };
    sui::table::add(&mut registry.anchors, action_hash, anchor);
    sui::event::emit(ActionAnchored {
        trace_id: trace_id_event,
        action_hash: action_hash_event,
        proposal_hash: proposal_hash_event,
        decision_hash: decision_hash_event,
        owner,
        authorized_executor,
        approved,
        expires_at_ms,
        timestamp_ms: now,
    });
}

public fun claim_action(
    registry: &mut Registry,
    action_hash: vector<u8>,
    claim_lease_ms: u64,
    clock: &sui::clock::Clock,
    ctx: &mut sui::tx_context::TxContext,
) {
    let action_hash_event = copy action_hash;
    let anchor = sui::table::borrow_mut(&mut registry.anchors, action_hash);
    let now = sui::clock::timestamp_ms(clock);
    let sender = sui::tx_context::sender(ctx);
    assert!(anchor.approved, E_NOT_APPROVED);
    assert!(sender == anchor.authorized_executor, E_UNAUTHORIZED_EXECUTOR);
    assert!(claim_lease_ms > 0, E_INVALID_CLAIM_LEASE);
    assert!(anchor.expires_at_ms > now, E_EXPIRED);
    if (anchor.claimed) {
        assert!(anchor.claim_expires_at_ms <= now, E_ALREADY_CLAIMED);
    };
    anchor.claimed = true;
    anchor.claimant = sender;
    anchor.status = STATUS_CLAIMED;
    anchor.claim_expires_at_ms = now + claim_lease_ms;
    anchor.updated_at_ms = now;
    sui::event::emit(ActionClaimed {
        action_hash: action_hash_event,
        claimant: sender,
        claim_expires_at_ms: anchor.claim_expires_at_ms,
        timestamp_ms: now,
    });
}

public fun complete_action(
    registry: &mut Registry,
    action_hash: vector<u8>,
    receipt_hash: vector<u8>,
    clock: &sui::clock::Clock,
    ctx: &mut sui::tx_context::TxContext,
) {
    let action_hash_event = copy action_hash;
    let receipt_hash_event = copy receipt_hash;
    let anchor = sui::table::borrow_mut(&mut registry.anchors, action_hash);
    let now = sui::clock::timestamp_ms(clock);
    let sender = sui::tx_context::sender(ctx);
    assert!(anchor.claimed, E_NOT_CLAIMED);
    assert!(anchor.status == STATUS_CLAIMED, E_ALREADY_COMPLETED);
    assert!(sender == anchor.claimant, E_UNAUTHORIZED_CLAIMANT);
    assert!(anchor.expires_at_ms > now, E_EXPIRED);
    assert!(anchor.claim_expires_at_ms > now, E_CLAIM_EXPIRED);
    anchor.receipt_hash = receipt_hash;
    anchor.status = STATUS_EXECUTED;
    anchor.updated_at_ms = now;
    sui::event::emit(ActionCompleted {
        action_hash: action_hash_event,
        receipt_hash: receipt_hash_event,
        claimant: sender,
        status: STATUS_EXECUTED,
        timestamp_ms: now,
    });
}

public fun fail_action(
    registry: &mut Registry,
    action_hash: vector<u8>,
    receipt_hash: vector<u8>,
    clock: &sui::clock::Clock,
    ctx: &mut sui::tx_context::TxContext,
) {
    let action_hash_event = copy action_hash;
    let receipt_hash_event = copy receipt_hash;
    let anchor = sui::table::borrow_mut(&mut registry.anchors, action_hash);
    let now = sui::clock::timestamp_ms(clock);
    let sender = sui::tx_context::sender(ctx);
    assert!(anchor.claimed, E_NOT_CLAIMED);
    assert!(anchor.status == STATUS_CLAIMED, E_ALREADY_COMPLETED);
    assert!(sender == anchor.claimant, E_UNAUTHORIZED_CLAIMANT);
    assert!(anchor.expires_at_ms > now, E_EXPIRED);
    assert!(anchor.claim_expires_at_ms > now, E_CLAIM_EXPIRED);
    anchor.receipt_hash = receipt_hash;
    anchor.status = STATUS_FAILED;
    anchor.updated_at_ms = now;
    sui::event::emit(ActionCompleted {
        action_hash: action_hash_event,
        receipt_hash: receipt_hash_event,
        claimant: sender,
        status: STATUS_FAILED,
        timestamp_ms: now,
    });
}
