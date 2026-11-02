// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Attention items an admin cannot acknowledge or snooze.
 *
 * Shared by the server (the ack/snooze service refuses them) and the client
 * (the row hides the two buttons), so the two can never disagree.
 *
 * Keep security and pending plugin lifecycle notices visible until their cause
 * is gone. Plugin intent is persisted in external_plugins; only the affected
 * process can tell whether its loaded code has caught up with that intent.
 */

export const LUMASTRA_SECURITY_UPDATE_ATTENTION_ID = 'lumastra-update:security';

export const PLUGIN_RESTART_ATTENTION_ID = 'settings:plugin-restart';

const PERSISTENT_IDS: ReadonlySet<string> = new Set([
    LUMASTRA_SECURITY_UPDATE_ATTENTION_ID,
    PLUGIN_RESTART_ATTENTION_ID,
]);

export function isPersistentAttentionId(id: string): boolean {
    return PERSISTENT_IDS.has(id);
}
