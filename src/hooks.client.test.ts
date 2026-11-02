// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the client-side handleError hook (H19).
 *
 * Run: npx vitest run src/hooks.client.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleError } from './hooks.client.js';
import type { NavigationEvent } from '@sveltejs/kit';

function makeEvent(routeId: string | null = '/foo'): NavigationEvent {
    return {
        params: {},
        route: { id: routeId },
        url: new URL('http://localhost/foo'),
    } as unknown as NavigationEvent;
}

describe('hooks.client handleError', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('returns a sanitized message and a stable errorId', async () => {
        const err = new Error('secret internal detail');
        const result = await handleError({
            error: err,
            event: makeEvent(),
            status: 500,
            message: 'Internal Error',
        });

        expect(result).toBeDefined();
        expect(typeof result?.message).toBe('string');
        expect(result?.message).toBe('Internal Error');
        expect(result?.errorId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('falls back to a generic message when none is provided', async () => {
        const result = await handleError({
            error: new Error('boom'),
            event: makeEvent(),
            status: 500,
            message: '',
        });

        expect(result?.message).toBe('An unexpected error occurred');
    });

    it('logs the error', async () => {
        await handleError({
            error: new Error('boom'),
            event: makeEvent('/bar'),
            status: 500,
            message: 'Internal Error',
        });

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        const [logMessage, context] = consoleErrorSpy.mock.calls[0] as [
            string,
            Record<string, unknown>,
        ];
        expect(logMessage).toMatch(/error/i);
        expect(context.routeId).toBe('/bar');
    });

    it('generates a distinct errorId per call', async () => {
        const a = await handleError({
            error: new Error('one'),
            event: makeEvent(),
            status: 500,
            message: 'x',
        });
        const b = await handleError({
            error: new Error('two'),
            event: makeEvent(),
            status: 500,
            message: 'x',
        });

        expect(a?.errorId).toBeDefined();
        expect(a?.errorId).not.toBe(b?.errorId);
    });
});

// ── Server reporting ─────────────────────────────────────────────────────────
//
// The errorId is rendered on both error pages with a line asking the user to
// quote it. Before this, the id went to console.error and nowhere else, so a
// quoted id matched nothing an operator could search. These tests pin the half
// that makes the visible half worth showing.

describe('hooks.client handleError — server reporting', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let sendBeacon: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        sendBeacon = vi.fn(() => true);
        vi.stubGlobal('navigator', { sendBeacon });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.unstubAllGlobals();
    });

    /** Read back what the beacon was handed, as the endpoint would parse it. */
    async function sentPayload(): Promise<Record<string, unknown>> {
        const blob = sendBeacon.mock.calls[0]?.[1] as Blob;
        return JSON.parse(await blob.text()) as Record<string, unknown>;
    }

    it('beacons the same errorId it returns to the page', async () => {
        const result = await handleError({
            error: new Error('boom'),
            event: makeEvent('/watch/[itemId]'),
            status: 500,
            message: 'Internal Error',
        });

        expect(sendBeacon).toHaveBeenCalledTimes(1);
        expect(String(sendBeacon.mock.calls[0][0])).toContain('/client-errors');

        // Load-bearing: a report carrying a DIFFERENT id than the page shows is
        // worse than no report — it looks correlatable and is not.
        const payload = await sentPayload();
        expect(payload.errorId).toBe(result?.errorId);
        expect(payload.routeId).toBe('/watch/[itemId]');
        expect(payload.status).toBe(500);
        expect(payload.name).toBe('Error');
        expect(payload.message).toBe('boom');
        expect(typeof payload.stack).toBe('string');
    });

    it('sends the path only, never the query string', async () => {
        // Search terms are user content. The endpoint re-does this reduction,
        // but the client must not put them on the wire in the first place.
        vi.stubGlobal('location', {
            pathname: '/search',
            search: '?q=something+private',
            href: 'http://localhost/search?q=something+private',
        });

        await handleError({
            error: new Error('boom'),
            event: makeEvent('/search'),
            status: 500,
            message: 'Internal Error',
        });

        const payload = await sentPayload();
        expect(payload.url).toBe('/search');
        expect(JSON.stringify(payload)).not.toContain('something+private');
    });

    it('sends the route template and scrubs credentials out of the error text', async () => {
        vi.stubGlobal('location', {
            pathname: '/media/6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11',
            origin: 'http://localhost',
        });
        const err = new Error('GET /api/stream/x.m3u8?grant=GRANTSECRET failed');
        err.stack = 'Error: x\n    at f (http://localhost/_app/a.js?api_key=KEYSECRET:1:2)';

        await handleError({
            error: err,
            event: makeEvent('/(app)/media/[id]'),
            status: 500,
            message: 'Internal Error',
        });

        const payload = await sentPayload();
        expect(payload.url).toBe('/(app)/media/[id]');
        const wire = JSON.stringify(payload);
        expect(wire).not.toContain('GRANTSECRET');
        expect(wire).not.toContain('KEYSECRET');
        expect(wire).not.toContain('6f1c1e0a');
    });

    it('still returns an errorId when sendBeacon throws', async () => {
        // A handleError that throws replaces a useful error page with a blank
        // one. Reporting must never be able to cause that.
        sendBeacon.mockImplementation(() => {
            throw new Error('beacon unavailable');
        });

        const result = await handleError({
            error: new Error('boom'),
            event: makeEvent(),
            status: 500,
            message: 'Internal Error',
        });

        expect(result?.errorId).toBeTruthy();
    });

    it('does not throw when navigator has no sendBeacon at all', async () => {
        // Some embedded webviews ship without it.
        vi.stubGlobal('navigator', {});

        const result = await handleError({
            error: new Error('boom'),
            event: makeEvent(),
            status: 500,
            message: 'Internal Error',
        });

        expect(result?.errorId).toBeTruthy();
    });

    it('reports a non-Error throw without losing the id', async () => {
        const result = await handleError({
            error: 'a bare string',
            event: makeEvent(),
            status: 500,
            message: 'Internal Error',
        });

        const payload = await sentPayload();
        expect(payload.errorId).toBe(result?.errorId);
        expect(payload.message).toBe('a bare string');
    });
});
