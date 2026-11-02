// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Lumastra update notice: red and persistent for a pending security
 * release, a dismissable info item for a normal one, nothing once installed.
 */

import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { adaptLumastraUpdate } from './adapters.js';
import { ATTENTION_SOURCE_PREFIXES, ackAttention, snoozeAttention } from './attention-service.js';
import {
    evaluateUpdate,
    parseRunningVersion,
    type ReleaseInfo,
} from '../lumastra-update/version.js';
import {
    isPersistentAttentionId,
    LUMASTRA_SECURITY_UPDATE_ATTENTION_ID,
} from '$lib/shared/attention-persistent.js';

function rel(version: string, security = false): ReleaseInfo {
    return {
        version,
        url: `https://github.com/Sapd/lumastra/releases/tag/v${version}`,
        publishedAt: '2026-10-30T00:00:00Z',
        security,
        prerelease: false,
    };
}

const RELEASES = [rel('0.1.1', true), rel('0.1.2')];
const alertsFor = (running: string) =>
    adaptLumastraUpdate(evaluateUpdate(RELEASES, parseRunningVersion(running)), running);

describe('adaptLumastraUpdate', () => {
    it('a pending security release is one critical, persistent item naming the latest', () => {
        const alerts = alertsFor('v0.1.0');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            id: LUMASTRA_SECURITY_UPDATE_ATTENTION_ID,
            severity: 'critical',
            domain: 'updates',
            fingerprint: 'security@0.1.1',
        });
        expect(alerts[0].title).toContain('0.1.2');
        expect(alerts[0].detail).toContain('0.1.1');
        expect(alerts[0].detail).toContain('v0.1.0');
        expect(isPersistentAttentionId(alerts[0].id)).toBe(true);
        expect(alerts[0].actions[0].href).toBe('/admin/system/instance#updates');
    });

    it('past the fixed version, a normal update is a dismissable info item per version', () => {
        const alerts = alertsFor('v0.1.1');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
            id: 'lumastra-update:release',
            severity: 'info',
            fingerprint: '0.1.2',
        });
        expect(isPersistentAttentionId(alerts[0].id)).toBe(false);
    });

    it('clears after the upgrade', () => {
        expect(alertsFor('v0.1.2')).toEqual([]);
        expect(adaptLumastraUpdate(null, 'v0.1.2')).toEqual([]);
    });

    it('is registered, and its ids stay inside the registered namespace', () => {
        expect(ATTENTION_SOURCE_PREFIXES).toContain('lumastra-update:');
        for (const a of [...alertsFor('v0.1.0'), ...alertsFor('v0.1.1')]) {
            expect(a.id.startsWith('lumastra-update:')).toBe(true);
        }
    });
});

describe('update check failing', () => {
    const NOW = Date.parse('2026-11-10T00:00:00Z');
    const since = (days: number) => new Date(NOW - days * 24 * 3600_000).toISOString();
    const failing = (days: number, attemptDaysAgo = 0.1) => ({
        since: since(days),
        lastAttemptAt: since(attemptDaysAgo),
    });

    it('says nothing for the first three days', () => {
        expect(adaptLumastraUpdate(null, 'v0.1.0', failing(2.9), NOW)).toEqual([]);
        expect(
            adaptLumastraUpdate(null, 'v0.1.0', { since: null, lastAttemptAt: null }, NOW),
        ).toEqual([]);
    });

    it('then raises one quiet, dismissable item per failing streak', () => {
        const [a] = adaptLumastraUpdate(null, 'v0.1.0', failing(4), NOW);
        expect(a).toMatchObject({
            id: 'lumastra-update:check-failing',
            severity: 'info',
            fingerprint: since(4),
        });
        expect(a.title).toContain('4');
        expect(isPersistentAttentionId(a.id)).toBe(false);
    });

    it('stays quiet for a streak left over from before the check was switched off', () => {
        expect(adaptLumastraUpdate(null, 'v0.1.0', failing(30, 20), NOW)).toEqual([]);
    });

    it('stands next to a known update instead of replacing it', () => {
        const ids = adaptLumastraUpdate(
            evaluateUpdate(RELEASES, parseRunningVersion('v0.1.0')),
            'v0.1.0',
            failing(5),
            NOW,
        ).map((a) => a.id);
        expect(ids).toEqual([
            'lumastra-update:check-failing',
            LUMASTRA_SECURITY_UPDATE_ATTENTION_ID,
        ]);
    });
});

describe('persistent security notice', () => {
    // Any query reaching the database fails the test: the refusal must come first.
    const sql = new Proxy(() => {}, {
        apply() {
            throw new Error('database touched');
        },
        get() {
            throw new Error('database touched');
        },
    }) as unknown as postgres.Sql;

    it('cannot be acknowledged or snoozed', async () => {
        await expect(
            ackAttention(sql, LUMASTRA_SECURITY_UPDATE_ATTENTION_ID, 'security@0.1.1', 'admin'),
        ).resolves.toBe(false);
        await expect(
            snoozeAttention(sql, LUMASTRA_SECURITY_UPDATE_ATTENTION_ID, 'security@0.1.1', 60_000),
        ).resolves.toBe(false);
    });
});
