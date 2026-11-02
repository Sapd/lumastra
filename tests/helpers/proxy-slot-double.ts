// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';
export function createMockFfmpegManager() {
    return { spawn: vi.fn(), stop: vi.fn() };
}
interface Join {
    viewerId: string;
    sourceId: string;
    maxStreams: number;
    channelName: string;
}
interface Slot {
    request: Join;
    viewers: Set<string>;
}
/** App priority-service test double. No HTTP server, media, timers or production routing. */
export class ProxySlotDouble {
    private slots = new Map<string, Slot>();
    constructor(private ingest: ReturnType<typeof createMockFfmpegManager>) {}
    async join(
        channelId: string,
        request: Join,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
        let slot = this.slots.get(channelId);
        if (!slot) {
            for (const [id, entry] of this.slots)
                if (entry.request.sourceId === request.sourceId && entry.viewers.size === 0) {
                    this.slots.delete(id);
                    await this.ingest.stop(id);
                }
            const active = [...this.slots].filter(
                ([, entry]) => entry.request.sourceId === request.sourceId,
            );
            if (active.length >= request.maxStreams)
                return {
                    status: 429,
                    body: {
                        error: 'stream_limit_reached',
                        limit: request.maxStreams,
                        active: active.map(([id, entry]) => ({
                            channelId: id,
                            channelName: entry.request.channelName,
                            viewers: entry.viewers.size,
                        })),
                    },
                };
            await this.ingest.spawn(channelId, request);
            slot = { request, viewers: new Set() };
            this.slots.set(channelId, slot);
        }
        slot.viewers.add(request.viewerId);
        return { status: 200, body: { success: true } };
    }
    async leave(channelId: string, viewerId: string) {
        this.slots.get(channelId)?.viewers.delete(viewerId);
        return { success: true };
    }
    heartbeat(channelId: string, viewerId: string) {
        return this.slots.get(channelId)?.viewers.has(viewerId)
            ? { success: true }
            : { error: 'viewer_not_found' };
    }
    getStatusData() {
        return {
            channels: [...this.slots].map(([channelId, entry]) => ({
                channelId,
                channelName: entry.request.channelName,
                sourceId: entry.request.sourceId,
                viewers: entry.viewers.size,
            })),
        };
    }
    async stopAll(): Promise<void> {
        this.slots.clear();
    }
    stopOrphanCleanup(): void {}
}
