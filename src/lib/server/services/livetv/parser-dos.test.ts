// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hostile-provider input for the Live TV parsers. A playlist or guide host the
 * operator pointed at is untrusted and is re-fetched on a schedule, so one
 * crafted response must not stall the main process.
 *
 * Table-driven: every transform that sees provider text runs on adversarial
 * input sized so a quadratic or cubic regex takes seconds, and the budget is
 * generous so only a super-linear regression trips it. A new parser or field
 * transform belongs in the table.
 */

import { describe, expect, it } from 'vitest';
import { parseM3u } from './m3u-parser.js';
import { MAX_INPUT_SIZE, parseXmltv } from './xmltv-parser.js';
import {
    extractBaseName,
    hasFeedMarker,
    normalizeGroupTitle,
    processChannels,
} from './auto-processor.js';
import { lineupToM3u } from './hdhomerun-client.js';
import {
    DEFAULT_MAX_SOURCE_BYTES,
    M3U_MAX_FETCH_BYTES,
    XMLTV_MAX_FETCH_BYTES,
} from './fetch-source.js';
import type { M3uChannel } from './m3u-parser.js';

const BUDGET_MS = 1500;

function elapsed(fn: () => void): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

function xmltvProgramme(
    body: string,
    attrs = 'start="20260309051500 +0100" stop="20260309054500 +0100" channel="c1"',
): string {
    return `<tv><channel id="c1"><display-name>One</display-name></channel><programme ${attrs}>${body}</programme></tv>`;
}

function channel(name: string, groupTitle?: string): M3uChannel {
    return {
        tvgId: undefined,
        tvgName: undefined,
        name,
        logoUrl: undefined,
        groupTitle,
        streamUrl: 'http://provider.example/live/1.ts',
        countryCode: undefined,
        extras: {},
    };
}

const ADVERSARIAL: Array<{ name: string; run: () => void }> = [
    {
        name: 'M3U: one huge EXTINF line (ATTR_REGEX over the whole line)',
        run: () => {
            parseM3u(`#EXTM3U\n#EXTINF:-1,${'a'.repeat(160_000)}\nhttp://provider.example/1.ts\n`);
        },
    },
    {
        name: 'M3U: many unclosed attribute quotes on one line',
        run: () => {
            parseM3u(`#EXTINF:-1 ${'a="'.repeat(60_000)},x\nhttp://provider.example/1.ts\n`);
        },
    },
    {
        name: 'XMLTV: <rating><value> repeated inside one programme (RATING_VALUE_REGEX)',
        run: () => {
            parseXmltv(
                xmltvProgramme(`<title>T</title>${'<rating><value>a</value>'.repeat(3000)}`),
            );
        },
    },
    {
        name: 'XMLTV: <!DOCTYPE openers without a closer',
        run: () => {
            parseXmltv(`${'<!DOCTYPE a ['.repeat(50_000)}${xmltvProgramme('<title>T</title>')}`);
        },
    },
    {
        name: 'XMLTV: &lt; run decoded into a tag-strip input (sanitizeText)',
        run: () => {
            parseXmltv(xmltvProgramme(`<title>T</title><desc>${'&lt;'.repeat(120_000)}</desc>`));
        },
    },
    {
        name: 'XMLTV: unterminated <programme> openers (PROGRAMME_REGEX)',
        run: () => {
            parseXmltv(`<tv>${'<programme a="b">'.repeat(25_000)}</tv>`);
        },
    },
    {
        name: 'XMLTV: unterminated <channel> openers (CHANNEL_REGEX)',
        run: () => {
            parseXmltv(`<tv>${'<channel id="a">'.repeat(25_000)}</tv>`);
        },
    },
    {
        name: 'XMLTV: one programme attribute value of 160k word characters',
        run: () => {
            parseXmltv(xmltvProgramme('<title>T</title>', `${'a'.repeat(160_000)} channel="c1"`));
        },
    },
    {
        name: 'auto-processor: channel name with a long whitespace run (backup markers)',
        run: () => {
            processChannels([channel(`Chan${' '.repeat(40_000)}x`, `Grp${' '.repeat(40_000)}x`)]);
        },
    },
    {
        name: 'auto-processor: extractBaseName / hasFeedMarker / normalizeGroupTitle on whitespace runs',
        run: () => {
            const hostile = `Chan${' '.repeat(40_000)}x`;
            extractBaseName(hostile);
            hasFeedMarker(hostile);
            normalizeGroupTitle(hostile);
        },
    },
];

describe('Live TV parsers stay linear on hostile input', () => {
    it.each(ADVERSARIAL)('$name', ({ run }) => {
        expect(elapsed(run)).toBeLessThan(BUDGET_MS);
    });
});

describe('M3U parser caps', () => {
    it('skips an over-long EXTINF line with an error instead of scanning it', () => {
        const result = parseM3u(
            `#EXTM3U\n#EXTINF:-1 tvg-id="a",${'n'.repeat(40_000)}\nhttp://provider.example/1.ts\n#EXTINF:-1 tvg-id="b",Ok\nhttp://provider.example/2.ts\n`,
        );
        expect(result.channels.map((c) => c.name)).toEqual(['Ok']);
        expect(result.errors.some((e) => /too long/i.test(e.reason))).toBe(true);
        expect(result.errors.every((e) => e.content.length <= 300)).toBe(true);
    });

    it('truncates a channel display name', () => {
        const result = parseM3u(`#EXTINF:-1,${'n'.repeat(1000)}\nhttp://provider.example/1.ts\n`);
        expect(result.channels[0].name.length).toBeLessThanOrEqual(256);
    });

    it('stops at the channel cap', () => {
        const entry = '#EXTINF:-1,C\nhttp://provider.example/1.ts\n';
        const result = parseM3u(entry.repeat(1001), { maxChannels: 1000 });
        expect(result.channels.length).toBe(1000);
        expect(result.errors.some((e) => /channel limit/i.test(e.reason))).toBe(true);
    });

    it('keeps a long #EXTM3U header and a long real entry line (Xtream m3u_plus)', () => {
        const header = `#EXTM3U url-tvg="${'http://epg.example/guide.xml,'.repeat(600)}"`;
        const logo = `http://img.example/${'p'.repeat(15_000)}.png`;
        const result = parseM3u(
            `${header}\n#EXTINF:-1 tvg-id="a.de" tvg-logo="${logo}" group-title="G",Name\nhttp://provider.example/1.ts\n`,
        );
        expect(header.length).toBeGreaterThan(16 * 1024);
        expect(result.warnings.some((w) => w.field === 'header')).toBe(false);
        expect(result.channels).toHaveLength(1);
        expect(result.channels[0].logoUrl).toBe(logo);
    });

    it('strips control characters from attribute values', () => {
        const result = parseM3u(
            '#EXTINF:-1 tvg-id="a\u0000b" group-title="g\u0001",Name\nhttp://provider.example/1.ts\n',
        );
        expect(result.channels[0].tvgId).toBe('ab');
        expect(result.channels[0].groupTitle).toBe('g');
    });

    it('still parses attributes with commas and extras from a normal line', () => {
        const result = parseM3u(
            '#EXTINF:-1 tvg-id="x.de" tvg-name="X" tvg-logo="http://l/x.png" group-title="Sports, Premium" tvg-chno="7",Channel X\nhttp://provider.example/1.ts\n',
        );
        expect(result.channels[0]).toMatchObject({
            tvgId: 'x.de',
            tvgName: 'X',
            logoUrl: 'http://l/x.png',
            groupTitle: 'Sports, Premium',
            name: 'Channel X',
            countryCode: 'de',
            extras: { 'tvg-chno': '7' },
        });
    });
});

describe('XMLTV parser behaviour is kept for legitimate input', () => {
    it('extracts rating, genres and description', () => {
        const result = parseXmltv(
            xmltvProgramme(
                '<title>Show</title><desc>Line one &amp; two</desc><category>Drama</category><category>News</category><rating><value>FSK 12</value></rating>',
            ),
        );
        expect(result.programs).toHaveLength(1);
        expect(result.programs[0]).toMatchObject({
            title: 'Show',
            description: 'Line one & two',
            genres: ['Drama', 'News'],
            officialRating: 'FSK 12',
        });
    });

    it('finds a later <value> when an earlier one is malformed', () => {
        const result = parseXmltv(
            xmltvProgramme(
                '<title>S</title><rating><value><b>x</b></value><value>PG</value></rating>',
            ),
        );
        expect(result.programs[0].officialRating).toBe('PG');
    });

    it('still removes an inline DTD with entity declarations', () => {
        const result = parseXmltv(
            `<!DOCTYPE tv [ <!ENTITY a "b"> ]>${xmltvProgramme('<title>Show</title>')}`,
        );
        expect(result.programs).toHaveLength(1);
        expect(result.programs[0].title).toBe('Show');
    });

    it('strips tags decoded from entities and keeps surrounding text', () => {
        const result = parseXmltv(xmltvProgramme('<title>A &lt;b&gt;bold&lt;/b&gt; show</title>'));
        expect(result.programs[0].title).toBe('A bold show');
    });

    it('skips a programme whose body is far larger than any real entry', () => {
        const result = parseXmltv(
            `${xmltvProgramme(`<title>Big</title><desc>${'x'.repeat(200_000)}</desc>`)}`,
        );
        expect(result.programs).toHaveLength(0);
        expect(result.skipped).toBe(1);
    });

    it('strips control characters from genres, rating, icon and ids', () => {
        const result = parseXmltv(
            '<tv><channel id="c\u00001"><display-name>One</display-name><icon src="http://i/\u00001.png"/></channel>' +
                '<programme start="20260309051500 +0100" stop="20260309054500 +0100" channel="c\u00001"><title>T</title><category>a&#0;b</category><rating><value>R&#0;</value></rating></programme></tv>',
        );
        expect(result.channels[0].id).toBe('c1');
        expect(result.channels[0].iconUrl).toBe('http://i/1.png');
        expect(result.programs[0].genres).toEqual(['ab']);
        expect(result.programs[0].officialRating).toBe('R');
    });
});

describe('fetch ceiling', () => {
    // The ceiling counts DECODED bytes: a 500 KiB gzip body inflates to it.
    it('is far below the 500 MiB that fit a gzip bomb into the heap', () => {
        expect(DEFAULT_MAX_SOURCE_BYTES).toBeLessThanOrEqual(128 * 1024 * 1024);
        expect(M3U_MAX_FETCH_BYTES).toBeLessThanOrEqual(256 * 1024 * 1024);
    });

    it('does not let XMLTV through the fetch that the parser would reject', () => {
        expect(XMLTV_MAX_FETCH_BYTES).toBe(MAX_INPUT_SIZE);
    });
});

describe('HDHomeRun lineup -> synthetic M3U', () => {
    const device = { friendlyName: 'Living Room', modelNumber: 'X', tunerCount: 2 };

    it('cannot be made to carry extra entries through CR/LF in a field', () => {
        const m3u = lineupToM3u(
            [
                {
                    guideNumber: '1\n#EXTINF:-1 tvg-id="evil",Injected\nhttp://127.0.0.1:6379/',
                    guideName: 'Name\r\n#EXTINF:-1,Injected2\r\nhttp://127.0.0.1:6380/',
                    url: 'http://192.168.1.5:5004/auto/v1\nhttp://169.254.169.254/',
                    hd: true,
                    drm: false,
                } as never,
            ],
            device as never,
        );
        expect(m3u.split(/\r\n|\r|\n/).filter((l) => l.startsWith('#EXTINF'))).toHaveLength(1);
        const parsed = parseM3u(m3u);
        expect(parsed.channels).toHaveLength(1);
        expect(new URL(parsed.channels[0].streamUrl).hostname).toBe('192.168.1.5');
    });

    it('keeps a normal lineup intact', () => {
        const m3u = lineupToM3u(
            [
                {
                    guideNumber: '5.1',
                    guideName: 'Quad "Five"',
                    url: 'http://192.168.1.5:5004/auto/v5.1',
                    hd: true,
                    drm: false,
                } as never,
            ],
            device as never,
        );
        const parsed = parseM3u(m3u);
        expect(parsed.channels).toHaveLength(1);
        expect(parsed.channels[0]).toMatchObject({
            tvgId: '5.1',
            name: 'Quad Five',
            streamUrl: 'http://192.168.1.5:5004/auto/v5.1',
            groupTitle: 'Living Room',
        });
    });
});
