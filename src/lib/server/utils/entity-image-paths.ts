// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `/api/v1/<area>/<id>/images/**` paths whose def may answer WITHOUT a
 * credential (artwork by unguessable id, optional `?sig=`). The hooks backstop
 * and forward-auth let these through to the def.
 *
 * User images are NOT in this set: an avatar and anything derived from a
 * user's name needs a real principal, so `/api/v1/users/{id}/images/**` takes
 * the ordinary bearer/session path and is refused with 401 when there is none.
 */
export function isAnonymousEntityImagePath(path: string): boolean {
    if (!path.startsWith('/api/v1/') || !path.includes('/images/')) return false;
    return !path.startsWith('/api/v1/users/');
}
