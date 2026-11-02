// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Fixed implementation gates, not caller assertions or environment switches.
// Removing a gate requires implementing and testing that mutation boundary.
const blockers = Object.freeze([
    'Existing recovery and administrative task writers are not all covered by original-generation fences.',
    'BullMQ publication, queue events, direct recovery writers and cross-store mirror recovery lack a coherent handoff fence.',
    'Plugin raw SQL, external effects and descendant processes require audited quiescence.',
    'Coherent task queue/dependency partition activation has not been qualified.',
]);
export function getRustOwnershipBlockers(): readonly string[] {
    return blockers;
}
export class RustOwnershipBlockedError extends Error {
    readonly code = 'activation_blocked';
    constructor() {
        super('Rust task ownership remains blocked by unqualified mutation and drain boundaries');
        this.name = 'RustOwnershipBlockedError';
    }
}
export function assertRustOwnershipReady(): never {
    throw new RustOwnershipBlockedError();
}
