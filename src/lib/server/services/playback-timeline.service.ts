// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    normalizeSubtitleCodec,
    supportedSubtitleFormats,
} from '$lib/components/player/subtitle-utils.js';
import type { SubtitleMethod } from '$lib/schemas/playback-plan.js';
import type { TimelineDelivery, TimelineSubtitleDescriptor } from '$lib/schemas/playback.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import { buildTimelineHref } from './playback-timeline-hrefs.js';

interface EmbeddedSubtitle {
    index: number;
    codec?: string;
    language: string | null;
    title?: string | null;
    default: boolean;
    forced: boolean;
}
interface ExternalSubtitle {
    id: string;
    file_id: string;
    format: string;
    language: string | null;
    is_forced: boolean;
}

const PGS = ['pgs', 'pgssub', 'hdmv_pgs_subtitle', 'sup'];
const VOBSUB = ['dvdsub', 'vobsub', 'dvd_subtitle', 'sub'];

/** REST delivery only: HLS rendition URLs retain their existing protocol. */
export function buildSubtitleDescriptor(
    itemId: string,
    fileId: string,
    track: EmbeddedSubtitle,
    externalId?: string,
    surface: ApiSurface = 'v1',
): TimelineSubtitleDescriptor {
    const codec = track.codec ?? '';
    const normalized = codec.toLowerCase();
    const bitmap = PGS.includes(normalized) || VOBSUB.includes(normalized);
    const path = apiUrl(
        surface,
        externalId
            ? `/playback/${itemId}/subtitles/external/${externalId}`
            : `/playback/${itemId}/subtitles/${track.index}`,
    );
    const href = (format: string) => buildTimelineHref(path, { fileId, format });
    return {
        id: externalId ?? `${fileId}:${track.index}`,
        index: track.index,
        kind: externalId ? 'external' : 'embedded',
        codec,
        language: track.language,
        ...(track.title ? { title: track.title } : {}),
        default: track.default,
        forced: track.forced,
        format: bitmap ? 'bitmap' : 'text',
        // Bitmap sidecars are not supported by the current REST resolver. Do not
        // advertise extraction/rendering hrefs that would fail.
        hrefs:
            bitmap && externalId
                ? {}
                : bitmap
                  ? {
                        raw: href(VOBSUB.includes(normalized) ? 'sub' : 'pgssub'),
                        rendered: buildTimelineHref(`${path}/rendered`, { fileId }),
                    }
                  : {
                        text: href('vtt'),
                        raw: href(
                            ['ass', 'ssa'].includes(normalized)
                                ? normalized
                                : ['vtt', 'webvtt'].includes(normalized)
                                  ? 'vtt'
                                  : 'srt',
                        ),
                    },
    };
}

/** Package 8 embeds this object in start's delivery.timeline. */
export function buildTimelineDelivery(
    itemId: string,
    fileId: string,
    embedded: readonly EmbeddedSubtitle[],
    sidecars: readonly ExternalSubtitle[] = [],
    surface: ApiSurface = 'v1',
): TimelineDelivery {
    // Filter before assigning indices: the synthetic namespace is per selected file.
    const selectedSidecars = sidecars.filter((sidecar) => sidecar.file_id === fileId);
    return {
        href: buildTimelineHref(apiUrl(surface, `/playback/${itemId}/timeline`), { fileId }),
        subtitles: [
            ...embedded.map((track) =>
                buildSubtitleDescriptor(itemId, fileId, track, undefined, surface),
            ),
            ...selectedSidecars.map((sidecar, position) =>
                buildSubtitleDescriptor(
                    itemId,
                    fileId,
                    {
                        index: 1000 + position,
                        codec: sidecar.format,
                        language: sidecar.language,
                        default: false,
                        forced: sidecar.is_forced,
                    },
                    sidecar.id,
                    surface,
                ),
            ),
        ],
    };
}

/** Embedded method comes from the planner; sidecars use a declared raw renderer or WebVTT. */
export function subtitleDeliveryMethod(
    descriptor: TimelineSubtitleDescriptor,
    embeddedMethod: SubtitleMethod | undefined,
    formats: readonly string[],
): SubtitleMethod {
    if (descriptor.kind === 'embedded') return embeddedMethod ?? 'none';
    const supported = supportedSubtitleFormats(formats);
    if (descriptor.hrefs.raw && supported.has(normalizeSubtitleCodec(descriptor.codec)))
        return 'client_render';
    if (descriptor.hrefs.text && supported.has('vtt')) return 'external_vtt';
    return 'none';
}
