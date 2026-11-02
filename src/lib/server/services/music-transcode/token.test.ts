// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { signTranscodeToken, verifyTranscodeToken, _setSecretForTests } from './token.js';

const SECRET = 'unit-test-secret';

beforeEach(() => {
    _setSecretForTests(SECRET);
});

describe('transcode token', () => {
    const payload = {
        v: 1 as const,
        mid: 'media-uuid',
        mt: 'song' as const,
        c: 'mp3' as const,
        ct: 'mp3',
        br: 192,
        fp: 'deadbeef',
        exp: Math.floor(Date.now() / 1000) + 3600,
    };

    it('round-trips a valid payload', () => {
        const token = signTranscodeToken(payload);
        const result = verifyTranscodeToken(token, payload.mid);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.payload).toEqual(payload);
    });

    it('rejects tampered signature', () => {
        const token = signTranscodeToken(payload);
        // Tamper the FIRST character of the signature segment, not the last
        // char of the whole token. A 32-byte HMAC base64url-encodes to 43
        // chars whose final char only carries the signature's lowest bits —
        // flipping it can leave the decoded bytes unchanged (the altered bit
        // lands in base64 padding), so the round-trip survives and the test
        // flakes. The first signature char always maps to a significant byte.
        const [body, sig] = token.split('.');
        const tamperedSigHead = sig[0] === 'A' ? 'B' : 'A';
        const tampered = `${body}.${tamperedSigHead}${sig.slice(1)}`;
        const result = verifyTranscodeToken(tampered, payload.mid);
        expect(result.ok).toBe(false);
    });

    it('rejects wrong mediaId', () => {
        const token = signTranscodeToken(payload);
        const result = verifyTranscodeToken(token, 'other-uuid');
        expect(result.ok).toBe(false);
    });

    it('rejects expired tokens', () => {
        const expired = { ...payload, exp: Math.floor(Date.now() / 1000) - 10 };
        const token = signTranscodeToken(expired);
        const result = verifyTranscodeToken(token, payload.mid);
        expect(result.ok).toBe(false);
    });

    it('rejects malformed tokens', () => {
        expect(verifyTranscodeToken('not-a-token', payload.mid).ok).toBe(false);
        expect(verifyTranscodeToken('', payload.mid).ok).toBe(false);
        expect(verifyTranscodeToken('abc.def.ghi', payload.mid).ok).toBe(false);
    });
});
