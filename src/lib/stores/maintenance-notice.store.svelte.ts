// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/stores/maintenance-notice.store.svelte.ts

export interface MaintenanceNotice {
    id: string;
    message: string;
    endsAt: number; // epoch ms (client-clock-anchored after set())
    createdBy: string;
    createdAt: number;
}

/** Wire shape received from SSE/API — includes optional remainingMs for clock-skew safety. */
export interface MaintenanceNoticeWire extends MaintenanceNotice {
    remainingMs?: number;
}

class MaintenanceNoticeStore {
    notice = $state<MaintenanceNotice | null>(null);

    set(wire: MaintenanceNoticeWire): void {
        // If remainingMs is present, anchor endsAt to the local clock so
        // server/client clock skew cannot silently drop the notice.
        // If remainingMs <= 0 the notice is already expired — skip.
        if (wire.remainingMs !== undefined) {
            if (wire.remainingMs <= 0) return;
            // Dedupe: if same id is already set, no-op
            if (this.notice?.id === wire.id) return;
            this.notice = {
                id: wire.id,
                message: wire.message,
                endsAt: Date.now() + wire.remainingMs,
                createdBy: wire.createdBy,
                createdAt: wire.createdAt,
            };
            return;
        }
        // Fallback: no remainingMs (old server / rollback). Use server endsAt.
        if (wire.endsAt <= Date.now()) return;
        if (this.notice?.id === wire.id) return;
        this.notice = {
            id: wire.id,
            message: wire.message,
            endsAt: wire.endsAt,
            createdBy: wire.createdBy,
            createdAt: wire.createdAt,
        };
    }

    clear(): void {
        this.notice = null;
    }
}

export const maintenanceNotice = new MaintenanceNoticeStore();
