// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import {
    resolvePublicImageOptions,
    restrictImageOptions,
    QUALITY_TIERS,
    PUBLIC_IMAGE_WIDTHS,
    parseAvatarImageOptions,
} from './image-params';
import { restrictImageRequest, runImageProviderBudget } from '../services/image-proxy/work-budget';

const request = new Request('https://app.test/image', { headers: { accept: 'image/avif' } });

describe.each(['anonymous', 'signed', 'authenticated'] as const)('%s image options', (identity) => {
    it('restricts anonymous/signed qualities even with exact=true and keeps AVIF on presets only', async () => {
        const event = {
            locals: identity === 'anonymous' ? {} : { user: { username: 'alice' } },
            url: new URL(`https://app.test/image${identity === 'signed' ? '?sig=valid' : ''}`),
        } as RequestEvent;
        const restricted = restrictImageRequest(event);
        expect(restricted).toBe(identity !== 'authenticated');
        await runImageProviderBudget(
            async () => null,
            async () => {
                const qualities = new Set<number>();
                for (let quality = 1; quality <= 100; quality++) {
                    const url = new URL(
                        `https://app.test/image?size=thumb&quality=${quality}&exact=true&format=avif`,
                    );
                    const options = resolvePublicImageOptions(url, request);
                    qualities.add(options.quality!);
                    expect(options.format).toBe('avif');
                }
                expect(qualities.size).toBe(restricted ? 4 : 100);
                if (restricted) expect([...qualities]).toEqual([...QUALITY_TIERS]);
                for (const suffix of ['size=full', 'width=601&exact=true', 'width=3840', '']) {
                    const options = resolvePublicImageOptions(
                        new URL(`https://app.test/image?format=avif&${suffix}`),
                        request,
                    );
                    expect(options.format).toBe(restricted ? 'webp' : 'avif');
                }
                // Legacy callers hand-build ImageOptions; restriction must run before their keys too.
                expect(
                    restrictImageOptions({ size: 'full', format: 'avif', quality: 1 }),
                ).toMatchObject(
                    restricted ? { quality: 50, format: 'webp' } : { quality: 1, format: 'avif' },
                );
                return new Response();
            },
            undefined,
            restricted,
        );
    });
});

describe.each([true, false])('raw dimension bucketing (restricted=%s)', (restricted) => {
    it('bounds maxWidth and width across the full pixel range, including exact legacy options', async () => {
        await runImageProviderBudget(
            async () => null,
            async () => {
                const widths = new Set<string>();
                for (let width = 1; width <= 3840; width++) {
                    const options = restrictImageOptions({
                        maxWidth: String(width),
                        width,
                        exact: true,
                    });
                    widths.add(options.maxWidth!);
                    expect(options.width).toBe(Number(options.maxWidth));
                    expect(Number(options.maxWidth)).toBeGreaterThanOrEqual(width);
                    expect(restrictImageOptions({ width: String(width) }).width).toBe(
                        options.maxWidth,
                    );
                }
                if (restricted) {
                    expect(
                        restrictImageOptions({ size: 'card', width: 601, format: 'avif' }).format,
                    ).toBe('webp');
                }
                expect([...widths]).toEqual(PUBLIC_IMAGE_WIDTHS.map(String));
                expect(restrictImageOptions({ size: 'card' })).toEqual({
                    size: 'card',
                    ...(restricted ? { quality: undefined, format: undefined } : {}),
                });
                for (const size of ['thumb', 'card', 'full']) {
                    const parsed = parseAvatarImageOptions(
                        new URL(`https://app.test/avatar?size=${size}`),
                    );
                    expect(restrictImageOptions(parsed)).toMatchObject({ size });
                    expect(parsed.maxWidth).toBeUndefined();
                }
                const avatar = restrictImageOptions(
                    parseAvatarImageOptions(new URL('https://app.test/avatar?width=97&size=thumb')),
                );
                expect(avatar.maxWidth).toBe('250');
                return new Response();
            },
            undefined,
            restricted,
        );
    });
});
