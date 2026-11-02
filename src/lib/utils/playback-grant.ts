// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { apiPost } from '$lib/api/client.js';
import {
    PlaybackStartResponseSchema,
    type PlaybackStartResponse,
} from '$lib/schemas/playback-start.js';

/** Update only the credential in server-provided delivery hrefs. */
export function rotateDeliveryGrant(
    start: Pick<PlaybackStartResponse, 'grant' | 'delivery'>,
    token: string,
): void {
    const rotate = (href: string): string => {
        if (!href.startsWith('/api/')) return href;
        const url = new URL(href, 'https://playback.invalid');
        if (!url.searchParams.has('grant')) return href;
        url.searchParams.set('grant', token);
        return url.pathname + url.search + url.hash;
    };
    const d = start.delivery;
    if ('url' in d) d.url = rotate(d.url);
    if (d.kind === 'multipart-audio') {
        d.tracks.forEach((t) => {
            t.url = rotate(t.url);
            if (t.remuxUrl) t.remuxUrl = rotate(t.remuxUrl);
        });
    }
    if ('subtitles' in d)
        d.subtitles?.forEach((track) => {
            if (track.hrefs.text) track.hrefs.text = rotate(track.hrefs.text);
            if (track.hrefs.raw) track.hrefs.raw = rotate(track.hrefs.raw);
            if (track.hrefs.rendered) track.hrefs.rendered = rotate(track.hrefs.rendered);
        });
    if ('trickplay' in d && d.trickplay) d.trickplay.href = rotate(d.trickplay.href);
    if ('timeline' in d && d.timeline) d.timeline.href = rotate(d.timeline.href);
}

/** Returns a disposer; stale renew responses cannot revive a stopped player. */
export function maintainPlaybackGrant(
    start: Pick<PlaybackStartResponse, 'grant' | 'delivery'>,
    onRenew: () => void | Promise<void> = () => {},
): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = (delay: number): void => {
        timer = setTimeout(
            () => {
                void renew();
            },
            Math.min(Math.max(1000, delay), 2_147_483_647),
        );
    };
    const renew = async (): Promise<void> => {
        try {
            const result = await apiPost(
                start.grant.renewHref,
                PlaybackStartResponseSchema.shape.grant,
                { token: start.grant.token },
            );
            if (stopped) return;
            if ([401, 403, 404, 410].includes(result.status)) return;
            if (result.data) {
                start.grant = result.data;
                rotateDeliveryGrant(start, result.data.token);
                await onRenew();
            }
            if (!stopped)
                schedule(result.data ? Date.parse(start.grant.renewAfter) - Date.now() : 30_000);
        } catch {
            if (!stopped) schedule(30_000);
        }
    };
    if (Date.parse(start.grant.expiresAt) > Date.now())
        schedule(Date.parse(start.grant.renewAfter) - Date.now());
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
