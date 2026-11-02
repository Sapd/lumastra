// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin's 400. `ApiResponses.badRequest` answers 422 (Lumastra's problem
 * taxonomy has no 400), but Jellyfin apps branch on the status and Jellyfin
 * answers a missing or malformed parameter with 400 and an RFC 7807 body.
 */
export function jellyfinBadRequest(title: string): Response {
    return new Response(JSON.stringify({ title, status: 400 }), {
        status: 400,
        headers: { 'Content-Type': 'application/problem+json' },
    });
}
