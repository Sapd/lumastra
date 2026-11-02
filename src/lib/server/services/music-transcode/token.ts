// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicCodec } from './types.js';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '$lib/server/config.js';

export interface TranscodeTokenPayload {
    v: 1;
    mid: string; // mediaId
    mt: 'song'; // mediaType (only song for now; expand to podcast later)
    /**
     * Target codec. Widened to MusicCodec when the m4a (AAC-in-MP4) target was
     * added. Subsonic negotiation never selects it — `SUPPORTED_TARGETS` in
     * decision.ts deliberately still offers only opus/mp3/aac, so Subsonic
     * clients keep getting ADTS exactly as before — but the token type has to
     * admit the full codec union to stay assignable from a MusicCodec.
     */
    c: MusicCodec;
    ct: string; // container (mp3 | ogg | adts — wire-friendly value)
    br: number; // bitrate kbps
    fp: string; // source fingerprint (hex)
    exp: number; // expiry epoch seconds
}

let secretOverride: string | null = null;

/** Test-only. Production code uses config-derived secret. */
export function _setSecretForTests(secret: string | null): void {
    secretOverride = secret;
}

function getSecret(): string {
    if (secretOverride !== null) return secretOverride;
    const explicit = config.MUSIC_TRANSCODE_TOKEN_SECRET;
    if (explicit && explicit.length > 0) return explicit;
    // Fallback: derive from JWT_SECRET so we work out of the box.
    const jwt = config.JWT_SECRET;
    if (!jwt) {
        throw new Error('No MUSIC_TRANSCODE_TOKEN_SECRET or JWT_SECRET configured');
    }
    return createHmac('sha256', jwt).update('music-transcode').digest('hex');
}

function b64urlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Buffer | null {
    try {
        const pad = '='.repeat((4 - (str.length % 4)) % 4);
        return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
    } catch {
        return null;
    }
}

export function signTranscodeToken(payload: TranscodeTokenPayload): string {
    const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
    const sig = createHmac('sha256', getSecret()).update(body).digest();
    return `${body}.${b64urlEncode(sig)}`;
}

export type VerifyResult =
    { ok: true; payload: TranscodeTokenPayload } | { ok: false; reason: string };

export function verifyTranscodeToken(token: string, expectedMediaId: string): VerifyResult {
    const parts = token.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [body, sig] = parts;
    const sigBuf = b64urlDecode(sig);
    if (!sigBuf) return { ok: false, reason: 'malformed' };
    const expected = createHmac('sha256', getSecret()).update(body).digest();
    if (sigBuf.length !== expected.length) return { ok: false, reason: 'bad_signature' };
    if (!timingSafeEqual(sigBuf, expected)) return { ok: false, reason: 'bad_signature' };

    const bodyBuf = b64urlDecode(body);
    if (!bodyBuf) return { ok: false, reason: 'malformed' };
    let payload: TranscodeTokenPayload;
    try {
        payload = JSON.parse(bodyBuf.toString('utf8')) as TranscodeTokenPayload;
    } catch {
        // best-effort: unparseable token body is a validation failure, returned as a reason.
        return { ok: false, reason: 'malformed' };
    }
    if (payload.mid !== expectedMediaId) return { ok: false, reason: 'mediaId_mismatch' };
    if (payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
}
