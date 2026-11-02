// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildTimelineDelivery } from './playback-timeline.service.js';
import { timelineSubtitleDescriptorSchema } from '$lib/schemas/playback.js';

describe('selected-file subtitle delivery', () => {
    it('uses absolute indices and per-file synthetic sidecar positions with ready hrefs', () => {
        const result = buildTimelineDelivery(
            'item',
            'selected',
            [
                {
                    index: 6,
                    codec: 'hdmv_pgs_subtitle',
                    language: 'en',
                    title: 'English',
                    default: false,
                    forced: true,
                },
            ],
            [
                { id: 'wrong', file_id: 'other', format: 'srt', language: 'de', is_forced: false },
                {
                    id: 'sidecar',
                    file_id: 'selected',
                    format: 'srt',
                    language: 'en',
                    is_forced: false,
                },
            ],
        );
        expect(result.href).toBe('/api/v1/playback/item/timeline?fileId=selected');
        expect(result.subtitles).toHaveLength(2);
        expect(result.subtitles[0]).toMatchObject({
            id: 'selected:6',
            index: 6,
            format: 'bitmap',
            kind: 'embedded',
            hrefs: {
                raw: '/api/v1/playback/item/subtitles/6?fileId=selected&format=pgssub',
                rendered: '/api/v1/playback/item/subtitles/6/rendered?fileId=selected',
            },
        });
        expect(result.subtitles[1]).toMatchObject({
            id: 'sidecar',
            index: 1000,
            kind: 'external',
            hrefs: {
                text: '/api/v1/playback/item/subtitles/external/sidecar?fileId=selected&format=vtt',
            },
        });
        for (const subtitle of result.subtitles)
            expect(timelineSubtitleDescriptorSchema.safeParse(subtitle).success).toBe(true);
    });
});

it.each(['internal', 'v1'] as const)(
    'keeps all subtitle/timeline hrefs on the %s surface',
    (surface) => {
        const delivery = buildTimelineDelivery(
            'item',
            'file',
            [
                {
                    index: 5,
                    codec: 'pgs',
                    language: 'en',
                    default: false,
                    forced: false,
                },
            ],
            [{ id: 'sidecar', file_id: 'file', format: 'srt', language: 'en', is_forced: false }],
            surface,
        );
        const prefix = surface === 'v1' ? '/api/v1/' : '/api/';
        expect(delivery.href.startsWith(prefix)).toBe(true);
        for (const subtitle of delivery.subtitles) {
            for (const href of Object.values(subtitle.hrefs))
                expect(href.startsWith(prefix)).toBe(true);
        }
        if (surface === 'internal') expect(JSON.stringify(delivery)).not.toContain('/api/v1/');
    },
);

it('sidecar href and selection id survive insertion before the selected track', () => {
    const sidecar = {
        id: 'chosen',
        file_id: 'file',
        format: 'ass',
        language: 'en',
        is_forced: false,
    };
    const before = buildTimelineDelivery('item', 'file', [], [sidecar]).subtitles[0];
    const after = buildTimelineDelivery(
        'item',
        'file',
        [],
        [{ ...sidecar, id: 'inserted' }, sidecar],
    ).subtitles[1];
    expect(after.id).toBe(before.id);
    expect(after.hrefs).toEqual(before.hrefs);
    expect(after.hrefs.raw).toContain('/external/chosen?fileId=file&format=ass');
});
