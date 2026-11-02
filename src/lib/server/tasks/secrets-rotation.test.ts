// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Round-trip tests for the per-store master-key rotations added for
 * security review 2026-09-12, C9.
 *
 * The property each store must have is the same one `PluginSecrets.rotate()`
 * has always had and nothing else did: seal under key A, rotate A→B, the value
 * opens under B and NO LONGER opens under A. A rotation that "succeeds" while
 * leaving ciphertext readable by the retired key is the whole finding.
 *
 * The two DB stores covered here (jellyfin_client_passwords, the webhook secret
 * columns) are driven through a fake `sql` tagged template — no live database.
 * Subsonic lives in its own file because its module has heavier imports, and
 * settings.json in config.service's own.
 *
 * Run: npx vitest run src/lib/server/tasks/secrets-rotation.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import {
    deriveMasterKey,
    encrypt,
    decrypt,
    sealSecret,
    openSecret,
} from '$lib/server/crypto/secret-box.js';

vi.mock('./metrics.js', () => ({
    taskPendingWritePoisonedTotal: { inc: vi.fn() },
    webhookDeliveriesTotal: { inc: vi.fn() },
}));

vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'a'.repeat(64),
}));

const KEY_A = deriveMasterKey('a'.repeat(64));
const KEY_B = deriveMasterKey('b'.repeat(64));

// The AAD contexts each store binds its values to (security review 2026-09-13,
// C19). Spelled out rather than imported: these strings are an ON-DISK
// contract, and changing one orphans every row already sealed under it.
const jfCtx = (userId: string): string => `jellyfin_client_passwords:${userId.toLowerCase()}`;
const hookCtx = (id: string): string => `task_webhook_hooks:${id.toLowerCase()}`;
const userHookCtx = (userId: string): string =>
    `user_notification_webhooks:${userId.toLowerCase()}`;
const livetvCtx = (id: string, column: 'xtream_username' | 'xtream_password'): string =>
    `livetv_sources:${id.toLowerCase()}/${column}`;

// ── Fake sql ──────────────────────────────────────────────────────────────────

interface FakeStore {
    sql: postgres.Sql;
    updates: Array<{ text: string; values: unknown[] }>;
}

/**
 * A tagged-template stand-in for postgres.Sql. SELECTs return `rows`; UPDATEs
 * are recorded and applied back onto `rows` through `applyUpdate`, so a second
 * rotation pass sees what the first one wrote (that is how idempotence is
 * tested at all).
 */
function makeSql(
    rows: Record<string, unknown>[] | ((selectText: string) => Record<string, unknown>[]),
    applyUpdate: (values: unknown[], rows: Record<string, unknown>[]) => void,
): FakeStore {
    const updates: Array<{ text: string; values: unknown[] }> = [];
    // A SELECT may be answered per-table (the webhook sweep reads two tables
    // that bind their secrets to DIFFERENT contexts, so one shared row set
    // would be a fixture that cannot exist in the database).
    const rowsFor = typeof rows === 'function' ? rows : () => rows;
    const allRows = typeof rows === 'function' ? undefined : rows;

    const sqlFn = ((first: unknown, ...values: unknown[]) => {
        // `sql(identifier)` — the webhook rotation interpolates a table name
        // that way, because postgres.js cannot parameterise an identifier.
        // Real postgres.js returns an escaped fragment; the raw string is
        // enough here, and it keeps the call visible in the recorded text.
        if (!Array.isArray(first)) return first;

        const text = (first as string[]).join(' ');
        if (/UPDATE/i.test(text)) {
            updates.push({ text, values });
            applyUpdate(values, allRows ?? rowsFor(text));
            return Promise.resolve([]);
        }
        return Promise.resolve(rowsFor(text));
    }) as unknown as postgres.Sql;

    return { sql: sqlFn, updates };
}

// ── jellyfin_client_passwords ─────────────────────────────────────────────────

describe('rotateJellyfinClientPasswords', () => {
    it('re-seals password_sealed so it opens under the new key and not the old', async () => {
        const { rotateJellyfinClientPasswords } = await import('./secrets.js');
        const rows: Record<string, unknown>[] = [
            { user_id: 'u1', password_sealed: sealSecret('pin-one1', KEY_A, jfCtx('u1')) },
            { user_id: 'u2', password_sealed: sealSecret('pin-two2', KEY_A, jfCtx('u2')) },
        ];
        const { sql, updates } = makeSql(rows, (values, rs) => {
            const [sealed, userId] = values as [string, string];
            const row = rs.find((r) => r.user_id === userId);
            if (row) row.password_sealed = sealed;
        });

        const result = await rotateJellyfinClientPasswords(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 2, skipped: 0, reasons: [], legacyUpgraded: 0 });
        expect(updates).toHaveLength(2);
        expect(openSecret(rows[0].password_sealed as string, KEY_B, jfCtx('u1'))).toBe('pin-one1');
        expect(openSecret(rows[1].password_sealed as string, KEY_B, jfCtx('u2'))).toBe('pin-two2');
        expect(() => openSecret(rows[0].password_sealed as string, KEY_A, jfCtx('u1'))).toThrow();
        // …and u1's PIN is not readable as u2's row.
        expect(() => openSecret(rows[0].password_sealed as string, KEY_B, jfCtx('u2'))).toThrow();
    });

    it('is safe to re-run: a row already under the new key is left untouched', async () => {
        const { rotateJellyfinClientPasswords } = await import('./secrets.js');
        const rows: Record<string, unknown>[] = [
            { user_id: 'u1', password_sealed: sealSecret('pin-one1', KEY_B, jfCtx('u1')) },
        ];
        const { sql, updates } = makeSql(rows, () => {});

        const result = await rotateJellyfinClientPasswords(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(1);
        expect(result.skipped).toBe(0);
        expect(updates).toHaveLength(0);
    });

    it('upgrades an unbound enc:v1: row that is ALREADY under the new key', async () => {
        const { rotateJellyfinClientPasswords } = await import('./secrets.js');
        const rows: Record<string, unknown>[] = [
            { user_id: 'u1', password_sealed: sealSecret('pin-one1', KEY_B) },
        ];
        const { sql, updates } = makeSql(rows, (values, rs) => {
            const [sealed, userId] = values as [string, string];
            const row = rs.find((r) => r.user_id === userId);
            if (row) row.password_sealed = sealed;
        });

        const result = await rotateJellyfinClientPasswords(sql, KEY_A, KEY_B);

        // The upgrade is REPORTED, not silent: it binds the value to the row it
        // happens to be in, which the operator has to be able to see.
        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        expect(updates).toHaveLength(1);
        const sealed = rows[0].password_sealed as string;
        expect(sealed.startsWith('enc:v2:')).toBe(true);
        expect(openSecret(sealed, KEY_B, jfCtx('u1'))).toBe('pin-one1');
        expect(() => openSecret(sealed, KEY_B, jfCtx('u2'))).toThrow();
    });

    it('reports a PIN transplanted from another user rather than re-sealing it', async () => {
        const { rotateJellyfinClientPasswords } = await import('./secrets.js');
        const rows: Record<string, unknown>[] = [
            // u2's row holds u1's envelope — the C19 transplant.
            { user_id: 'u2', password_sealed: sealSecret('pin-one1', KEY_A, jfCtx('u1')) },
        ];
        const { sql, updates } = makeSql(rows, () => {});

        const result = await rotateJellyfinClientPasswords(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('user_id=u2');
        expect(updates).toHaveLength(0);
    });

    it('reports a row that opens under neither key instead of failing the sweep', async () => {
        const { rotateJellyfinClientPasswords } = await import('./secrets.js');
        const KEY_C = deriveMasterKey('c'.repeat(64));
        const rows: Record<string, unknown>[] = [
            { user_id: 'u1', password_sealed: sealSecret('pin-one1', KEY_A, jfCtx('u1')) },
            { user_id: 'u2', password_sealed: sealSecret('orphan12', KEY_C, jfCtx('u2')) },
        ];
        const { sql } = makeSql(rows, (values, rs) => {
            const [sealed, userId] = values as [string, string];
            const row = rs.find((r) => r.user_id === userId);
            if (row) row.password_sealed = sealed;
        });

        const result = await rotateJellyfinClientPasswords(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('user_id=u2');
    });
});

// ── webhook secret columns ────────────────────────────────────────────────────

describe('rotateWebhookSecrets', () => {
    /**
     * The two owner tables bind their secrets to DIFFERENT contexts — the
     * operator hook to its own id, the per-user hook to its owner — so the
     * fake answers each table's SELECT with its own row.
     */
    function webhookRows(
        operator: Record<string, unknown>[],
        user: Record<string, unknown>[],
    ): (text: string) => Record<string, unknown>[] {
        return (text) => (/user_notification_webhooks/.test(text) ? user : operator);
    }

    /**
     * Apply an UPDATE back onto the right table's rows. `values[0]` is the
     * interpolated table identifier — the only thing that says WHICH owner
     * table a write was aimed at, since the name is not in the query text.
     */
    const applyBlob =
        (operator: Record<string, unknown>[], user: Record<string, unknown>[]) =>
        (values: unknown[]): void => {
            const [table, blob, id] = values as [string, Buffer, string];
            const rs = String(table).includes('user_notification_webhooks') ? user : operator;
            const row = rs.find((r) => r.id === id);
            if (row) row.secret_encrypted = blob;
        };

    it('re-encrypts both owner tables so the secret opens under the new key only', async () => {
        const { rotateWebhookSecrets } = await import('./webhook-outbox.js');
        const operator: Record<string, unknown>[] = [
            {
                id: 'h1',
                owner_user_id: null,
                secret_encrypted: encrypt('whsec-one', KEY_A, hookCtx('h1')),
            },
        ];
        const user: Record<string, unknown>[] = [
            {
                id: 'h2',
                owner_user_id: 'u1',
                secret_encrypted: encrypt('whsec-two', KEY_A, userHookCtx('u1')),
            },
        ];
        const { sql, updates } = makeSql(webhookRows(operator, user), applyBlob(operator, user));

        const result = await rotateWebhookSecrets(sql, KEY_A, KEY_B);

        expect(result.skipped).toBe(0);
        expect(result.rotated).toBe(2);
        expect(updates).toHaveLength(2);
        expect(decrypt(operator[0].secret_encrypted as Buffer, KEY_B, hookCtx('h1'))).toBe(
            'whsec-one',
        );
        expect(decrypt(user[0].secret_encrypted as Buffer, KEY_B, userHookCtx('u1'))).toBe(
            'whsec-two',
        );
        expect(() =>
            decrypt(operator[0].secret_encrypted as Buffer, KEY_A, hookCtx('h1')),
        ).toThrow();
        // The operator secret is not readable as the per-user hook's, either.
        expect(() =>
            decrypt(operator[0].secret_encrypted as Buffer, KEY_B, userHookCtx('u1')),
        ).toThrow();
    });

    it('upgrades an unbound legacy blob that is ALREADY under the new key', async () => {
        const { rotateWebhookSecrets } = await import('./webhook-outbox.js');
        const operator: Record<string, unknown>[] = [
            { id: 'h1', owner_user_id: null, secret_encrypted: encrypt('whsec-one', KEY_B) },
        ];
        const { sql, updates } = makeSql(webhookRows(operator, []), applyBlob(operator, []));

        const result = await rotateWebhookSecrets(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 1 });
        expect(updates).toHaveLength(1);
        const blob = operator[0].secret_encrypted as Buffer;
        expect(decrypt(blob, KEY_B, hookCtx('h1'))).toBe('whsec-one');
        expect(() => decrypt(blob, KEY_B, hookCtx('h2'))).toThrow();
    });

    it('is safe to re-run: a bound blob already under the new key is not rewritten', async () => {
        const { rotateWebhookSecrets } = await import('./webhook-outbox.js');
        const operator: Record<string, unknown>[] = [
            {
                id: 'h1',
                owner_user_id: null,
                secret_encrypted: encrypt('whsec-one', KEY_B, hookCtx('h1')),
            },
        ];
        const { sql, updates } = makeSql(webhookRows(operator, []), applyBlob(operator, []));

        const result = await rotateWebhookSecrets(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 1, skipped: 0, reasons: [], legacyUpgraded: 0 });
        expect(updates).toHaveLength(0);
    });

    it('reports an unreadable secret rather than throwing out of the sweep', async () => {
        const { rotateWebhookSecrets } = await import('./webhook-outbox.js');
        const KEY_C = deriveMasterKey('c'.repeat(64));
        const operator: Record<string, unknown>[] = [
            { id: 'h1', owner_user_id: null, secret_encrypted: encrypt('whsec-orphan', KEY_C) },
        ];
        const user: Record<string, unknown>[] = [
            { id: 'h2', owner_user_id: 'u1', secret_encrypted: encrypt('whsec-orphan', KEY_C) },
        ];
        const { sql } = makeSql(webhookRows(operator, user), () => {});

        const result = await rotateWebhookSecrets(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        // Once per table.
        expect(result.skipped).toBe(2);
        expect(result.reasons[0]).toContain('task_webhook_hooks id=h1');
        expect(result.reasons[1]).toContain('user_notification_webhooks id=h2');
    });
});

// ── livetv_sources xtream credentials ─────────────────────────────────────────

describe('rotateLiveTvCredentials', () => {
    it('re-seals both credential columns so they open under the new key only', async () => {
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const rows: Record<string, unknown>[] = [
            {
                id: 's1',
                xtream_username: sealSecret('paid-user', KEY_A, livetvCtx('s1', 'xtream_username')),
                xtream_password: sealSecret('paid-pass', KEY_A, livetvCtx('s1', 'xtream_password')),
            },
        ];
        const { sql, updates } = makeSql(rows, (values, rs) => {
            const [user, pass, id] = values as [string, string, string];
            const row = rs.find((r) => r.id === id);
            if (row) {
                row.xtream_username = user;
                row.xtream_password = pass;
            }
        });

        const result = await rotateLiveTvCredentials(sql, KEY_A, KEY_B);

        // Two columns on one row, written in a single statement.
        expect(result).toEqual({ rotated: 2, skipped: 0, reasons: [], legacyUpgraded: 0 });
        expect(updates).toHaveLength(1);
        const user = rows[0].xtream_username as string;
        const pass = rows[0].xtream_password as string;
        expect(openSecret(user, KEY_B, livetvCtx('s1', 'xtream_username'))).toBe('paid-user');
        expect(openSecret(pass, KEY_B, livetvCtx('s1', 'xtream_password'))).toBe('paid-pass');
        expect(() => openSecret(pass, KEY_A, livetvCtx('s1', 'xtream_password'))).toThrow();
        // Nor is the password readable as this row's username, or as another
        // source's password.
        expect(() => openSecret(pass, KEY_B, livetvCtx('s1', 'xtream_username'))).toThrow();
        expect(() => openSecret(pass, KEY_B, livetvCtx('s2', 'xtream_password'))).toThrow();
    });

    it('leaves legacy plaintext columns alone — they are not ciphertext to move', async () => {
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const rows: Record<string, unknown>[] = [
            { id: 's1', xtream_username: 'legacy-user', xtream_password: 'legacy-pass' },
        ];
        const { sql, updates } = makeSql(rows, () => {});

        const result = await rotateLiveTvCredentials(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 0, skipped: 0, reasons: [], legacyUpgraded: 0 });
        expect(updates).toHaveLength(0);
        expect(rows[0].xtream_username).toBe('legacy-user');
    });

    it('is safe to re-run: values already under the new key are not rewritten', async () => {
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const rows: Record<string, unknown>[] = [
            {
                id: 's1',
                xtream_username: sealSecret('paid-user', KEY_B, livetvCtx('s1', 'xtream_username')),
                xtream_password: sealSecret('paid-pass', KEY_B, livetvCtx('s1', 'xtream_password')),
            },
        ];
        const { sql, updates } = makeSql(rows, () => {});

        const result = await rotateLiveTvCredentials(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(2);
        expect(result.skipped).toBe(0);
        expect(updates).toHaveLength(0);
    });

    it('upgrades unbound enc:v1: columns that are ALREADY under the new key', async () => {
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const rows: Record<string, unknown>[] = [
            {
                id: 's1',
                xtream_username: sealSecret('paid-user', KEY_B),
                xtream_password: sealSecret('paid-pass', KEY_B),
            },
        ];
        const { sql, updates } = makeSql(rows, (values, rs) => {
            const [user, pass, id] = values as [string, string, string];
            const row = rs.find((r) => r.id === id);
            if (row) {
                row.xtream_username = user;
                row.xtream_password = pass;
            }
        });

        const result = await rotateLiveTvCredentials(sql, KEY_A, KEY_B);

        expect(result).toEqual({ rotated: 2, skipped: 0, reasons: [], legacyUpgraded: 2 });
        expect(updates).toHaveLength(1);
        expect((rows[0].xtream_password as string).startsWith('enc:v2:')).toBe(true);
        expect(
            openSecret(
                rows[0].xtream_password as string,
                KEY_B,
                livetvCtx('s1', 'xtream_password'),
            ),
        ).toBe('paid-pass');
    });

    it('counts nothing for a row whose UPDATE fails (security review 2026-09-13, C19)', async () => {
        // The counters are a report to an operator deciding whether it is safe
        // to swap LUMASTRA_MASTER_KEY. A write that throws has rotated nothing
        // and bound nothing, so neither counter may move — the values are still
        // sealed under the OLD key, in the OLD unbound form.
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const rows: Record<string, unknown>[] = [
            {
                id: 's1',
                xtream_username: sealSecret('paid-user', KEY_A),
                xtream_password: sealSecret('paid-pass', KEY_A),
            },
        ];
        // A fake whose SELECT works and whose UPDATE always throws.
        const sqlFn = ((first: unknown) => {
            if (!Array.isArray(first)) return first;
            const text = (first as string[]).join(' ');
            if (/UPDATE/i.test(text)) return Promise.reject(new Error('deadlock detected'));
            return Promise.resolve(rows);
        }) as unknown as postgres.Sql;

        const result = await rotateLiveTvCredentials(sqlFn, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.legacyUpgraded).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons[0]).toContain('deadlock detected');
        // …and the row is untouched: still the old key, still unbound.
        expect(openSecret(rows[0].xtream_password as string, KEY_A)).toBe('paid-pass');
    });

    it('reports a row that opens under neither key', async () => {
        const { rotateLiveTvCredentials } =
            await import('$lib/server/database/queries/livetv-sources.queries.js');
        const KEY_C = deriveMasterKey('c'.repeat(64));
        const rows: Record<string, unknown>[] = [
            {
                id: 's1',
                xtream_username: sealSecret(
                    'orphan-user',
                    KEY_C,
                    livetvCtx('s1', 'xtream_username'),
                ),
                xtream_password: sealSecret(
                    'orphan-pass',
                    KEY_C,
                    livetvCtx('s1', 'xtream_password'),
                ),
            },
        ];
        const { sql, updates } = makeSql(rows, () => {});

        const result = await rotateLiveTvCredentials(sql, KEY_A, KEY_B);

        expect(result.rotated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.reasons).toHaveLength(2);
        expect(updates).toHaveLength(0);
    });
});
