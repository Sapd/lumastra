// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixed candidate mount roots for container deployments.
 *
 * Shared by two admin-only surfaces that both need "the well-known places
 * media lives in a container", never derived from request input:
 *   - `GET /api/setup/library-mounts` (first-run wizard suggestions)
 *   - `GET /api/admin/library/browse` (folder picker root confinement)
 *
 * Kept in one place so the two surfaces can never drift on what counts as a
 * safe root to enumerate.
 */
export const LIBRARY_MOUNT_ROOTS: readonly string[] = [
    '/data',
    '/media',
    '/mnt',
    '/srv',
    '/music',
    '/movies',
    '/series',
    '/tv',
];
