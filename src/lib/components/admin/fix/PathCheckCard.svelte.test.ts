// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The card's reassurances are MEASURED claims. These pin that each one is made
 * only when its measurement exists: "nothing has been deleted" needs an item
 * count, "never scanned" needs a scanner-runs read, and "you added it after
 * the scan" needs a scan that finished cleanly.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';
import PathCheckCard from './PathCheckCard.svelte';
import type { ScanPathReport } from './library-scan-check.schema.js';

function report(overrides: Partial<ScanPathReport> = {}): ScanPathReport {
    return {
        id: 'p1',
        path: '/media/movies',
        mediaType: 'movie',
        provider: 'local',
        enabled: true,
        libraryName: 'Movies',
        libraryItemCount: 12,
        probe: { state: 'ok', ownerUid: 1000, ownerGid: 1000, mode: '0755', detail: null },
        lastScanUnreadable: false,
        lastScan: null,
        ...overrides,
    };
}

const SCAN = {
    startedAt: '2026-10-06T10:00:00.000Z',
    completedAt: '2026-10-06T10:05:00.000Z',
    totalFiles: 40,
    added: 0,
    updated: 0,
    unmatched: 0,
    errors: 0,
    running: false,
    abandoned: false,
};

function show(r: ScanPathReport): void {
    render(PathCheckCard, { props: { report: r, processUid: 1000, processGid: 1000 } });
}

const missing = {
    state: 'missing' as const,
    ownerUid: null,
    ownerGid: null,
    mode: null,
    detail: 'ENOENT',
};

afterEach(() => cleanup());

describe('PathCheckCard', () => {
    it('a missing folder with a measured count says nothing was deleted', () => {
        show(report({ probe: missing }));
        expect(screen.getByText(m.admin_fix_files_missing_safe_heading())).toBeTruthy();
        expect(screen.getByText(m.admin_fix_files_missing_safe_count({ count: 12 }))).toBeTruthy();
    });

    it('a missing folder with no count makes no "nothing deleted" claim', () => {
        show(report({ probe: missing, libraryItemCount: null }));
        expect(screen.queryByText(m.admin_fix_files_missing_safe_heading())).toBeNull();
        expect(screen.queryByText(m.admin_fix_files_missing_empty())).toBeNull();
        expect(screen.getByText(m.admin_fix_files_missing_count_unknown())).toBeTruthy();
    });

    it('a failed scanner-runs read is not "never scanned"', () => {
        show(report({ lastScanUnreadable: true }));
        expect(screen.queryByText(m.admin_fix_files_last_scan_none())).toBeNull();
        expect(screen.getByText(m.admin_fix_files_last_scan_unreadable())).toBeTruthy();
    });

    it('a clean scan that added nothing gets the "added after the scan" hint', () => {
        show(report({ lastScan: SCAN }));
        expect(screen.getByText(m.admin_fix_files_last_scan_zero_added())).toBeTruthy();
    });

    it.each([
        ['abandoned', { abandoned: true }],
        ['erroring', { errors: 3 }],
        ['running', { running: true, completedAt: null }],
    ])('a %s scan does not get the "added after the scan" hint', (_label, over) => {
        show(report({ lastScan: { ...SCAN, ...over } }));
        expect(screen.queryByText(m.admin_fix_files_last_scan_zero_added())).toBeNull();
    });

    describe('a held stale cleanup', () => {
        const HOLD = {
            reason: 'few_files' as const,
            walked: 3,
            known: 40,
            firstHeldAt: '2026-10-19T08:00:00.000Z',
            lastHeldAt: '2026-10-20T08:00:00.000Z',
        };

        it('says what the scan found and offers to remove the missing files', () => {
            show(report({ cleanupHold: HOLD }));
            expect(screen.getByText(m.admin_fix_files_hold_heading())).toBeTruthy();
            expect(
                screen.getByRole('button', { name: m.admin_fix_files_hold_button() }),
            ).toBeTruthy();
        });

        it('confirms the hold it shows (its walk count) after a second click', async () => {
            const fetchMock = vi.fn(
                async () =>
                    new Response(JSON.stringify({ confirmed: true }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
            );
            vi.stubGlobal('fetch', fetchMock);
            const onchanged = vi.fn();
            render(PathCheckCard, {
                props: {
                    report: report({ cleanupHold: HOLD }),
                    processUid: 1,
                    processGid: 1,
                    onchanged,
                },
            });
            await fireEvent.click(
                screen.getByRole('button', { name: m.admin_fix_files_hold_button() }),
            );
            expect(fetchMock).not.toHaveBeenCalled();
            expect(screen.getByText(m.admin_fix_files_hold_confirm({ missing: 37 }))).toBeTruthy();
            await fireEvent.click(
                screen.getByRole('button', { name: m.admin_fix_files_hold_confirm_yes() }),
            );
            await vi.waitFor(() => expect(onchanged).toHaveBeenCalled());
            const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            expect(url).toContain('/api/admin/fix/library-cleanup-confirm');
            expect(JSON.parse(String(init.body))).toEqual({ libraryPathId: 'p1', walked: 3 });
            vi.unstubAllGlobals();
        });

        it('a confirmed hold shows no button', () => {
            show(report({ cleanupHold: { ...HOLD, confirmedAt: '2026-10-20T09:00:00.000Z' } }));
            expect(screen.getByText(m.admin_fix_files_hold_confirmed())).toBeTruthy();
            expect(
                screen.queryByRole('button', { name: m.admin_fix_files_hold_button() }),
            ).toBeNull();
        });
    });
});
