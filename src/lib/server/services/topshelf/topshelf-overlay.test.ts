// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
    normalizeOverlayStyle,
    normalizeOverlayLocale,
    serializeOverlayToken,
    parseOverlayToken,
    computeOverlayContentHash,
    computeOverlayBox,
    OVERLAY_ALLOWED_SCALES,
    OVERLAY_BOX_HEIGHT_FRACTION,
    type OverlayStyle,
} from './topshelf-overlay.js';

const DEFAULTS: OverlayStyle = { pos: 'tl', scrim: true, scale: 0.4 };

describe('normalizeOverlayStyle', () => {
    it('applies defaults when all omitted', () => {
        expect(normalizeOverlayStyle({}, DEFAULTS)).toEqual({ pos: 'tl', scrim: true, scale: 0.4 });
    });
    it('rejects invalid position → default', () => {
        expect(normalizeOverlayStyle({ pos: 'middle' }, DEFAULTS).pos).toBe('tl');
    });
    it('accepts a valid position', () => {
        expect(normalizeOverlayStyle({ pos: 'br' }, DEFAULTS).pos).toBe('br');
    });
    it('snaps scale to the nearest allowed bucket', () => {
        expect(normalizeOverlayStyle({ scale: '0.31' }, DEFAULTS).scale).toBe(0.33);
        expect(normalizeOverlayStyle({ scale: 99 }, DEFAULTS).scale).toBe(0.5);
    });
    it('coerces scrim', () => {
        expect(normalizeOverlayStyle({ scrim: '0' }, DEFAULTS).scrim).toBe(false);
        expect(normalizeOverlayStyle({ scrim: '1' }, DEFAULTS).scrim).toBe(true);
    });
    it('trims + lowercases pos before matching (FIX 8)', () => {
        expect(normalizeOverlayStyle({ pos: ' TL ' }, DEFAULTS).pos).toBe('tl');
        expect(normalizeOverlayStyle({ pos: 'Br' }, DEFAULTS).pos).toBe('br');
    });
    it('ALWAYS snaps the effective scale, even on the default-fallback path (FIX 3)', () => {
        // A misconfigured default (e.g. TOPSHELF_OVERLAY_DEFAULT_SCALE=1.0, off
        // the allowed grid) must still snap to a valid bucket, not pass through
        // verbatim — an unsnapped default mints a permanently-unparseable token.
        expect(normalizeOverlayStyle({}, { pos: 'tl', scrim: true, scale: 1.0 }).scale).toBe(0.5);
    });
});

describe('normalizeOverlayLocale', () => {
    it('passes through an allow-listed locale', () => {
        expect(normalizeOverlayLocale('de', ['en', 'de'])).toBe('de');
    });
    it('normalizes case/region and falls back to first entry when unknown', () => {
        expect(normalizeOverlayLocale('DE-AT', ['en', 'de'])).toBe('de');
        expect(normalizeOverlayLocale('fr', ['en', 'de'])).toBe('en');
        expect(normalizeOverlayLocale(null, ['en', 'de'])).toBe('en');
    });
    it('normalizes an unsafe allow-list entry to its token-safe primary subtag (FIX 2)', () => {
        // 'de-at' isn't itself token-safe, but its primary subtag 'de' is —
        // and the input's own primary subtag matches it.
        expect(normalizeOverlayLocale('de', ['de-at', 'zh'])).toBe('de');
        // 'zh-hans' reduces to the token-safe 'zh', so an input of 'zh' matches.
        expect(normalizeOverlayLocale('zh', ['zh-hans'])).toBe('zh');
    });
    it('falls back to "en" when the ENTIRE allow-list is token-unsafe', () => {
        expect(normalizeOverlayLocale('xyz', ['xyz'])).toBe('en');
        expect(normalizeOverlayLocale(null, ['xyz'])).toBe('en');
    });
    it('the result always matches the token-safe [a-z]{2} shape', () => {
        const cases: Array<[string | null, readonly string[]]> = [
            ['de', ['de-at', 'zh']],
            ['zh', ['zh-hans']],
            ['xyz', ['xyz']],
            [null, ['xyz']],
            ['DE-AT', ['en', 'de']],
            ['fr', ['en', 'de']],
        ];
        for (const [raw, allowList] of cases) {
            expect(normalizeOverlayLocale(raw, allowList)).toMatch(/^[a-z]{2}$/);
        }
    });
});

describe('overlay token round-trip', () => {
    it('serializes/parses a logo token (no locale)', () => {
        const t = serializeOverlayToken('preview', 'logo', { pos: 'tl', scrim: true, scale: 0.4 });
        expect(t).toBe('preview-ov-logo-tl-s1-x40');
        expect(parseOverlayToken(t)).toEqual({
            base: 'preview',
            mode: 'logo',
            style: { pos: 'tl', scrim: true, scale: 0.4 },
        });
    });
    it('serializes/parses a text token with locale', () => {
        const t = serializeOverlayToken(
            'cinemagraph',
            'text',
            { pos: 'tr', scrim: false, scale: 0.33 },
            'de',
        );
        expect(t).toBe('cinemagraph-ov-text-de-tr-s0-x33');
        expect(parseOverlayToken(t)).toEqual({
            base: 'cinemagraph',
            mode: 'text',
            style: { pos: 'tr', scrim: false, scale: 0.33 },
            locale: 'de',
        });
    });
    it('rejects plain and malformed tokens', () => {
        expect(parseOverlayToken('preview')).toBeNull();
        expect(parseOverlayToken('preview-ov-logo')).toBeNull();
        expect(parseOverlayToken('preview-ov-bogus-tl-s1-x40')).toBeNull();
        expect(parseOverlayToken('preview-ov-logo-tl-s2-x40')).toBeNull(); // scrim not 0/1
    });
});

describe('computeOverlayContentHash', () => {
    it('is stable and mode/content sensitive', () => {
        const a = computeOverlayContentHash({ mode: 'logo', identity: 'url|2026-01-01' });
        const b = computeOverlayContentHash({ mode: 'logo', identity: 'url|2026-02-02' });
        const c = computeOverlayContentHash({ mode: 'text', text: 'S01E01 · Pilot' });
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        expect(a).not.toBe(b);
        expect(a).not.toBe(c);
        expect(computeOverlayContentHash({ mode: 'text', text: 'S01E01 · Pilot' })).toBe(c);
    });

    it('folds the episode badge in, and leaves a badge-less logo hash byte-identical', () => {
        const plain = computeOverlayContentHash({ mode: 'logo', identity: 'url|2026-01-01' });
        const badged = computeOverlayContentHash({
            mode: 'logo',
            identity: 'url|2026-01-01',
            badge: 'S01E02',
        });
        const renumbered = computeOverlayContentHash({
            mode: 'logo',
            identity: 'url|2026-01-01',
            badge: 'S01E03',
        });

        expect(badged).not.toBe(plain);
        expect(renumbered).not.toBe(badged);
        // Explicitly-absent badge must hash exactly like the pre-badge form,
        // so no already-rendered movie/series artifact is invalidated.
        expect(
            computeOverlayContentHash({
                mode: 'logo',
                identity: 'url|2026-01-01',
                badge: undefined,
            }),
        ).toBe(plain);
    });
});

describe('computeOverlayBox (fixed overlay box)', () => {
    it('derives both axes in absolute px from (scale, maxWidth)', () => {
        expect(computeOverlayBox(0.4, 1280)).toEqual({
            baseWidth: 1280,
            baseHeight: 720,
            boxW: 512,
            boxH: 187,
        });
        // The shipped default base width.
        expect(computeOverlayBox(0.4, 640)).toEqual({
            baseWidth: 640,
            baseHeight: 360,
            boxW: 256,
            boxH: 94,
        });
    });

    it('bounds the HEIGHT independently of the style scale — the fix for the tall-logo oversize', () => {
        const heights = OVERLAY_ALLOWED_SCALES.map((s) => computeOverlayBox(s, 1280).boxH);
        expect(new Set(heights).size).toBe(1);
        // Widest allowed scale still cannot make the box dominate the frame.
        const widest = computeOverlayBox(Math.max(...OVERLAY_ALLOWED_SCALES), 1280);
        expect(widest.boxH / widest.baseHeight).toBeCloseTo(OVERLAY_BOX_HEIGHT_FRACTION, 2);
        expect(widest.boxH / widest.baseHeight).toBeLessThan(0.3);
    });

    it('scales proportionally with the base width (resolution-independent geometry)', () => {
        const small = computeOverlayBox(0.4, 640);
        const large = computeOverlayBox(0.4, 1920);
        expect(large.boxW / large.baseWidth).toBeCloseTo(small.boxW / small.baseWidth, 2);
        expect(large.boxH / large.baseHeight).toBeCloseTo(small.boxH / small.baseHeight, 2);
    });

    it('never degenerates to a zero/negative box', () => {
        const tiny = computeOverlayBox(0.0001, 1);
        expect(tiny.boxW).toBeGreaterThanOrEqual(1);
        expect(tiny.boxH).toBeGreaterThanOrEqual(1);
    });
});
