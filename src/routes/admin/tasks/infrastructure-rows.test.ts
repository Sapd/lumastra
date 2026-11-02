// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { AdminStatusResponse } from '$lib/schemas/api-admin-responses.js';
import {
    buildInfrastructureRows,
    formatAgo,
    STALE_HEARTBEAT_THRESHOLD_MS,
} from './infrastructure-rows.js';

const NOW = Date.parse('2026-05-18T12:00:00.000Z');

function makeStatus(
    watcher?: NonNullable<NonNullable<AdminStatusResponse['lumastraChecks']>['watcher']>,
): AdminStatusResponse {
    return {
        aiHealthy: true,
        databaseHealthy: true,
        databaseVersion: 'pg18',
        valkeyHealthy: true,
        valkeyVersion: 'v9',
        totalMediaItems: 0,
        libraryEmbeddings: 0,
        primaryProviderEmbeddings: 0,
        bothEmbeddings: 0,
        totalUsers: 0,
        totalSuggestions: 0,
        services: {
            jellyfin: { configured: false, label: 'Jellyfin' },
            tmdb: { configured: false, label: 'TMDB' },
            mdblist: { configured: false, label: 'MDBList' },
            jellyseerr: { configured: false, label: 'Jellyseerr' },
            sonarr: { configured: false, label: 'Sonarr' },
            radarr: { configured: false, label: 'Radarr' },
            audiobookshelf: { configured: false, label: 'Audiobookshelf' },
            openai: { configured: false, label: 'OpenAI' },
            voyage: { configured: false, label: 'Voyage AI' },
            trickplay: { configured: false, label: 'Self-Generated Trickplay' },
        },
        databaseUrlConfigured: true,
        databaseConnectionAvailable: true,
        tablesChecked: true,
        setupInstructions: null,
        trickplayStats: null,
        lumastraChecks: watcher
            ? {
                  ffmpeg: { ok: true, message: 'Available' },
                  ffprobe: { ok: true, message: 'Available' },
                  hlsAvailable: true,
                  fileAccess: {
                      ok: true,
                      accessible: 10,
                      total: 10,
                      message: 'ok',
                  },
                  watcher,
                  overallHealthy: true,
              }
            : undefined,
    };
}

describe('formatAgo', () => {
    it('rounds to seconds under a minute', () => expect(formatAgo(45_000)).toBe('45s'));
    it('rounds to minutes under an hour', () => expect(formatAgo(120_000)).toBe('2m'));
    it('rounds to hours under a day', () => expect(formatAgo(7_200_000)).toBe('2h'));
    it('rounds to days otherwise', () => expect(formatAgo(86_400_000 * 3)).toBe('3d'));
    it('clamps negatives to 0s', () => expect(formatAgo(-500)).toBe('0s'));
});

describe('buildInfrastructureRows', () => {
    it('returns empty list when status is null', () => {
        expect(buildInfrastructureRows(null, NOW)).toEqual([]);
    });

    it('returns empty list when lumastraChecks is absent', () => {
        const status = makeStatus();
        expect(buildInfrastructureRows(status, NOW)).toEqual([]);
    });

    it('active-here renders ok row with path count and last event', () => {
        const status = makeStatus({
            active: true,
            paths: 9,
            lastEventAt: new Date(NOW - 120_000).toISOString(),
            leaderElsewhere: false,
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows).toHaveLength(1);
        expect(rows[0].severity).toBe('ok');
        expect(rows[0].message).toContain('active here · 9 paths');
        expect(rows[0].message).toContain('last event 2m ago');
    });

    it('active-here with no events yet shows "no events yet"', () => {
        const status = makeStatus({
            active: true,
            paths: 3,
            leaderElsewhere: false,
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].message).toContain('no events yet');
    });

    it('leader-elsewhere with fresh heartbeat renders ok row', () => {
        const status = makeStatus({
            active: false,
            paths: 9,
            leaderElsewhere: true,
            leaderHeartbeatAt: new Date(NOW - 4000).toISOString(),
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('ok');
        expect(rows[0].message).toContain('handled by another server');
        expect(rows[0].message).toContain('last checked in 4s ago');
    });

    it('leader-elsewhere with stale heartbeat (>2x interval) renders warn row', () => {
        const status = makeStatus({
            active: false,
            paths: 9,
            leaderElsewhere: true,
            leaderHeartbeatAt: new Date(NOW - (STALE_HEARTBEAT_THRESHOLD_MS + 1000)).toISOString(),
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('warn');
        expect(rows[0].message).toContain("hasn't checked in for");
        expect(rows[0].icon).toBe('⚠️');
    });

    it('no leader anywhere (inactive + not elsewhere) renders warn row', () => {
        const status = makeStatus({
            active: false,
            paths: 0,
            leaderElsewhere: false,
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('warn');
        expect(rows[0].message).toContain('no server is currently watching');
    });

    it('leaderElsewhere=true but no heartbeatAt → distinct warn ("leader claim without heartbeat")', () => {
        const status = makeStatus({
            active: false,
            paths: 9,
            leaderElsewhere: true,
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('warn');
        expect(rows[0].message).toContain('another server claims to be handling it');
        // Distinct from "no server is watching" — operator shouldn't restart a healthy peer
        expect(rows[0].message).not.toContain('no server is currently watching');
    });

    it('leaderError populated → emits second warn row even if leader otherwise ok', () => {
        const status = makeStatus({
            active: true,
            paths: 9,
            leaderElsewhere: false,
            leaderError: 'inotify watch limit reached',
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows).toHaveLength(2);
        expect(rows[0].severity).toBe('ok'); // active-here
        expect(rows[1].id).toBe('file-watcher-error');
        expect(rows[1].severity).toBe('warn');
        expect(rows[1].message).toContain('inotify watch limit reached');
    });

    it('partial coverage is a warning, not healthy', () => {
        const rows = buildInfrastructureRows(
            makeStatus({
                active: true,
                paths: 3,
                leaderElsewhere: false,
                coverage: 'partial',
                limitations: ['watch_limit'],
                leaderError: 'inotify limit: 10/20 dirs watched',
            }),
            NOW,
        );
        expect(rows[0].severity).toBe('warn');
        expect(rows[0].message).toContain('partial coverage');
        expect(rows.at(-1)!.message).toContain('inotify limit: 10/20 dirs watched');
    });

    it('network_shares limitation shows the live-updates notice', () => {
        const rows = buildInfrastructureRows(
            makeStatus({
                active: true,
                paths: 3,
                leaderElsewhere: false,
                coverage: 'full',
                limitations: ['network_shares'],
            }),
            NOW,
        );
        expect(rows[0].severity).toBe('ok');
        expect(
            rows.some((row) => row.message.includes('Live updates limited on network shares')),
        ).toBe(true);
    });

    it('disabled network reconcile says only scheduled scans pick up network changes', () => {
        const rows = buildInfrastructureRows(
            makeStatus({
                active: true,
                paths: 3,
                leaderElsewhere: false,
                coverage: 'partial',
                limitations: ['network_shares', 'network_unreconciled'],
                networkReconcileSecs: 0,
            }),
            NOW,
        );
        const row = rows.find((r) => r.id === 'file-watcher-network')!;
        expect(row.severity).toBe('warn');
        expect(row.message).toContain('only picked up by scheduled scans');
    });

    it('enabled network reconcile names the interval', () => {
        const rows = buildInfrastructureRows(
            makeStatus({
                active: true,
                paths: 3,
                leaderElsewhere: false,
                coverage: 'full',
                limitations: ['network_shares'],
                networkReconcileSecs: 900,
            }),
            NOW,
        );
        expect(rows.find((r) => r.id === 'file-watcher-network')!.message).toContain(
            'every 15 min',
        );
    });

    it('stalled probes, stalled roots and unwatched dirs each get a warning row', () => {
        const rows = buildInfrastructureRows(
            makeStatus({
                active: true,
                paths: 3,
                leaderElsewhere: false,
                coverage: 'partial',
                limitations: ['stalled_probes', 'stalled_roots', 'unwatched_dirs'],
            }),
            NOW,
        );
        expect(rows.map((r) => r.id)).toEqual(
            expect.arrayContaining([
                'file-watcher-stalled',
                'file-watcher-stalled-roots',
                'file-watcher-unwatched',
            ]),
        );
    });

    it('negative heartbeat age (clock skew backward) clamps to 0s but still ok', () => {
        const status = makeStatus({
            active: false,
            paths: 9,
            leaderElsewhere: true,
            leaderHeartbeatAt: new Date(NOW + 5000).toISOString(),
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('ok');
        expect(rows[0].message).toContain('0s ago');
    });

    it('boundary: heartbeat exactly at threshold is still ok', () => {
        const status = makeStatus({
            active: false,
            paths: 9,
            leaderElsewhere: true,
            leaderHeartbeatAt: new Date(NOW - STALE_HEARTBEAT_THRESHOLD_MS).toISOString(),
        });
        const rows = buildInfrastructureRows(status, NOW);
        expect(rows[0].severity).toBe('ok');
    });
});
