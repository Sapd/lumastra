// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDisplayPreferencesRowExists = vi.fn();
const mockCountDisplayPreferencesRowsForUser = vi.fn();
const mockUpsertDisplayPreferences = vi.fn();

vi.mock('$lib/server/database/queries/jellyfin-display-preferences.queries.js', () => ({
    displayPreferencesRowExists: (...args: unknown[]) => mockDisplayPreferencesRowExists(...args),
    countDisplayPreferencesRowsForUser: (...args: unknown[]) =>
        mockCountDisplayPreferencesRowsForUser(...args),
    upsertDisplayPreferences: (...args: unknown[]) => mockUpsertDisplayPreferences(...args),
}));

import {
    checkDisplayPreferencesBodySize,
    validateDisplayPreferencesIdentity,
    enforceDisplayPreferencesRowCap,
    upsertDisplayPreferencesOrTooLarge,
    MAX_DISPLAY_PREFS_BODY_BYTES,
    MAX_DISPLAY_PREFS_ID_LENGTH,
    MAX_DISPLAY_PREFS_ROWS_PER_USER,
} from './display-preferences-guard.js';

function requestWithContentLength(length?: string): Request {
    const headers = new Headers();
    if (length !== undefined) headers.set('content-length', length);
    return new Request('http://localhost/j/DisplayPreferences/x', { headers });
}

describe('checkDisplayPreferencesBodySize', () => {
    it('rejects a declared Content-Length over the cap', () => {
        const res = checkDisplayPreferencesBodySize(
            requestWithContentLength(String(MAX_DISPLAY_PREFS_BODY_BYTES + 1)),
            { small: true },
        );
        expect(res?.status).toBe(413);
    });

    it('accepts a declared Content-Length exactly at the cap with a small parsed body', () => {
        const res = checkDisplayPreferencesBodySize(
            requestWithContentLength(String(MAX_DISPLAY_PREFS_BODY_BYTES)),
            { small: true },
        );
        expect(res).toBeNull();
    });

    it('rejects when Content-Length is absent/lying but the parsed body re-serializes over the cap', () => {
        const res = checkDisplayPreferencesBodySize(requestWithContentLength(undefined), {
            blob: 'x'.repeat(MAX_DISPLAY_PREFS_BODY_BYTES),
        });
        expect(res?.status).toBe(413);
    });

    it('accepts a small body with no Content-Length header', () => {
        const res = checkDisplayPreferencesBodySize(requestWithContentLength(undefined), {
            SortBy: 'SortName',
        });
        expect(res).toBeNull();
    });

    it('rejects a body whose UTF-16 character count is under the cap but whose UTF-8 byte length is over it (CJK)', () => {
        // Each CJK character is 1 UTF-16 code unit (`.length` counts it as 1) but
        // 3 UTF-8 bytes. 25,000 of them: ~25,017 chars (well under the cap) but
        // 75,000 bytes (well over it) — the DB's pg_column_size CHECK counts bytes.
        const parsedBody = { blob: '中'.repeat(25_000) };
        const charLength = JSON.stringify(parsedBody).length;
        expect(charLength).toBeLessThan(MAX_DISPLAY_PREFS_BODY_BYTES);

        const res = checkDisplayPreferencesBodySize(
            requestWithContentLength(undefined),
            parsedBody,
        );
        expect(res?.status).toBe(413);
    });

    it('does not tighten the ASCII case, where byte length equals character length', () => {
        const parsedBody = { blob: 'x'.repeat(MAX_DISPLAY_PREFS_BODY_BYTES - 20) };
        const res = checkDisplayPreferencesBodySize(
            requestWithContentLength(undefined),
            parsedBody,
        );
        expect(res).toBeNull();
    });

    it('rejects a body whose raw UTF-8 bytes sit inside the jsonb-overhead headroom (58KB)', () => {
        // Measured against real PG: a many-small-key object of ~29,787 raw bytes
        // stores as pg_column_size 33,794 (13.4% jsonb overhead — see the fix
        // rationale in the module doc comment). A 58KB body of the same shape
        // family would land close to the DB's 65,536 CHECK once that overhead is
        // applied, so the app-level cap must leave headroom below the raw 64KB
        // DB-sized cap rather than matching it exactly.
        const parsedBody = { blob: 'x'.repeat(58 * 1024) };
        const res = checkDisplayPreferencesBodySize(
            requestWithContentLength(undefined),
            parsedBody,
        );
        expect(res?.status).toBe(413);
    });
});

describe('upsertDisplayPreferencesOrTooLarge', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns null and stores on a clean write', async () => {
        mockUpsertDisplayPreferences.mockResolvedValue(undefined);
        const res = await upsertDisplayPreferencesOrTooLarge({} as never, 'u1', 'id', 'client', {
            SortBy: 'SortName',
        });
        expect(res).toBeNull();
        expect(mockUpsertDisplayPreferences).toHaveBeenCalledOnce();
    });

    it('converts the DB data-size CHECK violation (23514, jellyfin_display_preferences_data_size_check) into a 413', async () => {
        // This is the residual gap the app-level byte cap cannot close: jsonb
        // storage overhead is shape-dependent (a many-tiny-key object can carry
        // several KB of JEntry overhead per measured data), so a body that
        // passes the app-level heuristic can still trip the DB's
        // pg_column_size CHECK. Only catching the CHECK violation itself closes
        // this completely.
        mockUpsertDisplayPreferences.mockRejectedValue(
            Object.assign(new Error('new row for relation violates check constraint'), {
                code: '23514',
                constraint_name: 'jellyfin_display_preferences_data_size_check',
            }),
        );
        const res = await upsertDisplayPreferencesOrTooLarge({} as never, 'u1', 'id', 'client', {
            CustomPrefs: {},
        });
        expect(res?.status).toBe(413);
    });

    it('rethrows a CHECK violation on an unrelated constraint rather than swallowing it', async () => {
        mockUpsertDisplayPreferences.mockRejectedValue(
            Object.assign(new Error('violates check constraint'), {
                code: '23514',
                constraint_name: 'jellyfin_display_preferences_id_length_check',
            }),
        );
        await expect(
            upsertDisplayPreferencesOrTooLarge({} as never, 'u1', 'id', 'client', {}),
        ).rejects.toThrow();
    });

    it('rethrows an unrelated error (e.g. a connection failure) rather than reporting 413', async () => {
        mockUpsertDisplayPreferences.mockRejectedValue(new Error('connection terminated'));
        await expect(
            upsertDisplayPreferencesOrTooLarge({} as never, 'u1', 'id', 'client', {}),
        ).rejects.toThrow('connection terminated');
    });
});

describe('validateDisplayPreferencesIdentity', () => {
    it('accepts an id at exactly the max length', () => {
        const res = validateDisplayPreferencesIdentity(
            'a'.repeat(MAX_DISPLAY_PREFS_ID_LENGTH),
            'emby',
        );
        expect(res).toBeNull();
    });

    it('rejects an id one character over the max length', () => {
        const res = validateDisplayPreferencesIdentity(
            'a'.repeat(MAX_DISPLAY_PREFS_ID_LENGTH + 1),
            'emby',
        );
        expect(res?.status).toBe(422);
    });

    it('rejects an empty id', () => {
        const res = validateDisplayPreferencesIdentity('', 'emby');
        expect(res?.status).toBe(422);
    });

    it('rejects a client over the max length', () => {
        const res = validateDisplayPreferencesIdentity('customview-abc', 'c'.repeat(129));
        expect(res?.status).toBe(422);
    });

    it('accepts real-world custom ids with hyphens/digits (no GUID requirement)', () => {
        expect(validateDisplayPreferencesIdentity('customview-abc123', 'androidtv')).toBeNull();
        expect(validateDisplayPreferencesIdentity('usersettings', 'emby')).toBeNull();
    });
});

describe('enforceDisplayPreferencesRowCap', () => {
    beforeEach(() => vi.clearAllMocks());

    it('allows a new pair under the cap', async () => {
        mockDisplayPreferencesRowExists.mockResolvedValue(false);
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(
            MAX_DISPLAY_PREFS_ROWS_PER_USER - 1,
        );
        const res = await enforceDisplayPreferencesRowCap({} as never, 'u1', 'id', 'client');
        expect(res).toBeNull();
    });

    it('refuses a new pair once the user is AT the cap', async () => {
        mockDisplayPreferencesRowExists.mockResolvedValue(false);
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(MAX_DISPLAY_PREFS_ROWS_PER_USER);
        const res = await enforceDisplayPreferencesRowCap({} as never, 'u1', 'id', 'client');
        expect(res?.status).toBe(409);
    });

    it('never refuses an update to an existing pair, even far over the cap', async () => {
        mockDisplayPreferencesRowExists.mockResolvedValue(true);
        mockCountDisplayPreferencesRowsForUser.mockResolvedValue(
            MAX_DISPLAY_PREFS_ROWS_PER_USER + 50,
        );
        const res = await enforceDisplayPreferencesRowCap({} as never, 'u1', 'id', 'client');
        expect(res).toBeNull();
        // The cap check short-circuits on the existence check — no need to even count.
        expect(mockCountDisplayPreferencesRowsForUser).not.toHaveBeenCalled();
    });
});
