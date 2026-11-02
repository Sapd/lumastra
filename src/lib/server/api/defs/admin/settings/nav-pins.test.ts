// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/nav-pins — what may be pinned, and the 10-pin cap.
 *
 * A pin outside the nav manifest used to be stored, then hidden by the admin
 * layout on every load: invisible, impossible to unpin from the UI, and still
 * counted toward the cap. And because the insert is an upsert on href, a
 * re-pin at the cap was refused although it would not add a row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetNavPins = vi.fn();
const mockAddNavPin = vi.fn();
vi.mock('$lib/server/database/queries/index.js', () => ({
    getNavPins: { all: (...a: unknown[]) => mockGetNavPins(...a) },
    addNavPin: { execute: (...a: unknown[]) => mockAddNavPin(...a) },
    removeNavPin: { all: vi.fn() },
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

const { def } = await import('./nav-pins.js');

function post(body: unknown): Promise<Response> {
    const event = {
        request: new Request('http://localhost/api/admin/nav-pins', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    } as unknown as RequestEvent;
    return def.handlers.POST!(event, {} as never) as Promise<Response>;
}

function rows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
        href: `/admin/page-${i}`,
        label: `Page ${i}`,
        sort_order: i,
        created_at: new Date(),
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetNavPins.mockResolvedValue([]);
    mockAddNavPin.mockResolvedValue(undefined);
});

describe('POST /api/admin/nav-pins', () => {
    it('pins a nav-manifest page', async () => {
        const res = await post({ href: '/admin/users', label: 'Users' });

        expect(res.status).toBe(200);
        expect(mockAddNavPin).toHaveBeenCalledWith(expect.anything(), {
            href: '/admin/users',
            label: 'Users',
        });
    });

    it('refuses a page outside the nav manifest (it would be hidden on load)', async () => {
        const res = await post({ href: '/admin/library/quarantine', label: 'Quarantine' });

        expect(res.status).toBe(422);
        expect(mockAddNavPin).not.toHaveBeenCalled();
    });

    it('refuses a dot-segment path that only looks like an admin page', async () => {
        const res = await post({ href: '/admin/../logout', label: 'x' });

        expect(res.status).toBe(422);
        expect(mockAddNavPin).not.toHaveBeenCalled();
    });

    it('refuses a NEW pin at the cap', async () => {
        mockGetNavPins.mockResolvedValue(rows(10));

        const res = await post({ href: '/admin/users', label: 'Users' });

        expect(res.status).toBe(422);
        expect(mockAddNavPin).not.toHaveBeenCalled();
    });

    it('accepts a re-pin of an existing href at the cap (an upsert adds no row)', async () => {
        mockGetNavPins.mockResolvedValue([
            ...rows(9),
            { href: '/admin/users', label: 'Old', sort_order: 9, created_at: new Date() },
        ]);

        const res = await post({ href: '/admin/users', label: 'Users' });

        expect(res.status).toBe(200);
        expect(mockAddNavPin).toHaveBeenCalled();
    });
});
