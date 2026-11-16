// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Binds a user's download permission (canDownload, with the master switch) as
 * the /j request context for the duration of `fn`. The serializers read that
 * context for CanDownload and Policy.EnableContentDownloading, so a DTO that
 * describes user X must run inside X's context, not the caller's.
 *
 * Fails closed: a lookup error denies downloads and is logged; it never fails
 * the request.
 */

import { canDownload } from '$lib/server/services/download-access.service.js';
import { Logger } from '$lib/server/utils/logger';
import { runWithJellyfinRequestContext } from './request-context';

const logger = Logger.for('JellyfinCompat:DownloadPermission');

export interface DownloadSubject {
    userId?: string;
    username?: string;
    isAdmin?: boolean;
}

export async function withDownloadPermissionFor<T>(
    subject: DownloadSubject | null | undefined,
    fn: () => T,
): Promise<T> {
    const allowed = await canDownload(subject ?? null).catch((error: unknown) => {
        logger.error(
            'Jellyfin compat: download permission lookup failed; denying',
            error as Error,
            {
                userId: subject?.userId,
            },
        );
        return false;
    });
    return runWithJellyfinRequestContext({ canDownload: allowed }, fn);
}
