// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for PluginSecrets — AES-GCM encrypt/decrypt, set/get, audit log,
 * rotation, first-boot seeding, and error paths.
 *
 * No live database — all SQL calls are intercepted by makeFakeSql().
 *
 * Run with: npx vitest run src/lib/server/tasks/secrets.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import {
    PluginSecrets,
    deriveMasterKey,
    encrypt,
    decrypt,
    pluginSecretContext,
    __resetMasterKeyCacheForTests,
} from './secrets.js';

// rotate() mutates the module-level master key cache singleton (by design —
// see secrets.ts) so THIS process self-heals immediately after a rotation.
// That mutation must not leak between tests: reset it after every test so
// each test starts from the lazily-derived LUMASTRA_MASTER_KEY mock, not
// whatever key a previous rotate-test left behind.
afterEach(() => {
    __resetMasterKeyCacheForTests();
});

// Mock metrics so the counter import doesn't fail in unit tests.
vi.mock('./metrics.js', () => ({
    taskPendingWritePoisonedTotal: { inc: vi.fn() },
}));

// ── Config mock ───────────────────────────────────────────────────────────────

// 64-char hex → 32-byte raw key. Must be a literal inside vi.mock (hoisted).
// 'aaaa...aaaa' (64 chars) = 32 bytes of 0xAA.
vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_MASTER_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}));

// The store resolves the EFFECTIVE master key (env → <config>/master.key →
// generate), not the load-time LUMASTRA_MASTER_KEY snapshot — that snapshot is
// empty on any deployment that lets the key auto-generate, which is the default.
// Mock it to the same literal so these tests pin a known key instead of
// generating one into the developer's config dir mid-run.
vi.mock('$lib/server/crypto/master-key.js', () => ({
    resolveMasterKey: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}));

const TEST_MASTER_KEY_HEX = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ── SQL fake ──────────────────────────────────────────────────────────────────

interface SqlRow {
    [key: string]: unknown;
}

function makeFakeSql(rowsByQuery: Map<string, SqlRow[]> = new Map()): {
    sql: postgres.Sql;
    calls: Array<{ template: string; values: unknown[] }>;
} {
    const calls: Array<{ template: string; values: unknown[] }> = [];

    const sqlFn = ((strings: readonly string[], ...values: unknown[]) => {
        const template = (strings[0] ?? '').trim().slice(0, 120);
        calls.push({ template, values });

        // Find a matching response by substring.
        for (const [key, rows] of rowsByQuery) {
            if (template.includes(key)) {
                return Promise.resolve(rows);
            }
        }
        return Promise.resolve([]);
    }) as unknown as postgres.Sql;

    return { sql: sqlFn, calls };
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

describe('deriveMasterKey', () => {
    it('accepts a 64-char hex string and returns 32 bytes', () => {
        const key = deriveMasterKey(TEST_MASTER_KEY_HEX);
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
        expect(key).toEqual(Buffer.from(TEST_MASTER_KEY_HEX, 'hex'));
    });

    it('hashes a valid passphrase (≥24 chars, 2+ classes) via SHA-256', () => {
        const key = deriveMasterKey('mySecretPassphrase12345!');
        expect(key).toBeInstanceOf(Buffer);
        expect(key.length).toBe(32);
    });

    it('throws when envValue is empty', () => {
        expect(() => deriveMasterKey('')).toThrow('LUMASTRA_MASTER_KEY not set');
    });

    it('throws on passphrase shorter than 24 chars', () => {
        expect(() => deriveMasterKey('tooshort123')).toThrow('≥ 24 characters');
    });

    it('throws on passphrase with only one character class (all letters)', () => {
        expect(() => deriveMasterKey('abcdefghijklmnopqrstuvwxyz')).toThrow(
            'two character classes',
        );
    });

    it('accepts passphrase with letters+digits (two classes)', () => {
        const key = deriveMasterKey('abcdefghijklmnopqrstuvwxyz12');
        expect(key.length).toBe(32);
    });

    it('accepts passphrase with letters+symbols (two classes)', () => {
        const key = deriveMasterKey('abcdefghijklmnopqrstuvwxyz!!');
        expect(key.length).toBe(32);
    });
});

describe('encrypt / decrypt round-trip', () => {
    it('decrypts to original plaintext', () => {
        const key = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const plain = 'super-secret-value-1234';
        const blob = encrypt(plain, key);
        expect(decrypt(blob, key)).toBe(plain);
    });

    it('produces different ciphertext each call (random IV)', () => {
        const key = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const a = encrypt('same', key);
        const b = encrypt('same', key);
        expect(a.toString('hex')).not.toBe(b.toString('hex'));
    });

    it('blob is at least 29 bytes (12 IV + 16 tag + 1 ciphertext)', () => {
        const key = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('x', key);
        expect(blob.length).toBeGreaterThanOrEqual(29);
    });

    it('throws on tampered ciphertext (AES-GCM auth tag)', () => {
        const key = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('value', key);
        blob[blob.length - 1] ^= 0xff; // flip last byte
        expect(() => decrypt(blob, key)).toThrow();
    });
});

// ── PluginSecrets.set / get ───────────────────────────────────────────────────

describe('PluginSecrets.set / get', () => {
    let secrets: PluginSecrets;
    let calls: Array<{ template: string; values: unknown[] }>;

    beforeEach(() => {
        const masterKey = deriveMasterKey(TEST_MASTER_KEY_HEX);

        // Pre-seed: when get() queries plugin_secrets, return a row with the
        // encrypted value of 'my-value' so we can verify round-trip.
        const encryptedBlob = encrypt('my-value', masterKey);

        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: encryptedBlob, encryption_version: 1 }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        calls = fake.calls;
        secrets = new PluginSecrets(fake.sql);
    });

    it('set() issues an INSERT...ON CONFLICT query', async () => {
        await secrets.set('my-plugin', 'API_KEY', 'secret123');
        const insertCall = calls.find((c) => c.template.includes('INSERT INTO plugin_secrets'));
        expect(insertCall).toBeDefined();
    });

    it('set() stores encrypted bytes, not plaintext', async () => {
        await secrets.set('my-plugin', 'API_KEY', 'plaintext');
        const insertCall = calls.find((c) => c.template.includes('INSERT INTO plugin_secrets'));
        expect(insertCall).toBeDefined();
        // The second value in the tagged template is the encrypted Buffer.
        const hasPlaintext = insertCall!.values.some(
            (v) => typeof v === 'string' && v === 'plaintext',
        );
        expect(hasPlaintext).toBe(false);
    });

    it('get() returns the decrypted value', async () => {
        const value = await secrets.get('my-plugin', 'API_KEY');
        expect(value).toBe('my-value');
    });

    it('get() writes an access-log row', async () => {
        await secrets.get('my-plugin', 'API_KEY', 'run_abc');
        // audit insert is fire-and-forget; give it a tick
        await new Promise((r) => setTimeout(r, 0));
        const auditCall = calls.find((c) =>
            c.template.includes('INSERT INTO plugin_secret_access_log'),
        );
        expect(auditCall).toBeDefined();
    });

    it('get() throws when secret is not found', async () => {
        const empty = makeFakeSql(); // returns [] for all queries
        const secretsEmpty = new PluginSecrets(empty.sql);
        await expect(secretsEmpty.get('my-plugin', 'MISSING')).rejects.toThrow(
            'Plugin secret not found',
        );
    });

    it('get() throws a descriptive error (not a bare GCM error) when decryption fails', async () => {
        // Encrypted under a DIFFERENT key than the cached master key, so
        // decrypt() throws a node:crypto "unable to authenticate data" error.
        // This simulates a replica that still holds the pre-rotation key.
        const wrongKey = Buffer.from('cc'.repeat(32), 'hex');
        const blob = encrypt('some-value', wrongKey);
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob, encryption_version: 1 }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secretsWrongKey = new PluginSecrets(fake.sql);

        await expect(secretsWrongKey.get('my-plugin', 'API_KEY')).rejects.toThrow(
            /secret decrypt failed.*my-plugin\/API_KEY.*master key was recently rotated.*restart/is,
        );
    });
});

// ── PluginSecrets.getUser ─────────────────────────────────────────────────────

describe('PluginSecrets.getUser', () => {
    it('throws when user credential is not found', async () => {
        const empty = makeFakeSql();
        const secrets = new PluginSecrets(empty.sql);
        await expect(secrets.getUser('plugin', 'user1', 'access_token')).rejects.toThrow(
            'User credential not found',
        );
    });

    it('throws when credential has expired', async () => {
        const masterKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('token', masterKey);
        const past = new Date(Date.now() - 1000);
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob, expires_at: past }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        await expect(secrets.getUser('plugin', 'user1', 'access_token')).rejects.toThrow(
            'User credential expired',
        );
    });

    it('returns the decrypted value and writes an audit log', async () => {
        const masterKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('my-token', masterKey);
        const future = new Date(Date.now() + 86_400_000);
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob, expires_at: future }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const value = await secrets.getUser('plugin', 'user1', 'access_token', 'run_xyz');
        expect(value).toBe('my-token');

        await new Promise((r) => setTimeout(r, 0));
        const auditCall = fake.calls.find((c) =>
            c.template.includes('INSERT INTO plugin_secret_access_log'),
        );
        expect(auditCall).toBeDefined();
    });
});

// ── PluginSecrets.rotate ──────────────────────────────────────────────────────

describe('PluginSecrets.rotate', () => {
    it('re-encrypts all rows with the new key', async () => {
        const oldKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const newKeyHex = 'b'.repeat(64);
        const newKey = Buffer.from(newKeyHex, 'hex');

        const blob1 = encrypt('secret-a', oldKey);
        const blob2 = encrypt('secret-b', oldKey);

        const rowsByQuery = new Map<string, SqlRow[]>([
            [
                'SELECT plugin_id, key, value_encrypted, encryption_version',
                [
                    {
                        plugin_id: 'p1',
                        key: 'k1',
                        value_encrypted: blob1,
                        encryption_version: 1,
                    },
                    {
                        plugin_id: 'p1',
                        key: 'k2',
                        value_encrypted: blob2,
                        encryption_version: 1,
                    },
                ],
            ],
            [
                'SELECT plugin_id, user_id, key, value_encrypted, encryption_version',
                [], // no user creds
            ],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const { rotated, skipped, failedRows } = await secrets.rotate(oldKey, newKey, 2);
        expect(rotated).toBe(2);
        expect(skipped).toBe(0);
        expect(failedRows).toEqual([]);

        // Two UPDATE calls for the two secrets rows.
        const updateCalls = fake.calls.filter((c) => c.template.includes('UPDATE plugin_secrets'));
        expect(updateCalls.length).toBe(2);
    });

    it('skips rows encrypted with the wrong key and records them in failedRows', async () => {
        const oldKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const wrongKeyHex = 'cc'.repeat(32);
        const wrongKey = Buffer.from(wrongKeyHex, 'hex');
        const newKeyHex = 'b'.repeat(64);
        const newKey = Buffer.from(newKeyHex, 'hex');

        // Encrypt with wrongKey — rotate() will try to decrypt with oldKey → fail.
        const corruptBlob = encrypt('secret-x', wrongKey);

        const rowsByQuery = new Map<string, SqlRow[]>([
            [
                'SELECT plugin_id, key, value_encrypted, encryption_version',
                [
                    {
                        plugin_id: 'p2',
                        key: 'bad',
                        value_encrypted: corruptBlob,
                        encryption_version: 1,
                    },
                ],
            ],
            ['SELECT plugin_id, user_id, key, value_encrypted, encryption_version', []],
            // Post-rotation assertion: simulate 1 remaining row still at old version.
            ['SELECT COUNT', [{ count: '1' }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        await expect(secrets.rotate(oldKey, newKey, 2)).rejects.toThrow(
            'could not be re-encrypted',
        );
    });

    it('does not count an unreadable row as upgraded (security review 2026-09-13, C19)', async () => {
        // `legacyUpgraded` says "this many values are now bound to their row".
        // A row that opens under NEITHER key is never written, so counting it
        // would tell the operator a binding happened that did not — while the
        // same row is also reported in failedRows as un-rotatable.
        const oldKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const newKey = Buffer.from('b'.repeat(64), 'hex');
        const wrongKey = Buffer.from('cc'.repeat(32), 'hex');

        const rowsByQuery = new Map<string, SqlRow[]>([
            [
                'SELECT plugin_id, key, value_encrypted, encryption_version',
                [
                    // Legacy (unbound) AND unreadable: the exact overlap.
                    {
                        plugin_id: 'p1',
                        key: 'unreadable',
                        value_encrypted: encrypt('secret-x', wrongKey),
                        encryption_version: 1,
                    },
                    // A legacy row that DOES open, so the counter is not simply
                    // stuck at zero.
                    {
                        plugin_id: 'p1',
                        key: 'readable',
                        value_encrypted: encrypt('secret-y', oldKey),
                        encryption_version: 1,
                    },
                ],
            ],
            ['SELECT plugin_id, user_id, key, value_encrypted, encryption_version', []],
            // Post-rotation assertion: nothing left at the old version.
            ['SELECT COUNT', [{ count: '0' }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const result = await secrets.rotate(oldKey, newKey, 2);

        expect(result.rotated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.failedRows).toEqual([{ pluginId: 'p1', key: 'unreadable' }]);
        // ONE upgrade — the row that was actually written.
        expect(result.legacyUpgraded).toBe(1);
    });

    it('finishes on a re-run: a row the first run already moved is not "unreadable"', async () => {
        // The handler asks for MAX(version) + 1 on every run, so a row a partly
        // failed first run moved to the new key is below the new version again.
        // The old key cannot open it; it must count as rotated, not fail the run
        // forever.
        const oldKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const newKey = Buffer.from('b'.repeat(64), 'hex');
        const alreadyMoved = encrypt('secret-a', newKey, pluginSecretContext('p1', 'k1'));

        const fake = makeFakeSql(
            new Map<string, SqlRow[]>([
                [
                    'SELECT plugin_id, key, value_encrypted, encryption_version',
                    [
                        {
                            plugin_id: 'p1',
                            key: 'k1',
                            value_encrypted: alreadyMoved,
                            encryption_version: 2,
                        },
                        {
                            plugin_id: 'p1',
                            key: 'k2',
                            value_encrypted: encrypt(
                                'secret-b',
                                oldKey,
                                pluginSecretContext('p1', 'k2'),
                            ),
                            encryption_version: 1,
                        },
                    ],
                ],
                ['SELECT plugin_id, user_id, key, value_encrypted, encryption_version', []],
            ]),
        );

        const result = await new PluginSecrets(fake.sql).rotate(oldKey, newKey, 3);

        expect(result).toMatchObject({ rotated: 2, skipped: 0, failedRows: [] });
        const updates = fake.calls.filter((c) => c.template.includes('UPDATE plugin_secrets'));
        // The moved row keeps its value and only takes the new version.
        expect(updates[0].values).toEqual([alreadyMoved, 3, 'p1', 'k1']);
        expect(
            decrypt(updates[1].values[0] as Buffer, newKey, pluginSecretContext('p1', 'k2')),
        ).toBe('secret-b');
    });

    it('rotate-then-get in the same process succeeds without a restart (cache invalidated)', async () => {
        const oldKey = deriveMasterKey(TEST_MASTER_KEY_HEX); // == the LUMASTRA_MASTER_KEY mock
        const newKeyHex = 'd'.repeat(64);
        const newKey = Buffer.from(newKeyHex, 'hex');

        const rotateSourceBlob = encrypt('secret-value', oldKey);
        // What the row looks like in the DB AFTER rotate()'s UPDATE ran.
        const postRotationBlob = encrypt('secret-value', newKey);

        const rowsByQuery = new Map<string, SqlRow[]>([
            [
                'SELECT plugin_id, key, value_encrypted, encryption_version',
                [
                    {
                        plugin_id: 'p1',
                        key: 'k1',
                        value_encrypted: rotateSourceBlob,
                        encryption_version: 1,
                    },
                ],
            ],
            ['SELECT plugin_id, user_id, key, value_encrypted, encryption_version', []],
            [
                'SELECT value_encrypted',
                [{ value_encrypted: postRotationBlob, encryption_version: 2 }],
            ],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const result = await secrets.rotate(oldKey, newKey, 2);
        expect(result.rotated).toBe(1);

        // Without invalidating the module-level cache in rotate(), get()
        // would still decrypt with the stale `oldKey` and throw a bare GCM
        // auth-tag error against a blob now encrypted with `newKey`.
        const value = await secrets.get('p1', 'k1');
        expect(value).toBe('secret-value');
    });
});

// ── PluginSecrets.getCurrentMaxVersion ───────────────────────────────────────

describe('PluginSecrets.getCurrentMaxVersion', () => {
    it('returns 1 when the table is empty (null MAX)', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['MAX(encryption_version)', [{ max_version: null }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        const v = await secrets.getCurrentMaxVersion();
        expect(v).toBe(1);
    });

    it('returns currentMax + 1', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['MAX(encryption_version)', [{ max_version: 3 }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        const v = await secrets.getCurrentMaxVersion();
        expect(v).toBe(4);
    });
});

// ── PluginSecrets.seedFromEnv ─────────────────────────────────────────────────

// ── PluginSecrets user-credential primitives ─────────────────────────────────

describe('PluginSecrets.getUserRaw', () => {
    it('returns the decrypted value even when the row is expired', async () => {
        const masterKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('expired-but-readable', masterKey);
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        // getUserRaw doesn't read expires_at — by design, plugins want to
        // see expired tokens so they can refresh them.
        const value = await secrets.getUserRaw('plugin', 'user1', 'access_token');
        expect(value).toBe('expired-but-readable');
    });

    it('returns null when no row exists', async () => {
        const fake = makeFakeSql();
        const secrets = new PluginSecrets(fake.sql);
        const value = await secrets.getUserRaw('plugin', 'user1', 'missing');
        expect(value).toBeNull();
    });

    it('does NOT write to the access log (no audit on raw reads)', async () => {
        const masterKey = deriveMasterKey(TEST_MASTER_KEY_HEX);
        const blob = encrypt('token', masterKey);
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        await secrets.getUserRaw('plugin', 'user1', 'access_token');
        await new Promise((r) => setTimeout(r, 0));

        const auditCall = fake.calls.find((c) =>
            c.template.includes('INSERT INTO plugin_secret_access_log'),
        );
        expect(auditCall).toBeUndefined();
    });

    it('returns null when decryption fails (corrupt row)', async () => {
        const wrongKey = Buffer.from('cc'.repeat(32), 'hex');
        const blob = encrypt('value', wrongKey); // encrypted under wrong key
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT value_encrypted', [{ value_encrypted: blob }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const value = await secrets.getUserRaw('plugin', 'user1', 'key');
        expect(value).toBeNull();
    });
});

describe('PluginSecrets.deleteUser', () => {
    it('issues a DELETE scoped by plugin_id, user_id, key', async () => {
        const fake = makeFakeSql();
        const secrets = new PluginSecrets(fake.sql);
        await secrets.deleteUser('plugin', 'user1', 'access_token');
        const del = fake.calls.find((c) =>
            c.template.includes('DELETE FROM plugin_user_credentials'),
        );
        expect(del).toBeDefined();
        // pluginId, userId, key are bound as values
        expect(del!.values).toEqual(['plugin', 'user1', 'access_token']);
    });
});

describe('PluginSecrets.listUserKeys / listLinkedUserIds / listUserIdsWithKey', () => {
    it('listUserKeys returns the key names', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT DISTINCT key', [{ key: 'access_token' }, { key: 'refresh_token' }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        const keys = await secrets.listUserKeys('plugin', 'user1');
        expect(keys).toEqual(['access_token', 'refresh_token']);
    });

    it('listLinkedUserIds dedupes via DISTINCT user_id', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT DISTINCT user_id', [{ user_id: 'alice' }, { user_id: 'bob' }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        const users = await secrets.listLinkedUserIds('plugin');
        expect(users).toEqual(['alice', 'bob']);
    });

    it('listUserIdsWithKey filters by both plugin and key', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT DISTINCT user_id', [{ user_id: 'alice' }]],
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);
        const users = await secrets.listUserIdsWithKey('plugin', 'access_token');
        expect(users).toEqual(['alice']);

        const sel = fake.calls.find((c) => c.template.includes('SELECT DISTINCT user_id'));
        expect(sel).toBeDefined();
        // plugin id + key threaded as values
        expect(sel!.values).toEqual(['plugin', 'access_token']);
    });
});

describe('PluginSecrets cross-plugin isolation', () => {
    it('listLinkedUserIds is scoped to plugin_id (different plugins do not bleed)', async () => {
        // Two separate fake-sql instances simulate the host scoping: each
        // sql call binds the pluginId verbatim, so a query for plugin A can
        // never return user_ids from plugin B's namespace.
        const rowsByPlugin = new Map<string, SqlRow[]>([
            ['SELECT DISTINCT user_id', [{ user_id: 'alice' }]],
        ]);
        const fake = makeFakeSql(rowsByPlugin);
        const secrets = new PluginSecrets(fake.sql);

        await secrets.listLinkedUserIds('plugin-a');
        const callA = fake.calls.at(-1);
        expect(callA?.values).toEqual(['plugin-a']);

        await secrets.listLinkedUserIds('plugin-b');
        const callB = fake.calls.at(-1);
        expect(callB?.values).toEqual(['plugin-b']);
        // Distinct plugin ids on distinct invocations — the SQL parameter is
        // the only thing scoping the result, so isolation is contractually
        // enforced by the (plugin_id) clause in every query.
    });
});

describe('PluginSecrets.seedFromEnv', () => {
    it('seeds known env vars when table is empty', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT COUNT', [{ n: '0' }]], // table is empty
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        // Temporarily set an env var.
        process.env['_TEST_SEED_KEY'] = 'test-value';
        try {
            const { seeded } = await secrets.seedFromEnv({
                _TEST_SEED_KEY: { pluginId: 'test-plugin', key: 'test-secret' },
            });
            expect(seeded).toBe(1);
        } finally {
            delete process.env['_TEST_SEED_KEY'];
        }

        const insertCalls = fake.calls.filter((c) =>
            c.template.includes('INSERT INTO plugin_secrets'),
        );
        expect(insertCalls.length).toBe(1);
    });

    it('skips seeding when table already has rows', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([
            ['SELECT COUNT', [{ n: '5' }]], // not empty
        ]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const { seeded } = await secrets.seedFromEnv({
            OPENAI_API_KEY: { pluginId: 'openai', key: 'api_key' },
        });
        expect(seeded).toBe(0);
        const insertCalls = fake.calls.filter((c) =>
            c.template.includes('INSERT INTO plugin_secrets'),
        );
        expect(insertCalls.length).toBe(0);
    });

    it('skips env vars that are not set', async () => {
        const rowsByQuery = new Map<string, SqlRow[]>([['SELECT COUNT', [{ n: '0' }]]]);
        const fake = makeFakeSql(rowsByQuery);
        const secrets = new PluginSecrets(fake.sql);

        const { seeded } = await secrets.seedFromEnv({
            _DEFINITELY_NOT_SET_ENV_VAR_XYZ: { pluginId: 'p', key: 'k' },
        });
        expect(seeded).toBe(0);
    });
});
