// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { capture, request, BASE, excerpt } from './common';
import { mediaReferences, mediaUrls } from './semantic';

/**
 * Live checks on one response body: media ids still resolve, advertised artwork / m3u8 URLs
 * answer 2xx/3xx. Capture stores the problems it already sees as the endpoint's baseline, so
 * compare reports a problem that existed before a package landed as KNOWN, not BROKEN.
 */
export async function liveChecks(
    file: string,
    body: unknown,
    token: string,
    resolved: Map<string, number>,
): Promise<string[]> {
    const problems: string[] = [];
    for (const id of mediaReferences(body)) {
        const path = /^(?:music-|track)/.test(file)
            ? `/api/v1/music/tracks/${id}`
            : `/api/v1/media/${id}`;
        let status = resolved.get(path);
        if (status === undefined) {
            status = (await capture(path, token)).status;
            resolved.set(path, status);
        }
        if (status < 200 || status >= 300)
            problems.push(`Media id ${id} no longer resolves: ${status}`);
    }
    for (const url of mediaUrls(body, BASE)) {
        let response = await request(url, token, { method: 'HEAD' });
        if (response.status === 405 || response.status === 501) {
            await response.body?.cancel();
            response = await request(url, token, { headers: { Range: 'bytes=0-4095' } });
        }
        await response.body?.cancel();
        if (response.status < 200 || response.status >= 400)
            problems.push(`URL ${excerpt(url)}: ${response.status}`);
    }
    return problems;
}
