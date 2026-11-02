// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser';
import { validatePlayToken } from './play-token';

/**
 * The media_files id a `mediaSourceId` names. PlaybackInfo's own URLs carry
 * the raw file id; a client that builds a URL from `MediaSource.Id` sends the
 * file token PlaybackInfo issued there. Both are UUIDs, so the token is looked
 * up first. Null when it is neither.
 */
export async function resolveMediaSourceFileId(
    raw: string | null | undefined,
): Promise<string | null> {
    const value = raw?.trim();
    if (!value) return null;
    const token = await validatePlayToken(value);
    if (token?.fileId) return token.fileId;
    return isUuid(value) ? normalizeUuid(value) : null;
}
