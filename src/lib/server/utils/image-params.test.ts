// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    parseImageSize,
    parseImageFormat,
    applySaveDataDowngrade,
    resolveImageFormat,
    isSaveData,
    snapWidthToPreset,
    snapQualityToTier,
    parseExact,
    resolveEffectiveImageOptions,
    resolvePublicImageOptions,
    PUBLIC_IMAGE_WIDTHS,
    sizeCacheToken,
    qualityCacheToken,
} from './image-params';
// The ladder itself, so the property test asserts against the real widths
// rather than a copy that could drift when a preset is added.
import { SIZE_PRESET_WIDTHS } from './image-proxy';

// Mock the config module so each test can pin IMAGE_AVIF_ENABLED and
// IMAGE_WEBP_ENABLED independently.
vi.mock('$lib/server/config', () => ({
    config: {
        IMAGE_AVIF_ENABLED: true,
        IMAGE_WEBP_ENABLED: true,
    },
}));

import { config } from '$lib/server/config';

type ImageConfig = { IMAGE_AVIF_ENABLED: boolean; IMAGE_WEBP_ENABLED: boolean };

beforeEach(() => {
    (config as ImageConfig).IMAGE_AVIF_ENABLED = true;
    (config as ImageConfig).IMAGE_WEBP_ENABLED = true;
});

describe('parseImageSize', () => {
    it('returns the requested preset when valid', () => {
        const url = new URL('http://x/?size=card');
        expect(parseImageSize(url)).toBe('card');
    });

    it('falls back to "full" when missing', () => {
        const url = new URL('http://x/');
        expect(parseImageSize(url)).toBe('full');
    });

    it('falls back to "full" when unknown', () => {
        const url = new URL('http://x/?size=mega');
        expect(parseImageSize(url)).toBe('full');
    });

    it('accepts the new card variant (regression: was missing from allow-list)', () => {
        expect(parseImageSize(new URL('http://x/?size=card'))).toBe('card');
    });

    it('accepts hd and wide backdrop presets', () => {
        expect(parseImageSize(new URL('http://x/?size=hd'))).toBe('hd');
        expect(parseImageSize(new URL('http://x/?size=wide'))).toBe('wide');
    });
});

describe('parseImageFormat', () => {
    it('accepts avif (regression: was missing from allow-list)', () => {
        expect(parseImageFormat(new URL('http://x/?format=avif'))).toBe('avif');
    });

    it('returns undefined for unknown formats', () => {
        expect(parseImageFormat(new URL('http://x/?format=jxl'))).toBeUndefined();
    });

    it('returns undefined when missing', () => {
        expect(parseImageFormat(new URL('http://x/'))).toBeUndefined();
    });
});

describe('applySaveDataDowngrade', () => {
    function reqWith(headers: Record<string, string>): Request {
        return new Request('http://x/', { headers });
    }

    it('downgrades full → wide when Save-Data: on', () => {
        expect(applySaveDataDowngrade('full', reqWith({ 'save-data': 'on' }))).toBe('wide');
    });

    it('downgrades wide → hd', () => {
        expect(applySaveDataDowngrade('wide', reqWith({ 'save-data': 'on' }))).toBe('hd');
    });

    it('downgrades hd → card', () => {
        expect(applySaveDataDowngrade('hd', reqWith({ 'save-data': 'on' }))).toBe('card');
    });

    it('downgrades card → medium', () => {
        expect(applySaveDataDowngrade('card', reqWith({ 'save-data': 'on' }))).toBe('medium');
    });

    it('downgrades medium → thumb', () => {
        expect(applySaveDataDowngrade('medium', reqWith({ 'save-data': 'on' }))).toBe('thumb');
    });

    it('thumb stays thumb (cannot downgrade further)', () => {
        expect(applySaveDataDowngrade('thumb', reqWith({ 'save-data': 'on' }))).toBe('thumb');
    });

    it('does not downgrade when header missing', () => {
        expect(applySaveDataDowngrade('full', reqWith({}))).toBe('full');
    });

    it('matches Save-Data case-insensitively (W3C spec)', () => {
        // Regression: codex review found we were checking lowercase only.
        expect(applySaveDataDowngrade('full', reqWith({ 'save-data': 'ON' }))).toBe('wide');
    });
});

describe('isSaveData', () => {
    it('returns false when header missing', () => {
        expect(isSaveData(new Request('http://x/'))).toBe(false);
    });

    it('returns true for Save-Data: on', () => {
        expect(isSaveData(new Request('http://x/', { headers: { 'save-data': 'on' } }))).toBe(true);
    });

    it('returns true for Save-Data: ON (case insensitive)', () => {
        expect(isSaveData(new Request('http://x/', { headers: { 'save-data': 'ON' } }))).toBe(true);
    });
});

describe('resolveImageFormat', () => {
    const urlWith = (search = ''): URL => new URL('http://x/' + search);
    const reqWith = (accept = ''): Request => new Request('http://x/', { headers: { accept } });

    it('explicit ?format= wins over Accept', () => {
        expect(
            resolveImageFormat(urlWith('?format=jpg'), reqWith('image/avif,image/webp,image/*')),
        ).toBe('jpg');
    });

    it('returns avif when Accept lists image/avif and AVIF is enabled', () => {
        expect(resolveImageFormat(urlWith(), reqWith('image/avif,image/webp,image/*;q=0.8'))).toBe(
            'avif',
        );
    });

    it('returns webp when Accept lacks image/avif', () => {
        expect(resolveImageFormat(urlWith(), reqWith('image/webp,image/*'))).toBe('webp');
    });

    it('returns webp when Accept missing', () => {
        expect(resolveImageFormat(urlWith(), reqWith())).toBe('webp');
    });

    it('returns webp even on AVIF-capable client when IMAGE_AVIF_ENABLED is false', () => {
        (config as ImageConfig).IMAGE_AVIF_ENABLED = false;
        expect(resolveImageFormat(urlWith(), reqWith('image/avif,image/webp'))).toBe('webp');
    });

    it('matches image/avif case-insensitively', () => {
        expect(resolveImageFormat(urlWith(), reqWith('IMAGE/AVIF,image/webp'))).toBe('avif');
    });

    it('returns jpg when IMAGE_WEBP_ENABLED is false (preserves pre-AVIF contract)', () => {
        // Codex regression: resolveImageFormat used to hardcode 'webp' as the
        // non-AVIF default, ignoring IMAGE_WEBP_ENABLED. Operators who
        // disabled WebP for client compatibility were silently still served
        // WebP. The fallback chain is now AVIF → WebP → JPEG.
        (config as ImageConfig).IMAGE_AVIF_ENABLED = false;
        (config as ImageConfig).IMAGE_WEBP_ENABLED = false;
        expect(resolveImageFormat(urlWith(), reqWith('image/*'))).toBe('jpg');
    });

    it('still returns avif for AVIF clients even when WebP is disabled', () => {
        (config as ImageConfig).IMAGE_WEBP_ENABLED = false;
        expect(resolveImageFormat(urlWith(), reqWith('image/avif,image/webp'))).toBe('avif');
    });
});

// Preset widths (single source of truth in image-proxy.ts): thumb 250, medium
// 350, card 480. ±20% snap windows: thumb [200,300], medium [280,420],
// card [384,576]. (Nearest-preset wins where windows overlap.)
describe('snapWidthToPreset', () => {
    it('snaps a width within 20% onto the nearest preset (card: 480 ← 460)', () => {
        expect(snapWidthToPreset(460)).toEqual({ size: 'card' });
    });

    it('sends a width in the thumb/medium overlap UP to medium, not down to thumb', () => {
        // CHANGED 2026-08-28. Both 295 and 305 sit inside thumb's band [200,300]
        // or medium's [280,420]; 295 is inside both. It used to pick by absolute
        // distance, so 295 → thumb(250) — 45 pixels FEWER than asked for, and a
        // visible softening. Downscaling in the browser is free; upscaling is
        // not, so among presets that pass the same ±20% membership test we now
        // take the smallest that still covers the request.
        expect(snapWidthToPreset(295)).toEqual({ size: 'medium' });
        expect(snapWidthToPreset(305)).toEqual({ size: 'medium' });
    });

    it('breaks an exact tie upward instead of by declaration order', () => {
        // 300 is equidistant from thumb(250) and medium(350). The old comparison
        // was strict `<`, so the incumbent won — and the incumbent was whichever
        // key Object.entries yielded first, i.e. thumb because it is declared
        // first. Which preset a caller got was decided by the order constants
        // happen to be written in.
        expect(snapWidthToPreset(300)).toEqual({ size: 'medium' });
    });

    it('sends 400 up to card, for a different reason than 300 goes up to medium', () => {
        // Worth separating, because the two reported cases are not the same bug.
        // 300 was an exact TIE resolved by declaration order. 400 was never a
        // tie — it is genuinely nearer medium(350) than card(480), absolutely
        // (50 vs 80) and relatively (0.143 vs 0.167), so every nearest-rule
        // agreed on medium and the old behaviour was self-consistent.
        //
        // It moves anyway because nearest is the wrong objective: 400 is inside
        // card's band (|400-480|/480 = 0.167 ≤ 0.20) and card COVERS the
        // request, so serving 350 was handing back 50 pixels fewer than asked
        // for and letting the client upscale. This is the change working as
        // intended, not a tie-break artefact.
        expect(snapWidthToPreset(400)).toEqual({ size: 'card' });
    });

    it('collapses 470 and 490 both onto card (cache-key collapse for near-preset widths)', () => {
        expect(snapWidthToPreset(470)).toEqual({ size: 'card' });
        expect(snapWidthToPreset(490)).toEqual({ size: 'card' });
    });

    it('renders a custom maxWidth when the width is far from every preset', () => {
        // 700: nearest presets are card(480, +46%) and hd(1280, -45%) — both
        // outside the ±20% snap band → custom.
        expect(snapWidthToPreset(700)).toEqual({ maxWidth: 700 });
    });

    it('snaps a wide width onto the hd preset', () => {
        // 1280 is the hd preset exactly; 1300 (within ±20%) also snaps to hd.
        expect(snapWidthToPreset(1280)).toEqual({ size: 'hd' });
        expect(snapWidthToPreset(1300)).toEqual({ size: 'hd' });
    });

    it('snaps a full-bleed width onto the wide preset', () => {
        expect(snapWidthToPreset(1920)).toEqual({ size: 'wide' });
    });

    it('renders custom for a small width below the thumb snap window', () => {
        // 150: nearest is thumb(250), dist 100/250 = 0.4 > 0.20 → custom.
        expect(snapWidthToPreset(150)).toEqual({ maxWidth: 150 });
    });

    it('clamps a custom width to [1, 3840]', () => {
        expect(snapWidthToPreset(99999)).toEqual({ maxWidth: 3840 });
        expect(snapWidthToPreset(0)).toEqual({ maxWidth: 1 });
    });

    it('prefers the covering preset when a width qualifies for two (384 → card)', () => {
        // CHANGED 2026-08-28. 384 is the bottom edge of card's band [384,576] and
        // also inside medium's [280,420]. Nearest picked medium(350) and handed
        // back 34 fewer pixels than requested; card(480) covers it.
        expect(snapWidthToPreset(384)).toEqual({ size: 'card' });
    });

    it('does not promote an exact custom width onto a bigger preset (1537 stays custom)', () => {
        // The catch that measurement found and reasoning missed. 1537's NEAREST
        // preset is hd(1280) at 20.1% — just outside tolerance — so it renders
        // as an exact 1537px custom derivative, which is already the ideal
        // answer. A first cut at "prefer up" asked whether ANY preset qualified;
        // wide(1920) is 19.9% away, so 1537..1600 got promoted to 1920 — 56%
        // more pixels than requested, on the most expensive rung. Snapping is
        // still gated on the nearest preset, exactly as before; only the choice
        // among qualifiers changed.
        expect(snapWidthToPreset(1537)).toEqual({ maxWidth: 1537 });
        expect(snapWidthToPreset(1600)).toEqual({ maxWidth: 1600 });
    });

    it('does send 1536 up to wide — there hd would be an upscale', () => {
        // Contrast with 1537: at exactly 1536 the nearest (hd) IS within
        // tolerance, so snapping is on, and among the qualifiers wide is the one
        // that covers the request. hd would hand back 1280 for a 1536 ask.
        expect(snapWidthToPreset(1536)).toEqual({ size: 'wide' });
    });

    it('never jumps to an expensive rung — 1300 and 1500 stay on hd', () => {
        // The regression lock for "prefer up". Preferring the covering preset is
        // only safe because the bands barely overlap: card's ends at 576 and
        // hd's begins at 1024, so nothing in between qualifies for both. 1920 is
        // 32% away from 1300 and fails membership outright, which makes the
        // feared 1300 → 1920 structurally impossible rather than merely unlikely.
        expect(snapWidthToPreset(1300)).toEqual({ size: 'hd' });
        expect(snapWidthToPreset(1500)).toEqual({ size: 'hd' });
    });

    it('never returns a preset narrower than the tolerance allows', () => {
        // Property form of the whole point: whatever rung is chosen, it is never
        // so much smaller than the request that the client is visibly upscaling.
        for (let w = 1; w <= 2500; w++) {
            const snapped = snapWidthToPreset(w);
            if (!snapped.size || snapped.size === 'full') continue;
            const presetW = SIZE_PRESET_WIDTHS[snapped.size as keyof typeof SIZE_PRESET_WIDTHS];
            expect({ w, ok: presetW >= w / 1.2 }).toEqual({ w, ok: true });
        }
    });

    it('snaps at the upper 20% boundary of card (576 = 480*1.2 → card)', () => {
        // 576 nearest to card(480, dist 96 = exactly 20%), within tolerance.
        expect(snapWidthToPreset(576)).toEqual({ size: 'card' });
    });
});

describe('snapQualityToTier', () => {
    it('snaps within 20% to the nearest tier (85 ← 82)', () => {
        expect(snapQualityToTier(82)).toBe(85);
    });

    it('snaps 88 → 85', () => {
        expect(snapQualityToTier(88)).toBe(85);
    });

    it('snaps a midpoint to the nearest tier; ties pick the lower tier (60 → 50)', () => {
        // 60 is equidistant (10) from 50 and 70; both within 20%. Nearest scan
        // keeps the first-seen (lower) tier on a tie → 50.
        expect(snapQualityToTier(60)).toBe(50);
    });

    it('returns q unchanged when outside all tier windows (30 < 50*0.8=40)', () => {
        expect(snapQualityToTier(30)).toBe(30);
    });

    it('snaps toward the top tier; ties pick the lower (90 → 85)', () => {
        // 90 equidistant (5) from 85 and 95 → lower tier 85 on tie.
        expect(snapQualityToTier(90)).toBe(85);
    });

    it('snaps clearly into the top tier (94 → 95)', () => {
        expect(snapQualityToTier(94)).toBe(95);
    });
});

describe('parseExact', () => {
    it('true for exact=true / 1 / yes', () => {
        expect(parseExact(new URL('http://x/?exact=true'))).toBe(true);
        expect(parseExact(new URL('http://x/?exact=1'))).toBe(true);
        expect(parseExact(new URL('http://x/?exact=YES'))).toBe(true);
    });

    it('false when missing or falsey', () => {
        expect(parseExact(new URL('http://x/'))).toBe(false);
        expect(parseExact(new URL('http://x/?exact=false'))).toBe(false);
        expect(parseExact(new URL('http://x/?exact=0'))).toBe(false);
    });
});

describe('resolveEffectiveImageOptions', () => {
    const req = (headers: Record<string, string> = {}): Request =>
        new Request('http://x/', { headers });

    it('named ?size=card → bounded preset, no maxWidth', () => {
        const o = resolveEffectiveImageOptions(new URL('http://x/?size=card'), req());
        expect(o.size).toBe('card');
        expect(o.maxWidth).toBeUndefined();
        expect(o.bounded).toBe(true);
    });

    it('?width=460 snaps onto card → bounded preset, raw width does not leak', () => {
        const o = resolveEffectiveImageOptions(new URL('http://x/?width=460'), req());
        expect(o.size).toBe('card');
        expect(o.maxWidth).toBeUndefined();
        expect(o.bounded).toBe(true);
    });

    it('?width=700 (far) → custom maxWidth, NOT bounded', () => {
        const o = resolveEffectiveImageOptions(new URL('http://x/?width=700'), req());
        expect(o.maxWidth).toBe('700');
        expect(o.bounded).toBe(false);
    });

    it('?width=1280 snaps onto the hd preset (bounded)', () => {
        const o = resolveEffectiveImageOptions(new URL('http://x/?width=1280'), req());
        expect(o.size).toBe('hd');
        expect(o.maxWidth).toBeUndefined();
        expect(o.bounded).toBe(true);
    });

    it('?exact=true bypasses width snap → exact custom width, NOT bounded', () => {
        const o = resolveEffectiveImageOptions(new URL('http://x/?width=460&exact=true'), req());
        expect(o.maxWidth).toBe('460');
        expect(o.bounded).toBe(false);
        expect(o.exact).toBe(true);
    });

    it('?quality=82 snaps to 85; ?exact bypasses and keeps 82', () => {
        expect(resolveEffectiveImageOptions(new URL('http://x/?quality=82'), req()).quality).toBe(
            85,
        );
        expect(
            resolveEffectiveImageOptions(new URL('http://x/?quality=82&exact=true'), req()).quality,
        ).toBe(82);
    });

    it('Save-Data downgrades the named preset (card → medium)', () => {
        const o = resolveEffectiveImageOptions(
            new URL('http://x/?size=card'),
            req({ 'save-data': 'on' }),
        );
        expect(o.size).toBe('medium');
        expect(o.bounded).toBe(true);
    });
});

describe('cache tokens (no raw width/quality leak)', () => {
    it('two near-preset widths produce the SAME size token via snap → one cache entry', () => {
        const a = resolveEffectiveImageOptions(
            new URL('http://x/?width=470'),
            new Request('http://x/'),
        );
        const b = resolveEffectiveImageOptions(
            new URL('http://x/?width=490'),
            new Request('http://x/'),
        );
        expect(sizeCacheToken(a)).toBe('card');
        expect(sizeCacheToken(b)).toBe('card');
        expect(sizeCacheToken(a)).toBe(sizeCacheToken(b));
    });

    it('a custom width gets its own w<N> token, distinct from presets', () => {
        const o = resolveEffectiveImageOptions(
            new URL('http://x/?width=700'),
            new Request('http://x/'),
        );
        expect(sizeCacheToken(o)).toBe('w700');
    });

    it('quality token is q<N> when set, qdef when unset', () => {
        expect(qualityCacheToken(85)).toBe('q85');
        expect(qualityCacheToken(undefined)).toBe('qdef');
    });

    it('size token maps named presets and full directly', () => {
        expect(sizeCacheToken({ size: 'thumb' })).toBe('thumb');
        expect(sizeCacheToken({ size: 'full' })).toBe('full');
    });
});

describe('public media width buckets', () => {
    it.each(['width', 'maxWidth'])(
        'bounds every %s from 1 through 3840, including exact requests',
        (parameter) => {
            const request = new Request('http://localhost/image');
            for (const exact of ['true', 'false']) {
                const widths = new Set<number>();
                for (let width = 1; width <= 3840; width++) {
                    const options = resolvePublicImageOptions(
                        new URL(`http://localhost/image?${parameter}=${width}&exact=${exact}`),
                        request,
                    );
                    const effective = options.maxWidth
                        ? Number(options.maxWidth)
                        : SIZE_PRESET_WIDTHS[options.size as keyof typeof SIZE_PRESET_WIDTHS];
                    expect(PUBLIC_IMAGE_WIDTHS).toContain(effective);
                    widths.add(effective);
                }
                expect(widths.size).toBeLessThanOrEqual(PUBLIC_IMAGE_WIDTHS.length);
            }
        },
    );
});
