// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { UserContext } from '$lib/server/types';

type Viewer = Pick<UserContext, 'userId' | 'ownerIsAdmin'>;

/** Can `viewer` see / control sessions owned by `ownerUserId`? (own, or admin) */
export function canControl(viewer: Viewer, ownerUserId: string): boolean {
    return viewer.ownerIsAdmin || ownerUserId.toLowerCase() === String(viewer.userId).toLowerCase();
}
