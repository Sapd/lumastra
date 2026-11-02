// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getPublicSystemInfo } from '$lib/server/proprietary/jellyfin-compat/serializers/system';
import type { JellyfinSystemInfo } from '$lib/server/proprietary/jellyfin-compat/types';

/** Node's `process.arch` as Jellyfin's Architecture enum name. */
function systemArchitecture(): string {
    switch (process.arch) {
        case 'arm64':
            return 'Arm64';
        case 'arm':
            return 'Arm';
        case 'ia32':
            return 'X86';
        case 's390x':
            return 'S390x';
        case 'ppc64':
            return 'Ppc64le';
        default:
            return 'X64';
    }
}

export const GET: RequestHandler = withJellyfinAuth(async ({ url }) => {
    return json({
        ...getPublicSystemInfo(url.origin),
        OperatingSystemDisplayName: 'Linux',
        SystemArchitecture: systemArchitecture(),
        HasUpdateAvailable: false,
        // No Google Cast receiver: apps hide their cast button for an empty list.
        CastReceiverApplications: [],
        SupportsLibraryMonitor: true,
        CanSelfRestart: false,
        CanLaunchWebBrowser: false,
        HasPendingRestart: false,
        IsShuttingDown: false,
        // Jellyfin reports its HTTP port here (the WebSocket shares it); ours is the
        // port the client reached us on. Clients connect via their server URL, so
        // this is informational — but it must be present.
        WebSocketPortNumber: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    } satisfies JellyfinSystemInfo);
});
