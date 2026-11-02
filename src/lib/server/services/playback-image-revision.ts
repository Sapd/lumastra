// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { getTrickplayRevision } from './trickplay-storage.service.js';

export async function getChapterImageRevision(
    fileId: string,
    startTicks: number,
    width: number,
    mediaFilePath?: string | null,
): Promise<string | null> {
    const revision = await getTrickplayRevision(fileId, width, mediaFilePath);
    return computeChapterImageRevision(fileId, startTicks, width, revision);
}

export function matchesImageEtag(header: string | null, etag: string): boolean {
    return (
        header
            ?.split(',')
            .some((value) => value.trim().replace(/^W\//, '') === etag || value.trim() === '*') ??
        false
    );
}

/** Hash a chapter using the manifest revision already resolved for this request. */
export function computeChapterImageRevision(
    fileId: string,
    startTicks: number,
    width: number,
    baseRevision: string | null,
): string | null {
    return baseRevision
        ? createHash('sha256')
              .update(`${fileId}:${startTicks}:${width}:${baseRevision}`)
              .digest('hex')
        : null;
}

export function revisionCacheControl(requested: string | null, current: string | null): string {
    return current && requested === current ? 'public, max-age=31536000, immutable' : 'no-cache';
}
