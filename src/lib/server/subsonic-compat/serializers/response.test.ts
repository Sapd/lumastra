// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Tests for the OpenSubsonic response envelope, focused on XML correctness.
//
// The XML here is built by hand, so nothing escapes for us. Two classes of
// input reach it untrusted: media metadata (ID3 tags and NFO files carry
// whatever the file says) and request parameters echoed back into error
// messages. Both must come out as well-formed XML.

import { describe, it, expect } from 'vitest';
import { subsonicOk, subsonicError } from './response.js';

async function xmlOf(res: Response): Promise<string> {
    return await res.text();
}

describe('Subsonic XML envelope escaping', () => {
    it('escapes the XML syntax characters in attribute values', async () => {
        const xml = await xmlOf(subsonicOk({ song: { title: `a&b<c>d"e'f` } }, 'xml'));

        expect(xml).toContain('&amp;');
        expect(xml).toContain('&lt;');
        expect(xml).toContain('&gt;');
        expect(xml).toContain('&quot;');
        // The raw characters must not survive inside the attribute.
        expect(xml).not.toMatch(/title="[^"]*[<>]/);
    });

    it('cannot be broken out of an attribute by a quote in a track title', async () => {
        // The injection attempt: close the attribute and inject an element.
        const hostile = '" onload="x"><injected/><song title="';
        const xml = await xmlOf(subsonicOk({ song: { title: hostile } }, 'xml'));

        expect(xml).not.toContain('<injected/>');
        expect(xml).toContain('&quot;');
    });

    it('strips XML-1.0-illegal control characters from metadata', async () => {
        // A real case: scanners and ID3 tags carry \x0B / \x1F in titles. These
        // are illegal in XML 1.0 as CHARACTERS — entity-escaping cannot rescue
        // them, so the only correct handling is removal.
        const xml = await xmlOf(
            subsonicOk({ song: { title: 'Track\x0BName\x1FHere\x00' } }, 'xml'),
        );

        expect(xml).toContain('TrackNameHere');
        // eslint-disable-next-line no-control-regex -- asserting the chars are gone
        expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
    });

    it('keeps tab/newline/carriage return, which XML 1.0 permits', async () => {
        const xml = await xmlOf(subsonicOk({ song: { title: 'a\tb' } }, 'xml'));
        expect(xml).toContain('\t');
    });

    it('sanitises error messages built from request parameters', async () => {
        // `subsonicError` is reached with raw request input — e.g. the unknown
        // `method` path segment and an unsupported `mediaType` param — so it
        // gets the same treatment as metadata.
        const xml = await xmlOf(subsonicError(70, 'Unknown method: \x0Bfoo<bar>&baz"', 'xml'));

        // eslint-disable-next-line no-control-regex -- asserting the chars are gone
        expect(xml).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F]/);
        expect(xml).not.toMatch(/message="[^"]*[<>]/);
        expect(xml).toContain('&lt;bar&gt;');
    });

    it('produces XML with balanced angle brackets under hostile input', async () => {
        // Cheap well-formedness proxy: every '<' opens a tag we also close.
        const xml = await xmlOf(
            subsonicOk({ song: { title: '</song></subsonic-response><evil>' } }, 'xml'),
        );

        const opens = (xml.match(/</g) ?? []).length;
        const closes = (xml.match(/>/g) ?? []).length;
        expect(opens).toBe(closes);
        expect(xml).not.toContain('<evil>');
    });

    it('leaves JSON responses to JSON.stringify, which handles control chars', async () => {
        const res = subsonicOk({ song: { title: 'Track\x0BName' } }, 'json');
        const body = await res.text();

        // Valid JSON is the requirement here — stringify escapes control chars itself.
        expect(() => JSON.parse(body)).not.toThrow();
    });
});
