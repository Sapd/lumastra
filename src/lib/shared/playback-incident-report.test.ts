// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatIncidentReport, formatPlaybackIncidentsReport } from './playback-incident-report.js';
import type {
    PlaybackIncidentDetail,
    PlaybackIncidentSummary,
} from '$lib/schemas/api-playback-incidents.js';

const baseIncident: PlaybackIncidentDetail = {
    id: 1,
    attemptId: 'a1',
    playSessionId: 's1',
    incidentAt: '2026-08-13T12:00:00.000Z',
    serverRecordedAt: '2026-08-13T12:00:01.000Z',
    triggerType: 'error',
    errorType: 'network',
    stage: 'manifest',
    httpStatus: 502,
    serverDiagnosticCode: null,
    reconnectCause: null,
    message: 'fetch failed for https://example.com/x?token=SECRET123',
    userId: 'user-uuid-1',
    deviceId: 'device-abc',
    username: null,
    deviceName: null,
    mediaTitle: null,
    mediaId: null,
    resolvedAt: null,
    timeline: [{ t: 0, kind: 'seek' }],
    clientInfo: { userAgent: 'Mozilla/5.0 test-agent' },
};

describe('formatIncidentReport', () => {
    it('drops user_id/device_id/clientInfo entirely in github mode', () => {
        const report = formatIncidentReport(baseIncident, 'github', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(report).not.toContain('user-uuid-1');
        expect(report).not.toContain('device-abc');
        expect(report).not.toContain('Mozilla/5.0');
    });

    it('redacts a secret embedded in the message in BOTH modes', () => {
        const github = formatIncidentReport(baseIncident, 'github', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        const raw = formatIncidentReport(baseIncident, 'raw', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(github).not.toContain('SECRET123');
        expect(raw).not.toContain('SECRET123');
    });

    it('includes identity fields in raw mode', () => {
        const raw = formatIncidentReport(baseIncident, 'raw', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(raw).toContain('user-uuid-1');
        expect(raw).toContain('device-abc');
    });

    it('includes the timeline as readable content in both modes', () => {
        const report = formatIncidentReport(baseIncident, 'github', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(report).toContain('seek');
    });

    it('redacts a library-root path in an apostrophe-containing message without truncating at the apostrophe (github mode)', () => {
        const incident: PlaybackIncidentDetail = {
            ...baseIncident,
            message:
                "fetch failed for /data/music/Guns N' Roses/Appetite for Destruction/01 - Welcome to the Jungle.flac",
        };
        const report = formatIncidentReport(incident, 'github', {
            libraryRoots: ['/data/music'],
            transcodeRoot: '',
        });
        expect(report).not.toContain('Guns N');
        expect(report).not.toContain('Appetite for Destruction');
        expect(report).not.toContain('Welcome to the Jungle');
        expect(report).toContain('<media>/<redacted>.flac');
    });

    it('sanitizes errorType/stage/reconnectCause free-text fields in github mode', () => {
        const incident: PlaybackIncidentDetail = {
            ...baseIncident,
            errorType: '/data/music/Guns N Roses/leak.flac',
            stage: '/data/music/Guns N Roses/leak.flac',
            reconnectCause: '/data/music/Guns N Roses/leak.flac',
        };
        const report = formatIncidentReport(incident, 'github', {
            libraryRoots: ['/data/music'],
            transcodeRoot: '',
        });
        expect(report).not.toContain('leak.flac');
    });

    it('includes mediaId in raw mode identity fields', () => {
        const incident: PlaybackIncidentDetail = { ...baseIncident, mediaId: 'media-uuid-1' };
        const raw = formatIncidentReport(incident, 'raw', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(raw).toContain('media-uuid-1');
    });

    it('includes correlated transcode failures when provided', () => {
        const report = formatIncidentReport(
            baseIncident,
            'github',
            { libraryRoots: [], transcodeRoot: '' },
            [{ occurredAt: '2026-08-13T11:59:00.000Z', category: 'gpu-failure', summary: 'boom' }],
        );
        expect(report).toContain('Related transcode failures');
        expect(report).toContain('gpu-failure');
        expect(report).toContain('boom');
    });

    it('omits the "Related transcode failures" section when none are provided', () => {
        const report = formatIncidentReport(baseIncident, 'github', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        expect(report).not.toContain('Related transcode failures');
    });

    it('does not let a triple-backtick timeline value close the surrounding code fence early', () => {
        const incident: PlaybackIncidentDetail = {
            ...baseIncident,
            timeline: [{ t: 0, kind: 'note', text: '```danger```' }],
        };
        const report = formatIncidentReport(incident, 'github', {
            libraryRoots: [],
            transcodeRoot: '',
        });
        // Exactly two real ``` fences should remain: the Timeline block's open/close.
        const fenceMatches = report.match(/```/g) ?? [];
        expect(fenceMatches).toHaveLength(2);
    });
});

describe('formatPlaybackIncidentsReport (page-level "Copy for GitHub")', () => {
    const ROOTS = { libraryRoots: ['/data/music'], transcodeRoot: '/tmp/transcode' };
    const summary: PlaybackIncidentSummary = {
        id: 42,
        attemptId: 'attempt-42',
        playSessionId: 'session-42',
        incidentAt: '2026-09-10T08:00:00.000Z',
        serverRecordedAt: '2026-09-10T08:00:01.000Z',
        triggerType: 'error',
        errorType: 'media',
        stage: 'segment',
        httpStatus: 503,
        serverDiagnosticCode: 'session-expired',
        reconnectCause: null,
        message: "decode failed for /data/music/Guns N' Roses/01.flac?token=SEKRET",
        userId: 'user-uuid-42',
        deviceId: 'device-42',
        mediaId: 'media-uuid-42',
        username: 'testuser',
        deviceName: "Testuser's iPhone",
        mediaTitle: 'Welcome to the Jungle',
        resolvedAt: null,
    };

    it('renders the visible rows as one table with no user, device or media identity', () => {
        const out = formatPlaybackIncidentsReport({
            incidents: [
                summary,
                {
                    ...summary,
                    id: 43,
                    triggerType: 'reconnect',
                    errorType: null,
                    reconnectCause: 'stall',
                    resolvedAt: '2026-09-10T08:01:00.000Z',
                },
            ],
            roots: ROOTS,
        });
        expect(out).toContain('### Playback incidents (2 rows)');
        expect(out).toContain(
            '| 2026-09-10T08:00:00.000Z | `error` | media | segment | 503 | `session-expired` | — | no |',
        );
        expect(out).toContain(
            '| `reconnect` | — | segment | 503 | `session-expired` | stall | yes |',
        );
        for (const identity of [
            'testuser',
            "Testuser's iPhone",
            'Welcome to the Jungle',
            'user-uuid-42',
            'device-42',
            'media-uuid-42',
            'attempt-42',
            'session-42',
        ]) {
            expect(out).not.toContain(identity);
        }
    });

    it('redacts paths and secrets in the free-text columns', () => {
        const out = formatPlaybackIncidentsReport({
            incidents: [
                {
                    ...summary,
                    errorType: "/data/music/Guns N' Roses/leak.flac",
                    stage: 'x?token=SEKRET',
                },
            ],
            roots: ROOTS,
        });
        expect(out).toContain('<media>/<redacted>.flac');
        expect(out).not.toContain('Guns N');
        expect(out).not.toContain('SEKRET');
    });

    it('flags a user-filtered page in the banner', () => {
        const out = formatPlaybackIncidentsReport({
            incidents: [summary],
            userFiltered: true,
            roots: ROOTS,
        });
        expect(out).toContain('(filtered to one user)');
    });

    it('says so explicitly when the list is empty', () => {
        const out = formatPlaybackIncidentsReport({ incidents: [], roots: ROOTS });
        expect(out).toContain('_No incidents recorded._');
    });

    it('uses the github-mode single-incident report for an open drawer, plus allowlisted client fields only', () => {
        const detail: PlaybackIncidentDetail = {
            ...summary,
            timeline: [{ t: 0, kind: 'seek' }],
            clientInfo: {
                userAgent: 'Mozilla/5.0 test-agent',
                playMethod: 'Transcode',
                videoCodec: 'hevc',
            },
        };
        const out = formatPlaybackIncidentsReport({
            incidents: [summary],
            selected: {
                incident: detail,
                correlatedTranscodeFailures: [
                    {
                        occurredAt: '2026-09-10T07:59:00.000Z',
                        category: 'gpu-failure',
                        summary: 'boom',
                    },
                ],
            },
            roots: ROOTS,
        });
        expect(out).toContain('### Playback incident — `error`');
        expect(out).toContain('seek');
        expect(out).toContain('Related transcode failures');
        expect(out).toContain('- **playMethod**: Transcode');
        expect(out).toContain('- **videoCodec**: hevc');
        expect(out).not.toContain('Mozilla/5.0');
        expect(out).not.toContain('user-uuid-42');
        expect(out).not.toContain('device-42');
        expect(out).toContain('<media>/<redacted>.flac');
        expect(out).not.toContain('SEKRET');
        // The table of other rows is NOT appended — the drawer scopes the copy.
        expect(out).not.toContain('### Playback incidents (');
    });
});
