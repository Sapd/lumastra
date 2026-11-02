// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for maintenance-notice.store.svelte.ts
 *
 * Covers the clock-skew-safe set() semantics introduced with remainingMs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the store module under test. Because the file uses Svelte $state runes
// we run these tests without mounting a component — the class can be
// instantiated directly in a plain Node/vitest context as long as Svelte 5
// runes are available (vitest is configured with the svelte plugin).
import { maintenanceNotice, type MaintenanceNoticeWire } from './maintenance-notice.store.svelte';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeWire(overrides: Partial<MaintenanceNoticeWire> = {}): MaintenanceNoticeWire {
    return {
        id: 'test-id',
        message: 'Scheduled maintenance',
        endsAt: Date.now() + 60_000,
        createdBy: 'admin',
        createdAt: Date.now() - 1000,
        ...overrides,
    };
}

beforeEach(() => {
    maintenanceNotice.clear();
});

afterEach(() => {
    vi.useRealTimers();
});

// ===========================================================================
// set() with remainingMs — client-clock anchoring
// ===========================================================================

describe('set() with remainingMs', () => {
    it('stores endsAt as Date.now() + remainingMs (client-clock anchored)', () => {
        const now = 1_000_000;
        vi.setSystemTime(now);

        const remainingMs = 30_000;
        const wire = makeWire({
            endsAt: now - 999_999, // wildly skewed server endsAt — should be ignored
            remainingMs,
        });

        maintenanceNotice.set(wire);

        expect(maintenanceNotice.notice).not.toBeNull();
        // endsAt must be within a few ms of Date.now() + remainingMs
        const expected = now + remainingMs;
        expect(maintenanceNotice.notice?.endsAt).toBeGreaterThanOrEqual(expected - 5);
        expect(maintenanceNotice.notice?.endsAt).toBeLessThanOrEqual(expected + 5);
    });

    it('does NOT set when remainingMs <= 0', () => {
        maintenanceNotice.set(makeWire({ remainingMs: 0 }));
        expect(maintenanceNotice.notice).toBeNull();

        maintenanceNotice.set(makeWire({ remainingMs: -1 }));
        expect(maintenanceNotice.notice).toBeNull();
    });

    it('dedupes by id — second set() with same id is a no-op', () => {
        const now = 2_000_000;
        vi.setSystemTime(now);

        maintenanceNotice.set(makeWire({ id: 'dupe', remainingMs: 30_000 }));
        const firstEndsAt = maintenanceNotice.notice?.endsAt;

        // Advance clock so a fresh set would produce a different endsAt
        vi.setSystemTime(now + 5_000);
        maintenanceNotice.set(makeWire({ id: 'dupe', remainingMs: 30_000 }));

        // Should still have the first endsAt
        expect(maintenanceNotice.notice?.endsAt).toBe(firstEndsAt);
    });
});

// ===========================================================================
// set() without remainingMs — fallback to server endsAt
// ===========================================================================

describe('set() without remainingMs (fallback path)', () => {
    it('uses server endsAt when remainingMs is absent', () => {
        const futureEndsAt = Date.now() + 60_000;
        maintenanceNotice.set(makeWire({ endsAt: futureEndsAt, remainingMs: undefined }));

        expect(maintenanceNotice.notice).not.toBeNull();
        expect(maintenanceNotice.notice?.endsAt).toBe(futureEndsAt);
    });

    it('does not set when server endsAt is in the past', () => {
        maintenanceNotice.set(makeWire({ endsAt: Date.now() - 1, remainingMs: undefined }));
        expect(maintenanceNotice.notice).toBeNull();
    });

    it('dedupes by id in fallback path', () => {
        const endsAt = Date.now() + 60_000;
        maintenanceNotice.set(makeWire({ id: 'fb-dupe', endsAt, remainingMs: undefined }));
        maintenanceNotice.set(
            makeWire({
                id: 'fb-dupe',
                endsAt: endsAt + 5_000,
                remainingMs: undefined,
            }),
        );

        // Still has the first endsAt
        expect(maintenanceNotice.notice?.endsAt).toBe(endsAt);
    });
});

// ===========================================================================
// clear()
// ===========================================================================

describe('clear()', () => {
    it('resets notice to null', () => {
        maintenanceNotice.set(makeWire({ remainingMs: 30_000 }));
        expect(maintenanceNotice.notice).not.toBeNull();

        maintenanceNotice.clear();
        expect(maintenanceNotice.notice).toBeNull();
    });

    it('is safe to call when no notice is set', () => {
        expect(() => maintenanceNotice.clear()).not.toThrow();
    });
});

// ===========================================================================
// Dedup across two consecutive set() calls with different ids
// ===========================================================================

describe('dedup by id across two different notices', () => {
    it('replaces notice when a different id arrives', () => {
        maintenanceNotice.set(makeWire({ id: 'notice-a', remainingMs: 30_000 }));
        expect(maintenanceNotice.notice?.id).toBe('notice-a');

        maintenanceNotice.set(makeWire({ id: 'notice-b', remainingMs: 20_000 }));
        expect(maintenanceNotice.notice?.id).toBe('notice-b');
    });
});
