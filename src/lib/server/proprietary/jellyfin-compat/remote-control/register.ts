// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Wire `/j/socket` into the AGPL upgrade dispatcher. Called from the
 * proprietary init (`proprietary/licensing/init.ts`), so the AGPL core never
 * imports this tree.
 */

import { registerUpgradeHandler } from '$lib/server/utils/http-upgrade.js';
import { registerExternalRemoteTargetProvider } from '$lib/server/services/external-remote-targets.js';
import { ensureFanoutSubscription } from './fanout';
import { jellyfinRemoteTargets } from './jellyfin-targets';
import { handleJellyfinSocketUpgrade, isJellyfinSocketPath } from './socket-hub';

export function registerJellyfinRemoteControl(): void {
    registerUpgradeHandler('jellyfin-socket', isJellyfinSocketPath, handleJellyfinSocketUpgrade);
    // Subscribe up front: a command for a socket on THIS replica may be
    // published by another one before any socket connects here.
    void ensureFanoutSubscription();
    // The user's Jellyfin clients as targets of the core device API (`jf:<id>`).
    registerExternalRemoteTargetProvider(jellyfinRemoteTargets);
}
