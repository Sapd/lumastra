// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins this route's actual PlaySessionId behavior (fix-round-1 review finding,
 * 2026-09-16, Important 2): this is the one of three `startHlsPlayback`
 * callers that never reaches the seam guard with a malformed id — a
 * traversal id like `..` is silently replaced with a fresh `randomUUID()`
 * rather than rejected with 400. That is intentional and pre-existing
 * (unchanged by the C1 fix), but was previously asserted only in prose, not
 * pinned by a test — this file is that test.
 */

import { describe, it, expect } from 'vitest';
import { resolvePlaySessionId } from './session-id-resolution.js';

const FRESH_ID = 'generated-uuid-1234';
const generateId = () => FRESH_ID;

describe('resolvePlaySessionId (web-player /api/playback/.../hls route)', () => {
    it('passes through a conforming client-supplied id unchanged', () => {
        expect(resolvePlaySessionId('client-session-abc', generateId)).toBe('client-session-abc');
    });

    it('passes through a preview- id unchanged (not a plain UUID, but charset-safe)', () => {
        expect(resolvePlaySessionId('preview-test-uuid-1234567890', generateId)).toBe(
            'preview-test-uuid-1234567890',
        );
    });

    it('substitutes a fresh id — does not reject — for a traversal id (..)', () => {
        expect(resolvePlaySessionId('..', generateId)).toBe(FRESH_ID);
    });

    it('substitutes a fresh id for a deeper traversal (../../app)', () => {
        expect(resolvePlaySessionId('../../app', generateId)).toBe(FRESH_ID);
    });

    it('substitutes a fresh id for a path-separator id (a/b)', () => {
        expect(resolvePlaySessionId('a/b', generateId)).toBe(FRESH_ID);
    });

    it('substitutes a fresh id for an empty string', () => {
        expect(resolvePlaySessionId('', generateId)).toBe(FRESH_ID);
    });

    it('substitutes a fresh id for a 129-char id (one over the charset cap)', () => {
        expect(resolvePlaySessionId('x'.repeat(129), generateId)).toBe(FRESH_ID);
    });

    it('substitutes a fresh id when no PlaySessionId param is present', () => {
        expect(resolvePlaySessionId(null, generateId)).toBe(FRESH_ID);
    });

    it('accepts the 128-char boundary unchanged', () => {
        const boundaryId = 'x'.repeat(128);
        expect(resolvePlaySessionId(boundaryId, generateId)).toBe(boundaryId);
    });
});
