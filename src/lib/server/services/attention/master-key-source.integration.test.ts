// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const state = vi.hoisted(() => ({
    keys: [] as string[],
    source: 'generated' as 'file' | 'generated',
    fingerprint: 'generation-1',
    hasSealedSecrets: false,
    generated: true,
}));
vi.mock('$lib/server/config/config.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/config/config.service.js')>()),
    getUndecryptableConfigKeys: () => [...state.keys],
}));
vi.mock('$lib/server/crypto/master-key.js', async (original) => ({
    ...(await original<typeof import('$lib/server/crypto/master-key.js')>()),
    getMasterKeySource: () => state.source,
    getMasterKeyBackupState: () =>
        state.generated
            ? {
                  fingerprint: state.fingerprint,
                  hasSealedSecrets: state.hasSealedSecrets,
              }
            : null,
    getMasterKeyFilePath: () => '/config/master.key',
    getMasterKeyFingerprint: () => state.fingerprint,
}));

import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ackAttention,
    deriveAttention,
    getAttention,
    resetAttentionSourceMemo,
    runAttentionDerivation,
} from './attention-service.js';

const GENERATED = 'settings:master-key:generated';
const UNDECRYPTABLE = 'settings:master-key:undecryptable';

describe('master-key attention persistence', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'settings:master-key:%'`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM admin_attention_alerts WHERE id LIKE 'settings:master-key:%'`;
        state.keys = [];
        state.source = 'generated';
        state.generated = true;
        state.fingerprint = 'generation-1';
        state.hasSealedSecrets = false;
        state.generated = true;
        resetAttentionSourceMemo();
    });

    // Exercise the real fan-out once, then restrict persistence to these ids so
    // unrelated host health and timers cannot decide these assertions.
    async function cycle(): Promise<void> {
        await runAttentionDerivation(sql, {
            derive: async () => {
                const outcome = await deriveAttention(sql);
                expect(outcome.failedPrefixes).not.toContain('settings:master-key:');
                return outcome.alerts.filter((alert) =>
                    alert.id.startsWith('settings:master-key:'),
                );
            },
        });
    }

    it('derives the backup notice on a fresh install and persists dismissal across cycles', async () => {
        await cycle();
        const notice = (await getAttention(sql)).items.find((item) => item.id === GENERATED);
        expect(notice).toMatchObject({
            acked: false,
            detail: 'Back up /config/master.key together with your database.',
        });
        state.source = 'file';
        await cycle();
        expect((await getAttention(sql)).items.find((item) => item.id === GENERATED)).toMatchObject(
            { acked: false, severity: 'info' },
        );
        expect(await ackAttention(sql, GENERATED, notice!.fingerprint, 'admin')).toBe(true);
        await cycle();
        expect((await getAttention(sql)).items.find((item) => item.id === GENERATED)?.acked).toBe(
            true,
        );
        const [persisted] = await sql<{ status: string; acked_by: string }[]>`
            SELECT status, acked_by FROM admin_attention_alerts WHERE id = ${GENERATED}
        `;
        expect(persisted).toEqual({ status: 'acked', acked_by: 'admin' });
        state.hasSealedSecrets = true;
        await cycle();
        expect((await getAttention(sql)).items.find((item) => item.id === GENERATED)).toMatchObject(
            { acked: true, severity: 'warning' },
        );
        state.fingerprint = 'generation-2';
        await cycle();
        expect((await getAttention(sql)).items.find((item) => item.id === GENERATED)?.acked).toBe(
            false,
        );
    });

    it('reports unreadable settings and resolves the warning as soon as they are repaired', async () => {
        state.source = 'file';
        state.generated = false;
        state.keys = ['TMDB_API_KEY', 'OPENAI_API_KEY'];
        await cycle();
        expect(
            (await getAttention(sql)).items.find((item) => item.id === UNDECRYPTABLE),
        ).toMatchObject({
            severity: 'warning',
            title: "Secrets can't be decrypted: 2 settings (TMDB_API_KEY, OPENAI_API_KEY)",
        });
        state.keys = [];
        await cycle();
        expect((await getAttention(sql)).items.some((item) => item.id === UNDECRYPTABLE)).toBe(
            false,
        );
        const [row] = await sql<{ status: string }[]>`
            SELECT status FROM admin_attention_alerts WHERE id = ${UNDECRYPTABLE}
        `;
        expect(row.status).toBe('resolved');
    });
});
