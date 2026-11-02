// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `/app/[url]`'s load function.
 *
 * Security review 2026-09-13, C18: the route only frames an admin-configured
 * external origin (validated in `$lib/server/embed-allowlist.ts`). Its
 * `frame-src` grant lives in the DOCUMENT-wide CSP (hooks.server.ts), not in a
 * header set here: the dock reaches this route by client-side `goto()`, which
 * fetches only `__data.json`, so a route-scoped CSP header never reached the
 * page and the iframe was blocked until a full reload.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const configValues: Record<string, unknown> = {};

vi.mock('$lib/server/config/config.service', () => ({
    get: (key: string) => configValues[key],
}));

import { load } from './+page.server.js';

type LoadEvent = Parameters<typeof load>[0];

function makeEvent(rawUrl: string): { event: LoadEvent; setHeaders: ReturnType<typeof vi.fn> } {
    const setHeaders = vi.fn();
    const event = {
        params: { url: encodeURIComponent(rawUrl) },
        setHeaders,
    } as unknown as LoadEvent;
    return { event, setHeaders };
}

beforeEach(() => {
    configValues.SIDEBAR_LINKS = [{ url: 'https://intranet.example.com', external: true }];
    configValues.USER_MENU_LINKS = [];
    configValues.FOOTER_LINKS = [];
});

describe('C18 — /app/[url] validates the target against the configured links', () => {
    it('returns the normalized URL for an allowed target and sets no CSP of its own', async () => {
        const { event, setHeaders } = makeEvent('https://intranet.example.com/dashboard');

        const result = await load(event);

        expect(result).toEqual({ url: 'https://intranet.example.com/dashboard' });
        expect(setHeaders).not.toHaveBeenCalled();
    });

    it('404s a target outside the allowlist', async () => {
        const { event } = makeEvent('https://evil.example.com/');

        await expect(load(event)).rejects.toMatchObject({ status: 404 });
    });
});
