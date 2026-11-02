// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
    healthComponentEntries,
    healthSummary,
    healthView,
    healthViewUrl,
} from './health-workspace';
import { searchMeta } from '../../../../routes/admin/system/health/search-meta';

describe('health workspace navigation', () => {
    it.each(['components', 'dependencies', 'providers', 'files', 'security'])(
        'opens legacy #%s links even from another saved view',
        (anchor) => {
            expect(
                healthView(
                    new URL(`https://example.test/admin/system/health?view=history#${anchor}`),
                ),
            ).toBe('diagnostics');
        },
    );
    it.each(['activity', 'trends'])('opens #%s in history', (anchor) => {
        expect(healthView(new URL(`https://example.test/#${anchor}`))).toBe('history');
    });
    it('preserves cluster links and lets findings links escape cluster', () => {
        expect(healthView(new URL('https://example.test/?tab=cluster'))).toBe('cluster');
        expect(healthView(new URL('https://example.test/?tab=cluster#findings'))).toBe('overview');
    });
    it('clears stale anchors and preserves unrelated URL parameters', () => {
        const url = healthViewUrl(
            new URL('https://example.test/?tab=cluster&filter=keep#files'),
            'history',
        );
        expect(url.search).toBe('?filter=keep&view=history');
        expect(url.hash).toBe('');
        expect(healthView(url)).toBe('history');
    });
    it('every search-meta tab opens the view it names', () => {
        const tabs = searchMeta.tabs ?? [];
        expect(tabs.map((t) => t.id)).toEqual(['overview', 'diagnostics', 'history', 'cluster']);
        for (const tab of tabs) {
            const url = new URL(
                `https://example.test/admin/system/health?${tab.param ?? 'tab'}=${tab.id}`,
            );
            expect(healthView(url)).toBe(tab.id);
        }
    });
    it('falls back for an unsupported view', () => {
        expect(healthView(new URL('https://example.test/?view=other'))).toBe('overview');
    });
});

describe('canonical health summary', () => {
    const payload = {
        verdict: 'healthy' as const,
        attention: { items: [{ acked: true }, { snoozed: true }, {}] },
    };
    it('excludes acknowledged and snoozed items without upgrading informational findings', () => {
        expect(healthSummary(payload, false)).toEqual({ verdict: 'healthy', count: 1 });
    });
    it('preserves the server critical verdict', () => {
        expect(healthSummary({ ...payload, verdict: 'critical' }, false).verdict).toBe('critical');
    });
    it('never considers missing, unavailable, or stale successful data healthy', () => {
        expect(healthSummary(null, false)).toEqual({ verdict: 'unknown', count: undefined });
        expect(healthSummary(payload, true).verdict).toBe('unknown');
        expect(
            healthSummary({ ...payload, attention: { items: [], unavailable: true } }, false),
        ).toEqual({ verdict: 'unknown', count: undefined });
    });
});

describe('healthComponentEntries', () => {
    it('a failed Valkey capacity probe stays a listed (and counted) component', () => {
        const entries = healthComponentEntries({
            timestamp: '2026-10-06T10:00:00Z',
            database: { status: 'pass' },
            valkeyCapacity: { status: 'fail', error: 'INFO memory timed out' },
        });
        expect(entries.map((e) => e.name)).toEqual(['database', 'valkeyCapacity']);
    });

    it('a working capacity probe renders in its own block, not in the list', () => {
        const entries = healthComponentEntries({
            database: { status: 'pass' },
            valkeyCapacity: { status: 'pass', instances: [] },
        });
        expect(entries.map((e) => e.name)).toEqual(['database']);
    });

    it('no report, no entries', () => {
        expect(healthComponentEntries(null)).toEqual([]);
    });
});
