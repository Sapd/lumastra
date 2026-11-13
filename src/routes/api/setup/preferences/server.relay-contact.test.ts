// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The setup wizard's "contact lumastra.org" toggle (the push relay token). It
 * is a privacy opt-out, so only a real boolean is written: a malformed value
 * keeps what is in force instead of quietly turning it back on (or off).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSaveConfig = vi.fn().mockResolvedValue(undefined);

vi.mock('$lib/server/config/config.service.js', () => ({
    saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
}));
vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

function call(body: unknown): Promise<Response> {
    return import('./+server.js').then(({ POST }) =>
        (POST as (event: unknown) => Promise<Response>)({
            request: new Request('http://localhost/test', {
                method: 'POST',
                body: JSON.stringify(body),
            }),
        }),
    );
}

/** The config updates of the last save (the first argument). */
function saved(): Record<string, unknown> {
    return (mockSaveConfig.mock.calls.at(-1)?.[0] ?? {}) as Record<string, unknown>;
}

describe('POST /api/setup/preferences — the retired check-in field', () => {
    it('is ignored: nothing is written for it', async () => {
        vi.clearAllMocks();
        await call({ licenseCheckIn: false, gravatar: true });
        expect(Object.keys(saved())).not.toContain('LICENSE_CHECK_IN_ENABLED');
    });
});

describe('POST /api/setup/preferences — licenseServerContact', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([true, false])('writes LICENSE_SERVER_CONTACT_ENABLED=%s', async (value) => {
        await call({ licenseServerContact: value });
        expect(saved()).toEqual({ LICENSE_SERVER_CONTACT_ENABLED: value });
    });

    it.each(['false', 'yes', 0, null])(
        'leaves the setting alone for a non-boolean value (%s)',
        async (value) => {
            await call({ licenseServerContact: value, gravatar: true });
            expect('LICENSE_SERVER_CONTACT_ENABLED' in saved()).toBe(false);
        },
    );
});

describe('POST /api/setup/preferences — the contact answer is stored even when on', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([true, false])('pins LICENSE_SERVER_CONTACT_ENABLED=%s', async (value) => {
        await call({ licenseServerContact: value });
        const options = mockSaveConfig.mock.calls.at(-1)?.[1] as { pinKeys?: string[] } | undefined;
        expect(options?.pinKeys).toContain('LICENSE_SERVER_CONTACT_ENABLED');
    });

    it('CONTROL: a save without the switch does not pin it', async () => {
        await call({ gravatar: true });
        const options = mockSaveConfig.mock.calls.at(-1)?.[1] as { pinKeys?: string[] } | undefined;
        expect(options?.pinKeys ?? []).not.toContain('LICENSE_SERVER_CONTACT_ENABLED');
    });
});
