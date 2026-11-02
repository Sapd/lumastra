// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    keys: [] as string[],
    source: 'file' as 'env' | 'file' | 'generated' | 'none',
    path: '/config/master.key',
    fingerprint: 'generation-1',
    hasSealedSecrets: false,
    generated: false,
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
    getMasterKeyFilePath: () => state.path,
    getMasterKeyFingerprint: () => state.fingerprint,
}));

import { ATTENTION_SOURCE_PREFIXES, deriveMasterKeyAlerts } from './attention-service.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';

beforeEach(() => {
    state.keys = [];
    state.source = 'file';
    state.path = '/config/master.key';
    state.fingerprint = 'generation-1';
    state.hasSealedSecrets = false;
    state.generated = false;
});

describe('master-key attention source', () => {
    it('registers the namespace that protects both alerts on source failure', () => {
        expect(ATTENTION_SOURCE_PREFIXES).toContain('settings:master-key:');
    });

    it('names unreadable settings and gives the actual recovery path without secret values', async () => {
        state.keys = ['TMDB_API_KEY', 'OPENAI_API_KEY'];
        state.path = '/custom/config/master.key';
        const [alert] = await deriveMasterKeyAlerts();
        expect(alert).toMatchObject({
            id: 'settings:master-key:undecryptable',
            domain: 'settings',
            severity: 'warning',
            title: "Secrets can't be decrypted: 2 settings (TMDB_API_KEY, OPENAI_API_KEY)",
            detail: 'The master key changed or is missing. Restore /custom/config/master.key or re-enter the affected settings.',
            sourceRef: 'https://lumastra.org/guides/backup-recovery/',
        });
        expect(alert.actions[0].href).toBe(alert.sourceRef);
        expect(sectionForItem(alert)).toBe('settings');
    });

    it('updates immediately when settings are repaired, with no memoized result', async () => {
        state.keys = ['TMDB_API_KEY'];
        const [broken] = await deriveMasterKeyAlerts();
        expect(broken.title).toContain('1 setting (TMDB_API_KEY)');
        state.keys = [];
        expect(await deriveMasterKeyAlerts()).toEqual([]);
    });

    it.each(['env', 'file', 'none'] as const)(
        'has no backup notice for source %s',
        async (source) => {
            state.source = source;
            expect(await deriveMasterKeyAlerts()).toEqual([]);
        },
    );

    it('reports a generated key with a stable identity and the backup docs', async () => {
        state.source = 'generated';
        state.generated = true;
        const [alert] = await deriveMasterKeyAlerts();
        expect(alert).toMatchObject({
            id: 'settings:master-key:generated',
            severity: 'info',
            title: 'A new master key was generated on this server',
            detail: 'Back up /config/master.key together with your database.',
            sourceRef: 'https://lumastra.org/guides/backup-recovery/',
        });
        expect(await deriveMasterKeyAlerts()).toEqual([alert]);
        state.fingerprint = 'generation-2';
        const [newKey] = await deriveMasterKeyAlerts();
        expect(newKey.fingerprint).not.toBe(alert.fingerprint);
    });

    it('shows both notices after a lost key and keeps setting order out of incident identity', async () => {
        state.source = 'generated';
        state.generated = true;
        state.keys = ['TMDB_API_KEY', 'OPENAI_API_KEY'];
        const alerts = await deriveMasterKeyAlerts();
        expect(alerts.map((alert) => alert.id)).toEqual([
            'settings:master-key:undecryptable',
            'settings:master-key:generated',
        ]);
        state.keys.reverse();
        expect((await deriveMasterKeyAlerts())[0].fingerprint).toBe(alerts[0].fingerprint);
        state.keys.push('LASTFM_API_KEY');
        expect((await deriveMasterKeyAlerts())[0].fingerprint).not.toBe(alerts[0].fingerprint);
    });
});

it('keeps the notice on a different process and escalates only after sealing a secret', async () => {
    state.generated = true;
    state.source = 'file';
    expect((await deriveMasterKeyAlerts())[0]).toMatchObject({
        id: 'settings:master-key:generated',
        severity: 'info',
    });
    state.source = 'env';
    state.hasSealedSecrets = true;
    expect((await deriveMasterKeyAlerts())[0]).toMatchObject({
        id: 'settings:master-key:generated',
        severity: 'warning',
    });
});
