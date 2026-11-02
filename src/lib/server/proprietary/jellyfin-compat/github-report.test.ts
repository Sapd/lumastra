// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, expect, it } from 'vitest';
import {
    buildGithubReport,
    idTag,
    isReportable,
    scrubForPublic,
    ISSUE_URL_MAX,
} from './github-report';

const incident = {
    serverVersion: 'v0.1.0',
    secret: 's3cret',
    kind: 'compat_incident',
    platform: 'other',
    appVersion: '0.19.10',
    occurredAt: '2026-10-06T20:00:00.000Z',
    payload: {
        source: 'jellyfin_compat',
        reason: 'silent_start',
        clientName: 'Jellyfin Android TV',
        clientVersion: '0.19.10',
        deviceName: "Testguest's Fire TV",
        misses: [
            {
                itemId: '6a0e1c7e-1111-4222-8333-944455556666',
                armedAt: 1,
                shape: {
                    container: 'mkv',
                    streams: [{ type: 'Subtitle', codec: 'srt', external: true, text: true }],
                },
                violations: [
                    {
                        pointer: '/MediaSources/0/MediaStreams/2/IsInterlaced',
                        property: 'IsInterlaced',
                        kind: 'missing',
                        versions: ['1.7.1'],
                    },
                ],
            },
        ],
    },
};

describe('buildGithubReport', () => {
    it('only /j-sourced rows are reportable', () => {
        expect(isReportable({ kind: 'compat_incident', payload: {} })).toBe(true);
        expect(isReportable({ kind: 'log_bundle', payload: { source: 'jellyfin' } })).toBe(true);
        expect(isReportable({ kind: 'log_bundle', payload: {} })).toBe(false);
        expect(isReportable({ kind: 'crash', payload: {} })).toBe(false);
    });
    it('carries the technical facts and violations', () => {
        const r = buildGithubReport(incident);
        expect(r.markdown).toContain('Jellyfin Android TV 0.19.10');
        expect(r.markdown).toContain('IsInterlaced');
        expect(r.report).toMatchObject({
            serverVersion: 'v0.1.0',
            client: { name: 'Jellyfin Android TV', version: '0.19.10' },
        });
    });
    it('never leaks names or raw ids: only allowlisted keys survive', () => {
        const json = JSON.stringify(buildGithubReport(incident));
        expect(json).not.toContain('Testguest');
        expect(json).not.toContain('6a0e1c7e-1111-4222-8333-944455556666');
        expect(json).toContain(idTag('s3cret', '6a0e1c7e-1111-4222-8333-944455556666'));
    });
    it('unknown payload keys are dropped (property-style check over random keys)', () => {
        for (let i = 0; i < 50; i++) {
            const key = `k${Math.random().toString(36).slice(2)}`;
            const r = buildGithubReport({
                ...incident,
                payload: { ...incident.payload, [key]: 'SECRET-VALUE' },
            });
            expect(JSON.stringify(r)).not.toContain('SECRET-VALUE');
        }
    });
    it('builds a prefilled issue-form URL under the cap, truncating the log first', () => {
        const r = buildGithubReport({
            ...incident,
            kind: 'log_bundle',
            payload: { source: 'jellyfin', clientName: 'Jellyfin Android TV' },
            logText: 'x\n'.repeat(20_000),
        });
        const u = new URL(r.issueUrl);
        expect(u.origin + u.pathname).toBe('https://github.com/Sapd/lumastra/issues/new');
        expect(u.searchParams.get('template')).toBe('jellyfin-client.yml');
        expect(u.searchParams.get('client')).toContain('Jellyfin Android TV');
        expect(r.issueUrl.length).toBeLessThanOrEqual(ISSUE_URL_MAX);
    });
});

describe('log excerpt neutralisation', () => {
    it('cannot close the code block or ping anyone in the public issue', () => {
        const r = buildGithubReport({
            ...incident,
            kind: 'log_bundle',
            payload: { source: 'jellyfin', clientName: 'Jellyfin Android TV' },
            logText: 'boom\n```\n@someone [x](http://x) </details>\n`````',
        });
        const logs = new URL(r.issueUrl).searchParams.get('logs') ?? '';
        expect(logs).toContain('boom');
        expect(logs).not.toContain('```');
        expect(logs).not.toContain('@');
        const excerpt = String((r.report as { logExcerpt?: string }).logExcerpt);
        expect(excerpt).not.toContain('```');
        expect(excerpt).not.toContain('@');
    });
});

describe('scrubForPublic', () => {
    it('removes IPv4, IPv6, tokens, emails and URL hosts', () => {
        const s = scrubForPublic(
            'GET http://192.168.1.20:8096/Items?api_key=abc from fe80::1 by a@b.de X-MediaBrowser-Token: zzz https://media.example.org/x',
        );
        expect(s).not.toMatch(/192\.168|fe80::1|abc|a@b\.de|zzz|media\.example\.org/);
    });
    it('removes loopback and full-form IPv6', () => {
        const s = scrubForPublic(
            'peer ::1 and 2001:0db8:85a3:0000:0000:8a2e:0370:7334 and 2001:db8::ff00:42:8329',
        );
        expect(s).not.toMatch(/::1|2001|db8|8329/);
    });
    it('keeps timestamps readable', () => {
        expect(scrubForPublic('at 12:34:56 something')).toContain('something');
    });
});

describe('scrubForPublic hardening', () => {
    const hdr =
        'Client="Android TV", Device="TestDevice Fire TV", DeviceId="abc123dev", Version="0.19.10", Token="deadbeefcafe"';
    for (const prefix of [
        'X-Emby-Authorization: MediaBrowser ',
        'Authorization: MediaBrowser ',
        'MediaBrowser ',
    ]) {
        it(`redacts the auth header parameters (${prefix.trim()})`, () => {
            const s = scrubForPublic(`${prefix}${hdr}`);
            expect(s).not.toMatch(/deadbeefcafe|abc123dev|TestDevice|Fire TV/);
        });
    }
    it('redacts loose Token=/DeviceId= pairs', () => {
        const s = scrubForPublic('Token=deadbeefcafe, DeviceId=abc123dev, UserId="u-1"');
        expect(s).not.toMatch(/deadbeefcafe|abc123dev|u-1/);
    });
    it('redacts ws:// and wss:// hosts', () => {
        const s = scrubForPublic(
            'ws://10.0.0.5:8096/socket wss://media.example.org/socket?api_key=zz',
        );
        expect(s).not.toMatch(/10\.0|media\.example|zz/);
    });
    it('tags raw ids in log text with the same HMAC tag as the structured fields', () => {
        const id = '6A0E1C7E-1111-4222-8333-944455556666';
        const s = scrubForPublic(
            `GET /Items/${id}/PlaybackInfo user 0123456789abcdef0123456789abcdef`,
            's3cret',
        );
        expect(s).not.toMatch(/6a0e1c7e|0123456789abcdef/i);
        expect(s).toContain(idTag('s3cret', id));
    });
    it('does not backtrack on pathological colon runs', () => {
        const t0 = Date.now();
        scrubForPublic(':'.repeat(200_000));
        expect(Date.now() - t0).toBeLessThan(200);
    });
    it('caps long log lines before scrubbing', () => {
        const r = buildGithubReport({
            ...incident,
            kind: 'log_bundle',
            payload: { source: 'jellyfin' },
            logText: ':'.repeat(300_000),
        });
        const t0 = Date.now();
        buildGithubReport({
            ...incident,
            kind: 'log_bundle',
            payload: { source: 'jellyfin' },
            logText: ':'.repeat(300_000),
        });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(String(r.report.logExcerpt).length).toBeLessThan(2100);
    });
    it('client-supplied strings cannot form mentions or links', () => {
        const r = buildGithubReport({
            ...incident,
            payload: {
                ...incident.payload,
                clientName: '@someone [x](http://evil) <b>',
                clientVersion: 'Token="deadbeefcafe"',
            },
        });
        const all = r.markdown + r.issueUrl + JSON.stringify(r.report);
        expect(all).not.toMatch(/@someone|\]\(|<b>|deadbeefcafe/);
    });
    it('ids in the log excerpt are tagged, not raw', () => {
        const id = '6a0e1c7e-1111-4222-8333-944455556666';
        const r = buildGithubReport({ ...incident, logText: `GET /Items/${id}/PlaybackInfo` });
        expect(JSON.stringify(r)).not.toContain(id);
        expect(JSON.stringify(r)).toContain(idTag('s3cret', id));
    });
});

describe('scrubForPublic — host forms', () => {
    const log = [
        'Connecting to media.testuser-home.de',
        'GET media.testuser-home.de:8096/System/Info',
        'ExoPlayer source: host:8096 jellyfin-box.lan:8920 localhost:8096',
        'java.net.ConnectException: failed to connect to jf.example.org/203.0.113.4 (port 8096)',
        'java.net.UnknownHostException: Unable to resolve host "jf.example.org": No address',
        '  at org.jellyfin.sdk.api.client.KtorClient.request(KtorClient.kt:123)',
        '  at org.jellyfin.playback.core.PlaybackManager.play(PlaybackManager.kt:88)',
        'go to settings/playback and retry',
    ].join('\n');

    it("removes the server's own host, host:port tokens and the OkHttp host forms", () => {
        const s = scrubForPublic(log, '', ['media.testuser-home.de']);
        expect(s).not.toContain('testuser-home');
        expect(s).not.toContain('jellyfin-box.lan');
        expect(s).not.toContain('localhost:8096');
        expect(s).not.toContain('jf.example.org');
        expect(s).not.toContain('203.0.113.4');
        expect(s).toContain('[host]:8920');
        expect(s).toContain('failed to connect to [host]/[ip]');
    });

    it('keeps Java package names, stack frames and prose', () => {
        const s = scrubForPublic(log, '', ['media.testuser-home.de']);
        expect(s).toContain('org.jellyfin.sdk.api.client.KtorClient.request(KtorClient.kt:123)');
        expect(s).toContain('PlaybackManager.kt:88');
        expect(s).toContain('go to settings/playback');
    });

    it('a single-label own host is removed as a word, not inside a package name', () => {
        const s = scrubForPublic('Host jellyfin replied; org.jellyfin.sdk.api.client', '', [
            'jellyfin',
        ]);
        expect(s).toContain('Host [host] replied');
        expect(s).toContain('org.jellyfin.sdk.api.client');
    });

    it('buildGithubReport scrubs serverHosts from the log excerpt and client strings', () => {
        const r = buildGithubReport({
            ...incident,
            kind: 'log_bundle',
            payload: { source: 'jellyfin', clientName: 'Jellyfin Android' },
            logText: log,
            serverHosts: ['media.testuser-home.de'],
        });
        const all = JSON.stringify(r);
        expect(all).not.toContain('testuser-home');
        expect(all).not.toContain('jf.example.org');
        expect(r.report.logExcerpt).toContain('org.jellyfin.sdk.api.client');
    });
});
