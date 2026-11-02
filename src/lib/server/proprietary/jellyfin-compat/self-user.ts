// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The `userId` a Jellyfin route takes (query or path) for "act on this user".
 * /j routes only ever act for the signed-in user, so the id either names that
 * user or the request is refused. Jellyfin ids are dashless hex; Lumastra's are
 * dashed UUIDs, so both forms compare equal.
 */

function normalize(id: string): string {
    return id.replace(/-/g, '').toLowerCase();
}

/** True when `requested` is present and names someone other than `selfId`. */
export function isOtherUser(requested: string | null | undefined, selfId: string): boolean {
    if (!requested) return false;
    return normalize(requested) !== normalize(selfId);
}
