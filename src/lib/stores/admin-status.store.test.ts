// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for mergePayload — the patch-never-replace rule (spec §5).
 * Array items keep OBJECT IDENTITY across refreshes when unchanged, so keyed
 * each-blocks keep their DOM and lists never rebuild under the user's cursor.
 */

import { describe, it, expect } from 'vitest';
import { mergePayload } from './admin-status.store.svelte';
import type { AdminStatusPayload } from '$lib/schemas/api-admin-status-payload';
import type { AttentionItem } from '$lib/schemas/api-attention-responses';
import { withAttentionDomain } from '$lib/shared/attention-domain';

function attentionItem(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
    return {
        id,
        fingerprint: 'fp',
        type: 'degraded-component',
        severity: 'warning',
        title: `title ${id}`,
        actions: [],
        firstSeen: '2026-01-01T00:00:00Z',
        lastSeen: '2026-01-01T00:00:00Z',
        acked: false,
        ...over,
    };
}

function payload(items: AttentionItem[]): AdminStatusPayload {
    return {
        generatedAt: '2026-01-01T00:00:00Z',
        verdict: 'degraded',
        attention: {
            // `domain` is optional on the producing side and required on the wire —
            // `withAttentionDomain` is the same bridge the real payload boundary uses.
            items: items.map(withAttentionDomain),
            unreadCount: items.filter((i) => !i.acked).length,
        },
        system: {} as AdminStatusPayload['system'],
        sessions: { count: 0, preview: [] },
        tasks: { running: 0, ranToday: 0, failedRuns24h: 0 },
        library: { totalItems: 0 },
        users: { total: 0 },
        sectionStatus: {
            home: 'healthy',
            library: 'healthy',
            tasks: 'healthy',
            system: 'degraded',
            users: 'healthy',
            settings: 'healthy',
            developer: 'healthy',
        },
    };
}

describe('mergePayload', () => {
    it('returns next unchanged when there is no previous payload', () => {
        const next = payload([attentionItem('a')]);
        expect(mergePayload(null, next)).toBe(next);
    });

    it('preserves object identity for unchanged items', () => {
        const prev = payload([attentionItem('a'), attentionItem('b')]);
        const next = payload([attentionItem('a'), attentionItem('b')]);
        const merged = mergePayload(prev, next);
        expect(merged.attention.items[0]).toBe(prev.attention.items[0]);
        expect(merged.attention.items[1]).toBe(prev.attention.items[1]);
        // Fully-unchanged array keeps the previous ARRAY reference too.
        expect(merged.attention.items).toBe(prev.attention.items);
    });

    it('swaps in only the changed item, keeping the rest identical', () => {
        const prev = payload([attentionItem('a'), attentionItem('b')]);
        const next = payload([attentionItem('a'), attentionItem('b', { acked: true })]);
        const merged = mergePayload(prev, next);
        expect(merged.attention.items[0]).toBe(prev.attention.items[0]);
        expect(merged.attention.items[1]).not.toBe(prev.attention.items[1]);
        expect(merged.attention.items[1].acked).toBe(true);
        expect(merged.attention.items).not.toBe(prev.attention.items);
    });

    it('handles added and removed items (list follows next)', () => {
        const prev = payload([attentionItem('a'), attentionItem('gone')]);
        const next = payload([attentionItem('a'), attentionItem('new')]);
        const merged = mergePayload(prev, next);
        expect(merged.attention.items.map((i) => i.id)).toEqual(['a', 'new']);
        expect(merged.attention.items[0]).toBe(prev.attention.items[0]);
    });

    it('preserves session preview identity by sessionId', () => {
        const prev = payload([]);
        prev.sessions = {
            count: 1,
            preview: [{ sessionId: 's1', username: 'alice', title: 'Movie' }],
        };
        const next = payload([]);
        next.sessions = {
            count: 2,
            preview: [
                { sessionId: 's1', username: 'alice', title: 'Movie' },
                { sessionId: 's2', username: 'bob', title: 'Show' },
            ],
        };
        const merged = mergePayload(prev, next);
        expect(merged.sessions.count).toBe(2);
        expect(merged.sessions.preview[0]).toBe(prev.sessions.preview[0]);
        expect(merged.sessions.preview[1]).toBe(next.sessions.preview[1]);
    });

    it('takes scalar blocks (verdict, counters, sectionStatus) from next', () => {
        const prev = payload([attentionItem('a', { severity: 'critical' })]);
        const next = payload([]);
        next.verdict = 'healthy';
        next.tasks = { running: 3, ranToday: 42, failedRuns24h: 1 };
        const merged = mergePayload(prev, next);
        expect(merged.verdict).toBe('healthy');
        expect(merged.tasks.ranToday).toBe(42);
    });
});
