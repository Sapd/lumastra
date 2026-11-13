// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET|HEAD /Videos/{itemId}/stream.{container} — Jellyfin's
 * `GetVideoStreamByContainer`: `/stream` with the container in the path.
 *
 * Everything (play-token branches, kick cooldown, access check, silent-start
 * disarm, `static=true` direct play, progressive transcode) is the `/stream`
 * route's; this only moves the path container into the `container` query
 * param that route reads. The path wins over a query `container`, as in
 * Jellyfin, where only the route value binds. HEAD falls back to GET
 * (SvelteKit), like `/stream`.
 */

import type { RequestHandler } from './$types';
import { GET as streamGet } from '../stream/+server';

/** Jellyfin's `EncodingHelper.ContainerValidationRegex`. */
const CONTAINER_RE = /^[a-zA-Z0-9\-._,|]{1,40}$/;

export const GET: RequestHandler = async (event) => {
    const container = event.params.container;
    if (!CONTAINER_RE.test(container)) {
        return new Response('Invalid container', { status: 400 });
    }
    for (const key of [...event.url.searchParams.keys()]) {
        if (key.toLowerCase() === 'container') event.url.searchParams.delete(key);
    }
    event.url.searchParams.set('container', container);
    return streamGet(event as unknown as Parameters<typeof streamGet>[0]);
};
