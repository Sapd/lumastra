// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { attachmentDisposition } from './content-disposition.js';

describe('attachmentDisposition', () => {
    it('passes an ordinary filename through', () => {
        const v = attachmentDisposition('track.mp3');
        expect(v).toContain('filename="track.mp3"');
        expect(v).toContain("filename*=UTF-8''track.mp3");
    });

    it('neutralises a quote that would close the parameter early', () => {
        // The attack: a media file named `evil".mp3` ends the quoted string and
        // lets everything after it parse as further header parameters.
        const v = attachmentDisposition('evil".mp3');

        const quoted = /filename="([^"]*)"/.exec(v);
        expect(quoted).not.toBeNull();
        expect(quoted![1]).not.toContain('"');
        // Exactly one quoted parameter — no injected second one.
        expect(v.match(/filename="/g)).toHaveLength(1);
    });

    it('neutralises a backslash, which also escapes inside a quoted-string', () => {
        const v = attachmentDisposition('back\\slash.mp3');
        expect(/filename="([^"]*)"/.exec(v)![1]).not.toContain('\\');
    });

    it('strips control characters', () => {
        const v = attachmentDisposition('a\r\nb\u0000c.mp3');
        // eslint-disable-next-line no-control-regex -- asserting they are gone
        expect(v).not.toMatch(/[\u0000-\u001F]/);
    });

    it('carries a non-ASCII name in filename* rather than mangling it', () => {
        const v = attachmentDisposition('Fernsehen – Übung.mp3');

        // ASCII fallback stays legal...
        expect(/filename="([^"]*)"/.exec(v)![1]).toMatch(/^[ -~]*$/);
        // ...and the real name survives, percent-encoded.
        expect(v).toContain("filename*=UTF-8''");
        expect(decodeURIComponent(v.split("UTF-8''")[1])).toBe('Fernsehen – Übung.mp3');
    });

    it('falls back when the name sanitises away entirely', () => {
        const v = attachmentDisposition('\u0000\u0001', 'export.json');
        expect(v).toContain('filename="export.json"');
    });

    it('handles a username-style injection in an export filename', () => {
        // Registering a username containing a quote, then having an admin
        // export that account, is the gdpr-export path.
        const v = attachmentDisposition('lumastra-export-a"; x=y-2026-01-01.json');
        expect(v.match(/filename="/g)).toHaveLength(1);
        expect(/filename="([^"]*)"/.exec(v)![1]).not.toContain('"');
    });

    // RFC 8187 attr-char permits only ALPHA/DIGIT and ! # $ & + - . ^ _ ` | ~ .
    // encodeURIComponent leaves ' ( ) * raw, and none of those four qualify —
    // so they must be escaped by hand or the ext-value is malformed.
    it('percent-encodes the characters encodeURIComponent leaves but RFC 8187 forbids', () => {
        const v = attachmentDisposition("Guns N' Roses - Song (Live)*.mp3");
        const ext = v.split("UTF-8''")[1];

        expect(ext).not.toMatch(/['()*]/);
        expect(ext).toContain('%27'); // '
        expect(ext).toContain('%28'); // (
        expect(ext).toContain('%29'); // )
        expect(ext).toContain('%2A'); // *
        // ...and still round-trips to the original name.
        expect(decodeURIComponent(ext)).toBe("Guns N' Roses - Song (Live)*.mp3");
    });

    it('leaves characters that ARE valid attr-char unescaped', () => {
        const ext = attachmentDisposition('a!b-c.d_e~f.mp3').split("UTF-8''")[1];
        expect(ext).toBe('a!b-c.d_e~f.mp3');
    });
});
