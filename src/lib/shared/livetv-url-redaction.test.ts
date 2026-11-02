// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect } from 'vitest';
import { redactLiveTvUrl, redactLiveTvUrlsInText } from './livetv-url-redaction.js';

const U = 'subscriber7731';
const P = 'Xq9vT2mLpK';

describe('redactLiveTvUrl', () => {
    test.each([
        [
            'Xtream playlist path',
            `http://host:8080/playlist/${U}/${P}/m3u_plus`,
            'http://host:8080/playlist/***/***/m3u_plus',
        ],
        ['Xtream EPG path', `http://host:8080/epg/${U}/${P}`, 'http://host:8080/epg/***/***'],
        [
            'Xtream live stream path',
            `http://host/live/${U}/${P}/12345.ts`,
            'http://host/live/***/***/12345.ts',
        ],
        [
            'Xtream movie path',
            `http://host/movie/${U}/${P}/999.mkv`,
            'http://host/movie/***/***/999.mkv',
        ],
        [
            'Xtream series path',
            `http://host/series/${U}/${P}/42.mp4`,
            'http://host/series/***/***/42.mp4',
        ],
        [
            'Xtream timeshift path',
            `http://host/timeshift/${U}/${P}/60/2026-09-30:10-00/77.ts`,
            'http://host/timeshift/***/***/60/2026-09-30:10-00/77.ts',
        ],
        [
            'get.php query credentials',
            `http://host/get.php?username=${U}&password=${P}&type=m3u_plus`,
            'http://host/get.php?username=***&password=***&type=m3u_plus',
        ],
        [
            'xmltv.php query credentials',
            `http://host/xmltv.php?username=${U}&password=${P}`,
            'http://host/xmltv.php?username=***&password=***',
        ],
        ['userinfo', `http://${U}:${P}@host:8080/list.m3u`, 'http://***@host:8080/list.m3u'],
        [
            'token / api_key / camelCase secret params',
            'https://host/a.m3u?token=abc&api_key=def&accessToken=ghi&region=de',
            'https://host/a.m3u?token=***&api_key=***&accessToken=***&region=de',
        ],
        [
            'short Xtream stream form via the opaque-segment fallback',
            `http://host:8080/${U}/${P}/12345`,
            'http://host:8080/***/***/12345',
        ],
        ['fragment', 'http://host/list.m3u#secret', 'http://host/list.m3u#***'],
    ])('%s', (_label, input, expected) => {
        const out = redactLiveTvUrl(input);
        expect(out).toBe(expected);
        expect(out).not.toContain(U);
        expect(out).not.toContain(P);
    });

    test('a plain URL without credentials stays readable', () => {
        for (const url of [
            'https://iptv-org.github.io/iptv/countries/de.m3u',
            'http://epg.example.com:8080/guide.xml.gz',
            'http://192.168.1.10:5004/lineup.json',
            'https://cdn.example.net/hls/channel/index.m3u8?region=de',
        ]) {
            expect(redactLiveTvUrl(url)).toBe(url);
        }
    });

    test('keeps scheme, host and port', () => {
        expect(redactLiveTvUrl(`rtsp://${U}:${P}@[::1]:554/live/${U}/${P}/1`)).toBe(
            'rtsp://***@[::1]:554/live/***/***/1',
        );
    });

    test('invalid input does not throw and does not echo the input', () => {
        for (const bad of [`not a url ${P}`, `http://`, `://${U}/${P}`, '%%%']) {
            let out = '';
            expect(() => {
                out = redactLiveTvUrl(bad);
            }).not.toThrow();
            expect(out).not.toContain(P);
        }
        expect(redactLiveTvUrl('')).toBe('');
        expect(() => redactLiveTvUrl(undefined as unknown as string)).not.toThrow();
    });

    test('is idempotent', () => {
        const once = redactLiveTvUrl(`http://host/playlist/${U}/${P}/m3u_plus?password=${P}`);
        expect(redactLiveTvUrl(once)).toBe(once);
    });
});

describe('redactLiveTvUrlsInText', () => {
    test('redacts a URL embedded in an error message, keeping trailing punctuation', () => {
        const text = `Failed to fetch M3U: request to http://host:8080/playlist/${U}/${P}/m3u_plus.`;
        expect(redactLiveTvUrlsInText(text)).toBe(
            'Failed to fetch M3U: request to http://host:8080/playlist/***/***/m3u_plus.',
        );
    });

    test('redacts inside JSON without breaking it', () => {
        const json = JSON.stringify({
            url: `http://host/live/${U}/${P}/1.ts`,
            note: `Opening "http://host/xmltv.php?username=${U}&password=${P}"\n`,
        });
        const out = redactLiveTvUrlsInText(json);
        expect(out).not.toContain(U);
        expect(out).not.toContain(P);
        expect(JSON.parse(out)).toEqual({
            url: 'http://host/live/***/***/1.ts',
            note: 'Opening "http://host/xmltv.php?username=***&password=***"\n',
        });
    });

    test('redacts bare Xtream paths and bare credential params', () => {
        const text = `GET /epg/${U}/${P} returned 403; retry with username=${U}&password=${P}`;
        const out = redactLiveTvUrlsInText(text);
        expect(out).toBe('GET /epg/***/*** returned 403; retry with username=***&password=***');
    });

    test('leaves text without URLs alone', () => {
        const text = 'M3U refresh parsed zero channels';
        expect(redactLiveTvUrlsInText(text)).toBe(text);
    });
});
