// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { setIfNotExists } from '$lib/server/cache/valkey.js';

interface JellyfinPatDeniedNotice {
    userId: string;
    tokenId: number;
}

/** Caller must fire-and-forget with error logging, keeping the 403 path independent. */
export async function notifyJellyfinPatDenied(opts: JellyfinPatDeniedNotice): Promise<void> {
    const claimed = await setIfNotExists(
        `v1:jf:pat-deny-notice:${opts.tokenId}`,
        '1',
        24 * 60 * 60,
    );
    // Without Valkey, claiming returns false and the notice is a silent no-op.
    if (!claimed) return;
    // Delivery failure still burns the 24-hour claim, avoiding a retry storm.
    const { publishUserEvent } = await import('./notification-events.service.js');
    await publishUserEvent({
        userId: opts.userId,
        kind: 'jellyfin.readonly_token',
        // No settings target exists in the inbox link contract; keep this notice link-free.
        data: {},
    });
}
