// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseM3u } from './m3u-parser.js';

const FIXTURES_DIR = path.resolve('src/lib/server/__tests__/fixtures/livetv');

function loadFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('M3U Parser', () => {
    // ── Task 4.2: Happy path with sample.m3u ─────────────────────────

    describe('happy path (sample.m3u)', () => {
        const result = parseM3u(loadFixture('sample.m3u'));

        it('parses all 14 channels', () => {
            expect(result.imported).toBe(14);
            expect(result.channels).toHaveLength(14);
        });

        it('has no errors', () => {
            expect(result.errors).toHaveLength(0);
        });

        it('extracts attributes correctly for first channel', () => {
            const ch = result.channels[0];
            expect(ch.tvgId).toBe('Nordwelle.de');
            expect(ch.tvgName).toBe('Nordwelle FHD');
            expect(ch.logoUrl).toBe('http://logos.example/nordwellehd.png');
            expect(ch.groupTitle).toBe('FreeTV / HD+');
            expect(ch.name).toBe('Nordwelle FHD');
            expect(ch.streamUrl).toBe('http://provider.example/live/user/pass/501.ts');
        });

        it('extracts display name from after last comma', () => {
            // Channel with unicode in name
            const threeSat = result.channels.find((c) => c.name === '3kult HD ¹');
            expect(threeSat).toBeDefined();
            expect(threeSat!.tvgName).toBe('3kult HD ¹');
        });

        it('preserves unicode names exactly', () => {
            const names = result.channels.map((c) => c.name);
            expect(names).toContain('3kult HD ¹');
            expect(names).toContain('3kult HD ²');
        });

        it('preserves asterisk markers in names', () => {
            const names = result.channels.map((c) => c.name);
            expect(names).toContain('Pinotopia HD *');
            expect(names).toContain('HLV 1 HD *');
        });

        it('preserves slashes in group-title', () => {
            const groups = [...new Set(result.channels.map((c) => c.groupTitle))];
            expect(groups).toContain('FreeTV / HD+');
            expect(groups).toContain('AT / CH *');
        });

        it('captures extra attributes in extras', () => {
            // Standard fixture uses only known attrs, so extras should be empty
            expect(result.channels[0].extras).toEqual({});
        });

        it('generates duplicate tvg-id warnings', () => {
            // Nordwelle.de, 3kult.de, Pinotopia.de appear twice each
            const dupWarnings = result.warnings.filter(
                (w) => w.field === 'tvg-id' && w.message.includes('Duplicate'),
            );
            // One summary line, counting every repeated channel
            expect(dupWarnings).toHaveLength(1);
            expect(
                Number(/(\d+) channels/.exec(dupWarnings[0].message)?.[1]),
            ).toBeGreaterThanOrEqual(3);
        });
    });

    // ── Task 4.3: Error handling with malformed.m3u ──────────────────

    describe('error handling (malformed.m3u)', () => {
        const result = parseM3u(loadFixture('malformed.m3u'));

        it('does NOT throw', () => {
            expect(result).toBeDefined();
        });

        it('collects errors with line number, content, and reason', () => {
            expect(result.errors.length).toBeGreaterThan(0);
            for (const err of result.errors) {
                expect(err).toHaveProperty('line');
                expect(err).toHaveProperty('content');
                expect(err).toHaveProperty('reason');
                expect(typeof err.line).toBe('number');
            }
        });

        it('parses exactly 10 valid channels from the malformed file', () => {
            // Nordwelle, MTK, Double Entry 2, Valid After Gap, No TVG-ID,
            // No Logo, No Group, After Unknown Tag, 3kult HD ¹, Orb Cinema *
            expect(result.imported).toBe(10);
            expect(result.channels).toHaveLength(10);
        });

        it('skips exactly 5 errored entries', () => {
            // KWF (blank before URL), malformed line, empty-name, Double Entry 1, Missing URL Channel
            expect(result.skipped).toBe(5);
            expect(result.errors).toHaveLength(5);
        });

        it('imported + skipped accounts for all EXTINF lines', () => {
            expect(result.imported + result.skipped).toBe(15);
        });

        it('warns about missing #EXTM3U header', () => {
            const headerWarning = result.warnings.find((w) => w.field === 'header');
            expect(headerWarning).toBeDefined();
        });

        it('handles KWF with blank line before URL (URL lost)', () => {
            // KWF FHD has a blank line between EXTINF and URL, then MTK follows
            // The blank line is skipped, then MTK EXTINF replaces KWF EXTINF
            // KWF should be in errors (missing URL) or skipped
            const kwfError = result.errors.find((e) => e.content.includes('KWF'));
            expect(kwfError).toBeDefined();
        });

        it('handles consecutive EXTINF lines (first overwritten)', () => {
            // "Double Entry 1" EXTINF is followed by "Double Entry 2" EXTINF
            // Double Entry 1 should be in errors
            const doubleError = result.errors.find((e) => e.content.includes('Double Entry 1'));
            expect(doubleError).toBeDefined();
        });

        it('handles EXTINF at EOF with no URL', () => {
            // The last EXTINF line in malformed.m3u has no following URL
            // Wait - looking at the fixture, the last line has a URL after it
            // Actually re-reading: line 15 is "Missing URL Channel" EXTINF,
            // then line 16 is another EXTINF "Valid After Gap"
            // So "Missing URL Channel" should be an error
            const noUrlError = result.errors.find((e) => e.content.includes('Missing URL Channel'));
            expect(noUrlError).toBeDefined();
        });
    });

    // ── Task 4.4: Edge cases ─────────────────────────────────────────

    describe('edge cases', () => {
        it('empty string input → empty result', () => {
            const result = parseM3u('');
            expect(result.imported).toBe(0);
            expect(result.skipped).toBe(0);
            expect(result.channels).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
            expect(result.warnings).toHaveLength(0);
        });

        it('only #EXTM3U header → empty result', () => {
            const result = parseM3u('#EXTM3U\n');
            expect(result.imported).toBe(0);
            expect(result.channels).toHaveLength(0);
            expect(result.errors).toHaveLength(0);
        });

        it('Windows \\r\\n line endings → parsed correctly', () => {
            const content =
                '#EXTM3U\r\n#EXTINF:-1 tvg-id="Test.de" tvg-name="Test" tvg-logo="http://example.com/logo.png" group-title="Group",Test Channel\r\nhttp://stream.example/test.ts\r\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('Test Channel');
        });

        it('UTF-8 BOM → stripped, parsed correctly', () => {
            const bom = '\uFEFF';
            const content = `${bom}#EXTM3U\n#EXTINF:-1 tvg-id="BOM.de" tvg-name="BOM Test" tvg-logo="http://example.com/bom.png" group-title="Test",BOM Channel\nhttp://stream.example/bom.ts\n`;
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('BOM Channel');
        });

        it('missing #EXTM3U header → warning generated but parsing continues', () => {
            const content =
                '#EXTINF:-1 tvg-id="No.de" tvg-name="No Header" tvg-logo="http://example.com/nh.png" group-title="Test",No Header Channel\nhttp://stream.example/nh.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            const headerWarning = result.warnings.find((w) => w.field === 'header');
            expect(headerWarning).toBeDefined();
        });

        it('#EXT-X-SESSION-DATA and other #EXT-X-* tags → skipped gracefully', () => {
            const content =
                '#EXTM3U\n#EXT-X-SESSION-DATA:DATA-ID="com.xui.1_5_13"\n#EXT-X-VERSION:3\n#EXTINF:-1 tvg-id="After.de" tvg-name="After Tag" tvg-logo="http://example.com/at.png" group-title="Test",After Tag\nhttp://stream.example/at.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.errors).toHaveLength(0);
        });

        it('attributes in non-standard order → all extracted', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 group-title="Reversed" tvg-logo="http://example.com/r.png" tvg-name="Reversed" tvg-id="Rev.de",Reversed Channel\nhttp://stream.example/rev.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].tvgId).toBe('Rev.de');
            expect(result.channels[0].groupTitle).toBe('Reversed');
            expect(result.channels[0].tvgName).toBe('Reversed');
            expect(result.channels[0].logoUrl).toBe('http://example.com/r.png');
        });

        it('blank lines between EXTINF and URL → URL still matched', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="Gap.de" tvg-name="Gap" tvg-logo="http://example.com/g.png" group-title="Test",Gap Channel\n\nhttp://stream.example/gap.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('Gap Channel');
            expect(result.errors).toHaveLength(0);
        });

        it('comments between EXTINF and URL → skipped, URL still matched', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="Com.de" tvg-name="Comment" tvg-logo="http://example.com/c.png" group-title="Test",Comment Channel\n#EXTVLCOPT:some-option\nhttp://stream.example/com.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('Comment Channel');
        });

        it('#KODIPROP between EXTINF and URL → skipped, URL still matched', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="Kodi.de" tvg-name="Kodi" tvg-logo="http://example.com/k.png" group-title="Test",Kodi Channel\n#KODIPROP:inputstreamaddon=inputstream.adaptive\nhttp://stream.example/kodi.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('Kodi Channel');
        });

        it('duplicate tvg-id values → both imported with warning', () => {
            const content = [
                '#EXTM3U',
                '#EXTINF:-1 tvg-id="Same.de" tvg-name="First" tvg-logo="http://example.com/1.png" group-title="Test",First Channel',
                'http://stream.example/1.ts',
                '#EXTINF:-1 tvg-id="Same.de" tvg-name="Second" tvg-logo="http://example.com/2.png" group-title="Test",Second Channel',
                'http://stream.example/2.ts',
            ].join('\n');
            const result = parseM3u(content);
            expect(result.imported).toBe(2);
            const dupWarning = result.warnings.find(
                (w) => w.field === 'tvg-id' && w.message.includes('Duplicate'),
            );
            expect(dupWarning).toBeDefined();
        });

        it('thousands of repeated tvg-ids give one summary warning, first in the list', () => {
            const lines = ['#EXTM3U'];
            for (let i = 0; i < 3000; i++) {
                lines.push(
                    `#EXTINF:-1 tvg-id="id${i % 10}.de" tvg-logo="http://example.com/l.png" group-title="Test",Channel ${i}`,
                    `http://stream.example/${i}.ts`,
                );
            }
            const result = parseM3u(lines.join('\n'));
            expect(result.imported).toBe(3000);
            const dup = result.warnings.filter((w) => w.field === 'tvg-id');
            expect(dup).toHaveLength(1);
            expect(result.warnings[0]).toBe(dup[0]);
            expect(dup[0].message).toBe(
                'Duplicate tvg-id: 2990 channels repeat 10 tvg-ids of an earlier channel, all imported ' +
                    '(e.g. "id0.de", "id1.de", "id2.de", "id3.de", "id4.de", …)',
            );
            expect(dup[0].line).toBe(22);
        });

        it('extra/unknown attributes captured in extras', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="Extra.de" tvg-name="Extra" tvg-logo="http://example.com/e.png" group-title="Test" tvg-shift="1" custom-attr="hello",Extra Channel\nhttp://stream.example/extra.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].extras).toEqual({
                'tvg-shift': '1',
                'custom-attr': 'hello',
            });
        });

        it('commas inside quoted attribute values do not corrupt name extraction', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="Test.de" tvg-name="Test" tvg-logo="http://example.com/t.png" group-title="Sports, Premium",Correct Name\nhttp://stream.example/t.ts\n';
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('Correct Name');
            expect(result.channels[0].groupTitle).toBe('Sports, Premium');
        });

        it('orphan URL without preceding EXTINF is silently skipped', () => {
            const content = [
                '#EXTM3U',
                'http://stream.example/orphan.ts',
                '#EXTINF:-1 tvg-id="After.de" tvg-name="After" tvg-logo="http://example.com/a.png" group-title="Test",After Orphan',
                'http://stream.example/after.ts',
            ].join('\n');
            const result = parseM3u(content);
            expect(result.imported).toBe(1);
            expect(result.channels[0].name).toBe('After Orphan');
            expect(result.errors).toHaveLength(0);
        });
    });

    // ── Task 4.5: countryCode extraction ─────────────────────────────

    describe('countryCode extraction', () => {
        function parseWithTvgId(tvgId: string): string | undefined {
            const content = `#EXTM3U\n#EXTINF:-1 tvg-id="${tvgId}" tvg-name="Test" tvg-logo="http://example.com/t.png" group-title="Test",Test\nhttp://stream.example/t.ts\n`;
            const result = parseM3u(content);
            return result.channels[0]?.countryCode;
        }

        it('"Nordwelle.de" → "de"', () => {
            expect(parseWithTvgId('Nordwelle.de')).toBe('de');
        });

        it('"OSK1.at" → "at"', () => {
            expect(parseWithTvgId('OSK1.at')).toBe('at');
        });

        it('"HLV 1.ch" → "ch"', () => {
            expect(parseWithTvgId('HLV 1.ch')).toBe('ch');
        });

        it('"VELO.us" → "us"', () => {
            expect(parseWithTvgId('VELO.us')).toBe('us');
        });

        it('"Stern7Sat.4 UHD" → undefined (no TLD suffix)', () => {
            expect(parseWithTvgId('Stern7Sat.4 UHD')).toBeUndefined();
        });

        it('hash tvg-id → undefined', () => {
            expect(parseWithTvgId('ebfb5bdb78f54b09d4b3183f7ae6e00c')).toBeUndefined();
        });

        it('empty tvg-id → undefined', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="" tvg-name="Test" tvg-logo="http://example.com/t.png" group-title="Test",Test\nhttp://stream.example/t.ts\n';
            const result = parseM3u(content);
            expect(result.channels[0].countryCode).toBeUndefined();
        });

        it('missing tvg-id → undefined', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-name="Test" tvg-logo="http://example.com/t.png" group-title="Test",Test\nhttp://stream.example/t.ts\n';
            const result = parseM3u(content);
            expect(result.channels[0].countryCode).toBeUndefined();
        });

        it('verifies country codes from sample.m3u fixture', () => {
            const result = parseM3u(loadFixture('sample.m3u'));
            const velo = result.channels.find((c) => c.name === 'VELO FHD');
            expect(velo?.countryCode).toBe('us');
            const hlv = result.channels.find((c) => c.name === 'HLV 1 HD *');
            expect(hlv?.countryCode).toBe('ch');
            const nordwelle = result.channels.find((c) => c.name === 'Nordwelle FHD');
            expect(nordwelle?.countryCode).toBe('de');
        });
    });

    // ── Task 4.6: Warning generation ─────────────────────────────────

    describe('warning generation', () => {
        it('warns for missing tvg-id', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-name="No ID" tvg-logo="http://example.com/n.png" group-title="Test",No ID Channel\nhttp://stream.example/noid.ts\n';
            const result = parseM3u(content);
            const w = result.warnings.find(
                (w) => w.field === 'tvg-id' && !w.message.includes('Duplicate'),
            );
            expect(w).toBeDefined();
            expect(w!.message).toContain('missing tvg-id');
        });

        it('warns for missing tvg-logo', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="NL.de" tvg-name="No Logo" group-title="Test",No Logo Channel\nhttp://stream.example/nologo.ts\n';
            const result = parseM3u(content);
            const w = result.warnings.find((w) => w.field === 'tvg-logo');
            expect(w).toBeDefined();
            expect(w!.message).toContain('missing tvg-logo');
        });

        it('warns for missing group-title', () => {
            const content =
                '#EXTM3U\n#EXTINF:-1 tvg-id="NG.de" tvg-name="No Group" tvg-logo="http://example.com/ng.png",No Group Channel\nhttp://stream.example/nogroup.ts\n';
            const result = parseM3u(content);
            const w = result.warnings.find((w) => w.field === 'group-title');
            expect(w).toBeDefined();
            expect(w!.message).toContain('missing group-title');
        });
    });

    // ── Task 4.7: Large fixture (1,308 channels) ────────────────────

    describe('large fixture (large.m3u)', () => {
        const content = loadFixture('large.m3u');

        it('parses 1,308 channels', () => {
            const result = parseM3u(content);
            expect(result.imported).toBe(1308);
            expect(result.channels).toHaveLength(1308);
        });

        it('extracts 27 unique group-titles', () => {
            const result = parseM3u(content);
            const groups = new Set(result.channels.map((c) => c.groupTitle).filter(Boolean));
            expect(groups.size).toBe(27);
        });

        it('skips #EXT-X-SESSION-DATA line (not in errors, not a channel)', () => {
            const result = parseM3u(content);
            const sessionDataError = result.errors.find((e) =>
                e.content.includes('EXT-X-SESSION-DATA'),
            );
            expect(sessionDataError).toBeUndefined();
            const sessionDataChannel = result.channels.find((c) => c.name.includes('SESSION-DATA'));
            expect(sessionDataChannel).toBeUndefined();
        });

        it('completes in < 30 seconds', () => {
            const start = performance.now();
            parseM3u(content);
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(30_000);
        });

        it('spot-checks first channel: "Nordwelle FHD"', () => {
            const result = parseM3u(content);
            const first = result.channels[0];
            expect(first.name).toBe('Nordwelle FHD');
            expect(first.tvgId).toBe('Nordwelle.de');
            expect(first.countryCode).toBe('de');
        });

        it('spot-checks last channel: "Korira HD *"', () => {
            const result = parseM3u(content);
            const last = result.channels[result.channels.length - 1];
            expect(last.name).toBe('Korira HD *');
        });
    });
});

describe('tvg-logo values that are no web address', () => {
    it('drops a serialised or relative value, keeps an http(s) URL', () => {
        const result = parseM3u(
            '#EXTM3U\n' +
                '#EXTINF:-1 tvg-id="a.de" tvg-logo="s:1:/images/abc.png",A\nhttp://provider.example/1.ts\n' +
                '#EXTINF:-1 tvg-id="b.de" tvg-logo="/images/b.png",B\nhttp://provider.example/2.ts\n' +
                '#EXTINF:-1 tvg-id="c.de" tvg-logo="https://img.example/c.png",C\nhttp://provider.example/3.ts\n',
        );
        expect(result.channels.map((c) => c.logoUrl)).toEqual([
            undefined,
            undefined,
            'https://img.example/c.png',
        ]);
    });
});
