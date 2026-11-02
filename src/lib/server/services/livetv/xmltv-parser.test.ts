// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeXmlEntities, parseXmltv, parseXmltvTime } from './xmltv-parser.js';

const FIXTURES_DIR = path.resolve('src/lib/server/__tests__/fixtures/livetv');

function loadFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

// ── parseXmltvTime ─────────────────────────────────────────────────────

describe('parseXmltvTime', () => {
    it('should parse standard XMLTV time with positive timezone', () => {
        expect(parseXmltvTime('20260309051500 +0100')).toBe('2026-03-09T05:15:00+01:00');
    });

    it('should parse time with +0000 timezone', () => {
        expect(parseXmltvTime('20260309000000 +0000')).toBe('2026-03-09T00:00:00+00:00');
    });

    it('should parse time with negative timezone', () => {
        expect(parseXmltvTime('20260309235959 -0500')).toBe('2026-03-09T23:59:59-05:00');
    });

    it('should parse time without timezone as UTC', () => {
        expect(parseXmltvTime('20260309051500')).toBe('2026-03-09T05:15:00Z');
    });

    it('should return undefined for invalid format', () => {
        expect(parseXmltvTime('invalid_time')).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
        expect(parseXmltvTime('')).toBeUndefined();
    });

    it('should handle whitespace around time string', () => {
        expect(parseXmltvTime('  20260309032500 +0100  ')).toBe('2026-03-09T03:25:00+01:00');
    });

    it('should parse 12-digit time (no seconds)', () => {
        expect(parseXmltvTime('202603090515 +0100')).toBe('2026-03-09T05:15:00+01:00');
    });

    it('should parse 8-digit time (date only)', () => {
        expect(parseXmltvTime('20260309 +0100')).toBe('2026-03-09T00:00:00+01:00');
    });

    it('should parse 8-digit time without timezone', () => {
        expect(parseXmltvTime('20260309')).toBe('2026-03-09T00:00:00Z');
    });
});

// ── decodeXmlEntities ──────────────────────────────────────────────────

describe('decodeXmlEntities', () => {
    it('should decode &amp;', () => {
        expect(decodeXmlEntities('A &amp; B')).toBe('A & B');
    });

    it('should decode &quot;', () => {
        expect(decodeXmlEntities('the &quot;normal&quot; world')).toBe('the "normal" world');
    });

    it('should decode &lt; and &gt;', () => {
        expect(decodeXmlEntities('&lt;tag&gt;')).toBe('<tag>');
    });

    it('should decode &apos;', () => {
        expect(decodeXmlEntities('it&apos;s')).toBe("it's");
    });

    it('should decode numeric entities', () => {
        expect(decodeXmlEntities('&#65;&#66;')).toBe('AB');
    });

    it('should decode hex entities', () => {
        expect(decodeXmlEntities('&#x41;&#x42;')).toBe('AB');
    });
});

// ── parseXmltv: happy path ─────────────────────────────────────────────

describe('parseXmltv', () => {
    describe('happy path with sample.xmltv', () => {
        const content = loadFixture('sample.xmltv');
        const result = parseXmltv(content);

        it('should parse all channels', () => {
            expect(result.channelCount).toBe(12);
            expect(result.channels).toHaveLength(12);
        });

        it('should parse channels with TLD-suffix IDs', () => {
            const nordwelle = result.channels.find((c) => c.id === 'Nordwelle.de');
            expect(nordwelle).toBeDefined();
            expect(nordwelle!.displayName).toBe('Nordwelle HD *');
            expect(nordwelle!.iconUrl).toBe('http://logos.example/nordwellehd.png');
        });

        it('should parse channels with .at and .ch suffix IDs', () => {
            expect(result.channels.find((c) => c.id === 'OTZ.at')).toBeDefined();
            expect(result.channels.find((c) => c.id === 'HLV1.ch')).toBeDefined();
        });

        it('should parse channels with empty ID', () => {
            const autoIdChannels = result.channels.filter((c) => c.id.startsWith('_auto:'));
            expect(autoIdChannels).toHaveLength(2);
        });

        it('should parse channels with spaces in ID', () => {
            expect(result.channels.find((c) => c.id === 'DE: Cyan Sport 18')).toBeDefined();
            expect(result.channels.find((c) => c.id === 'MTK+ LIVE 2')).toBeDefined();
        });

        it('should parse channels with numeric ID', () => {
            const pino = result.channels.find((c) => c.id === '4379');
            expect(pino).toBeDefined();
            expect(pino!.displayName).toBe('Pino Jr. FHD');
        });

        it('should parse channel without icon', () => {
            const noIcon = result.channels.find((c) => c.id === 'NoIcon.de');
            expect(noIcon).toBeDefined();
            expect(noIcon!.iconUrl).toBeUndefined();
        });

        it('should parse all programmes', () => {
            expect(result.programCount).toBe(17);
            expect(result.programs).toHaveLength(17);
        });

        it('should parse programme with correct fields', () => {
            const caren = result.programs.find((p) => p.title === 'Mara Fenwick');
            expect(caren).toBeDefined();
            expect(caren!.channelId).toBe('Nordwelle.de');
            expect(caren!.startTime).toBe('2026-03-09T03:25:00+01:00');
            expect(caren!.endTime).toBe('2026-03-09T04:25:00+01:00');
            expect(caren!.description).toContain('Gästen');
        });

        it('should decode HTML entities in descriptions', () => {
            const kulturfenster = result.programs.find((p) => p.title === 'Kulturfenster');
            expect(kulturfenster).toBeDefined();
            expect(kulturfenster!.description).toContain('"Kulturfenster"');
            expect(kulturfenster!.description).toContain('&');
            expect(kulturfenster!.description).not.toContain('&quot;');
            expect(kulturfenster!.description).not.toContain('&amp;');
        });

        it('should preserve unicode in titles and descriptions', () => {
            const tieraerzte = result.programs.find((p) => p.title.includes('Hafenärzte'));
            expect(tieraerzte).toBeDefined();

            const wienerPlaetze = result.programs.find((p) => p.title.includes('Hafenplätze'));
            expect(wienerPlaetze).toBeDefined();
        });

        it('should handle programme without description', () => {
            const mtkEvent = result.programs.find((p) => p.title === 'MTK+ Event Special');
            expect(mtkEvent).toBeDefined();
            expect(mtkEvent!.description).toBeUndefined();
        });

        it('should ignore non-standard start_timestamp/stop_timestamp attributes', () => {
            const fussball = result.programs.find((p) => p.title.includes('Kontinentalpokal'));
            expect(fussball).toBeDefined();
            expect(fussball!.startTime).toBe('2026-03-11T16:30:00+01:00');
            // Non-standard attributes should not cause errors
            expect(result.errors.filter((e) => e.reason.includes('timestamp'))).toHaveLength(0);
        });

        it('should have no errors for valid fixture', () => {
            expect(result.errors).toHaveLength(0);
        });

        it('should auto-generate IDs for empty channel IDs', () => {
            // Channels with empty IDs get _auto:<slug> IDs derived from display name
            const autoIdChannels = result.channels.filter((c) => c.id.startsWith('_auto:'));
            expect(autoIdChannels).toHaveLength(2);
            expect(autoIdChannels.every((c) => c.displayName.length > 0)).toBe(true);
        });
    });

    // ── Genres and officialRating ───────────────────────────────────

    describe('genres and officialRating extraction', () => {
        const content = loadFixture('sample.xmltv');
        const result = parseXmltv(content);

        it('should extract multiple genres from <category> elements', () => {
            const morgenmagazin = result.programs.find((p) => p.title === 'Hafen-Morgenmagazin');
            expect(morgenmagazin).toBeDefined();
            expect(morgenmagazin!.genres).toEqual(['News', 'Politics']);
        });

        it('should extract single genre', () => {
            const schweiz = result.programs.find((p) => p.title === 'Hafen aktuell');
            expect(schweiz).toBeDefined();
            expect(schweiz!.genres).toEqual(['News']);
        });

        it('should return empty genres array when no <category>', () => {
            const caren = result.programs.find((p) => p.title === 'Mara Fenwick');
            expect(caren).toBeDefined();
            expect(caren!.genres).toEqual([]);
        });

        it('should extract officialRating from <rating><value>', () => {
            const social = result.programs.find((p) => p.title === 'Harbor Neighbors (Wh.)');
            expect(social).toBeDefined();
            expect(social!.officialRating).toBe('FSK 12');
        });

        it('should extract FSK 0 rating', () => {
            const nano = result.programs.find((p) => p.title === 'Forschungsfenster');
            expect(nano).toBeDefined();
            expect(nano!.officialRating).toBe('FSK 0');
        });

        it('should return undefined officialRating when no <rating>', () => {
            const caren = result.programs.find((p) => p.title === 'Mara Fenwick');
            expect(caren).toBeDefined();
            expect(caren!.officialRating).toBeUndefined();
        });

        it('should extract Kids and Animation genres', () => {
            const blaze = result.programs.find((p) => p.title === 'Flare and the Harbor Machines');
            expect(blaze).toBeDefined();
            expect(blaze!.genres).toEqual(['Kids', 'Animation']);
        });
    });

    // ── Error handling with malformed.xmltv ─────────────────────────

    describe('error handling with malformed.xmltv', () => {
        const content = loadFixture('malformed.xmltv');
        const result = parseXmltv(content);

        it('should not throw on malformed input', () => {
            expect(() => parseXmltv(content)).not.toThrow();
        });

        it('should parse valid programmes despite errors', () => {
            const valid = result.programs.filter(
                (p) => p.title === 'Valid Programme' || p.title === 'Another Valid Programme',
            );
            expect(valid).toHaveLength(2);
        });

        it('should collect errors for missing title', () => {
            expect(result.errors.some((e) => e.reason.includes('<title>'))).toBe(true);
        });

        it('should collect error for empty title', () => {
            expect(
                result.errors.some(
                    (e) => e.reason.includes('<title>') || e.reason.includes('empty'),
                ),
            ).toBe(true);
        });

        it('should collect error for missing start attribute', () => {
            expect(result.errors.some((e) => e.reason.includes('start'))).toBe(true);
        });

        it('should collect error for missing stop attribute', () => {
            expect(result.errors.some((e) => e.reason.includes('stop'))).toBe(true);
        });

        it('should collect error for missing channel attribute', () => {
            expect(result.errors.some((e) => e.reason.includes('channel'))).toBe(true);
        });

        it('should collect error for invalid time format', () => {
            expect(result.errors.some((e) => e.reason.includes('invalid_time'))).toBe(true);
        });

        it('should collect error for channel missing display-name', () => {
            expect(
                result.errors.some(
                    (e) => e.element === 'channel' && e.reason.includes('display-name'),
                ),
            ).toBe(true);
        });

        it('should have skipped count matching errors', () => {
            expect(result.skipped).toBeGreaterThan(0);
            // skipped >= errors because temporal anomalies (inverted/zero-duration)
            // are warned and skipped but not counted as errors
            expect(result.skipped).toBeGreaterThanOrEqual(result.errors.length);
        });

        it('should treat empty <desc></desc> as undefined', () => {
            const emptyDesc = result.programs.find((p) => p.title === 'Empty Description');
            expect(emptyDesc).toBeDefined();
            expect(emptyDesc!.description).toBeUndefined();
        });

        it('should treat missing desc as undefined', () => {
            const noDesc = result.programs.find((p) => p.title === 'No Description At All');
            expect(noDesc).toBeDefined();
            expect(noDesc!.description).toBeUndefined();
        });
    });

    // ── Temporal edge cases ────────────────────────────────────────

    describe('temporal edge cases', () => {
        const content = loadFixture('malformed.xmltv');
        const result = parseXmltv(content);

        it('should warn on inverted times (start > stop)', () => {
            expect(
                result.warnings.some((w) => w.field === 'time' && w.message.includes('inverted')),
            ).toBe(true);
        });

        it('should warn on zero-duration programme', () => {
            expect(
                result.warnings.some(
                    (w) => w.field === 'time' && w.message.includes('zero-duration'),
                ),
            ).toBe(true);
        });

        it('should skip inverted/zero-duration programmes', () => {
            // Temporal anomalies are warned and skipped — not present in programs
            expect(result.programs.find((p) => p.title === 'Inverted Times')).toBeUndefined();
            expect(result.programs.find((p) => p.title === 'Zero Duration')).toBeUndefined();
        });
    });

    // ── Edge cases ─────────────────────────────────────────────────

    describe('edge cases', () => {
        it('should return empty result for empty string', () => {
            const result = parseXmltv('');
            expect(result.channelCount).toBe(0);
            expect(result.programCount).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should return empty result for whitespace-only input', () => {
            const result = parseXmltv('   \n\t  ');
            expect(result.channelCount).toBe(0);
            expect(result.programCount).toBe(0);
        });

        it('should return empty result for <tv> root only', () => {
            const result = parseXmltv('<?xml version="1.0"?><tv></tv>');
            expect(result.channelCount).toBe(0);
            expect(result.programCount).toBe(0);
            expect(result.errors).toHaveLength(0);
        });

        it('should warn when programme references unknown channel', () => {
            const content = loadFixture('malformed.xmltv');
            const result = parseXmltv(content);
            expect(
                result.warnings.some(
                    (w) => w.field === 'channel' && w.message.includes('NonExistent.de'),
                ),
            ).toBe(true);
        });

        it('should parse non-self-closing icon elements', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de">
    <display-name>Test</display-name>
    <icon src="http://example.com/logo.png"></icon>
  </channel>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.channels[0].iconUrl).toBe('http://example.com/logo.png');
        });

        it('should extract rating when <system> precedes <value>', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Rated Programme</title>
    <rating><system>MPAA</system><value>PG-13</value></rating>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programs[0].officialRating).toBe('PG-13');
        });

        it('should warn on duplicate channel IDs', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Dup.de"><display-name>Channel A</display-name></channel>
  <channel id="Dup.de"><display-name>Channel B</display-name></channel>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.channels).toHaveLength(2);
            expect(result.warnings.some((w) => w.message.includes('Duplicate'))).toBe(true);
        });

        it('should correctly detect zero-duration across timezone offsets', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0200" stop="20260309050000 +0100" channel="Test.de">
    <title>Same Instant</title>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            // Same instant in different TZ offsets — zero-duration, skipped
            expect(result.programCount).toBe(0);
            expect(
                result.warnings.some(
                    (w) => w.field === 'time' && w.message.includes('zero-duration'),
                ),
            ).toBe(true);
        });

        it('should handle unclosed programme tag gracefully', () => {
            const content = loadFixture('malformed.xmltv');
            const result = parseXmltv(content);
            expect(
                result.programs.find((p) => p.title === 'Unclosed Tag Programme'),
            ).toBeUndefined();
        });

        it('should preserve paragraph breaks in descriptions', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Multi Paragraph</title>
    <desc>First paragraph.

Second paragraph.</desc>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programs[0].description).toContain('\n\n');
            expect(result.programs[0].description).toContain('First paragraph.');
            expect(result.programs[0].description).toContain('Second paragraph.');
        });

        it('should handle time without timezone with warning', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000" stop="20260309070000" channel="Test.de">
    <title>No TZ Programme</title>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programCount).toBe(1);
            expect(result.programs[0].startTime).toBe('2026-03-09T06:00:00Z');
            expect(
                result.warnings.some((w) => w.field === 'start' && w.message.includes('timezone')),
            ).toBe(true);
        });
    });

    // ── Security ───────────────────────────────────────────────────

    describe('security', () => {
        it('should strip HTML tags from titles', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Hello &lt;script&gt;alert(1)&lt;/script&gt; World</title>
    <desc>Description with &lt;b&gt;bold&lt;/b&gt; and &lt;img src=x onerror=alert(1)&gt;</desc>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programCount).toBe(1);
            expect(result.programs[0].title).toBe('Hello alert(1) World');
            expect(result.programs[0].description).toBe('Description with bold and');
            expect(result.programs[0].description).not.toContain('<');
        });

        it('should strip HTML tags from channel display names', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Evil.de"><display-name>&lt;script&gt;alert(1)&lt;/script&gt;Evil Channel</display-name></channel>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.channelCount).toBe(1);
            expect(result.channels[0].displayName).toBe('alert(1)Evil Channel');
        });

        it('should strip control characters', () => {
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Title with\x00null\x07bell</title>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programs[0].title).not.toContain('\x00');
            expect(result.programs[0].title).not.toContain('\x07');
        });

        it('should strip XML entity declarations (billion laughs prevention)', () => {
            const xml = `<?xml version="1.0"?>
<!DOCTYPE tv [
  <!ENTITY lol "lol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
]>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Safe Programme</title>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programCount).toBe(1);
            expect(result.programs[0].title).toBe('Safe Programme');
        });

        it('should reject oversized input', () => {
            // Create a string just over 100MB
            const huge = 'x'.repeat(100 * 1024 * 1024 + 1);
            const result = parseXmltv(huge);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].reason).toContain('too large');
            expect(result.channelCount).toBe(0);
            expect(result.programCount).toBe(0);
        });

        it('should truncate very long descriptions', () => {
            const longDesc = 'A'.repeat(6000);
            const xml = `<?xml version="1.0"?>
<tv>
  <channel id="Test.de"><display-name>Test</display-name></channel>
  <programme start="20260309060000 +0100" stop="20260309070000 +0100" channel="Test.de">
    <title>Long Desc Programme</title>
    <desc>${longDesc}</desc>
  </programme>
</tv>`;
            const result = parseXmltv(xml);
            expect(result.programCount).toBe(1);
            expect(result.programs[0].description!.length).toBeLessThanOrEqual(5000);
            expect(result.warnings.some((w) => w.message.includes('truncated'))).toBe(true);
        });
    });

    // ── Performance ────────────────────────────────────────────────

    describe('performance', () => {
        it('should parse sample.xmltv in under 1 second', () => {
            const content = loadFixture('sample.xmltv');
            const start = performance.now();
            parseXmltv(content);
            const elapsed = performance.now() - start;
            expect(elapsed).toBeLessThan(1000);
        });
    });
});

describe('parseXmltv duplicate channel ids', () => {
    it('warns with the message the import folds into one summary line', () => {
        // livetv-import.service.ts counts warnings starting with this text
        // instead of listing thousands of them; keep the two in step.
        const result = parseXmltv(
            '<?xml version="1.0"?><tv>' +
                '<channel id="dup.de"><display-name>One</display-name></channel>' +
                '<channel id="dup.de"><display-name>One HD</display-name></channel>' +
                '</tv>',
        );
        expect(result.warnings.map((w) => w.message)).toEqual([
            expect.stringMatching(/^Duplicate channel ID/),
        ]);
    });

    it('tags routine guide noise with a kind so the importer can route it to notes', () => {
        const longDesc = 'Lorem ipsum dolor sit amet. '.repeat(250);
        const result = parseXmltv(
            '<?xml version="1.0"?><tv>' +
                '<channel id="dup.de"><display-name>One</display-name></channel>' +
                '<channel id="dup.de"><display-name>One HD</display-name></channel>' +
                '<programme start="20260728120000 +0000" stop="20260728130000 +0000" channel="dup.de">' +
                `<title>Long</title><desc>${longDesc}</desc></programme>` +
                '<programme start="20260728130000 +0000" stop="20260728130000 +0000" channel="dup.de">' +
                '<title>Zero</title></programme>' +
                '<programme start="20260728150000 +0000" stop="20260728140000 +0000" channel="dup.de">' +
                '<title>Inverted</title></programme>' +
                '</tv>',
        );
        expect(result.warnings.map((w) => w.kind)).toEqual([
            'duplicate-channel-id',
            'description-truncated',
            'zero-duration',
            'inverted-range',
        ]);
    });
});
