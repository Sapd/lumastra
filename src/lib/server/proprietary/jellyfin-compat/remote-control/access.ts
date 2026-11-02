// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { UserContext } from '$lib/server/types';

type Viewer = Pick<UserContext, 'userId' | 'ownerIsAdmin'>;

/** Can `viewer` see / control sessions owned by `ownerUserId`? (own, or admin) */
export function canControl(viewer: Viewer, ownerUserId: string): boolean {
    return viewer.ownerIsAdmin || ownerUserId.toLowerCase() === String(viewer.userId).toLowerCase();
}
