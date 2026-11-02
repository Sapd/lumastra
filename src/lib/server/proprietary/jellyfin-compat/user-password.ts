// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * POST /Users/Password and the legacy /Users/{userId}/Password (Jellyfin
 * UserController.UpdateUserPassword): always refused with Jellyfin's 403.
 *
 * Lumastra's account model does not allow it, for any kind of account:
 * - The password a Jellyfin app signs in with is not the account password. It
 *   is a per-user app PIN Lumastra generates (jellyfin-compat/auth.ts), never
 *   user-chosen, so the settings page can show it again and it is never a
 *   password reused elsewhere. An app-chosen `NewPw` would break both.
 * - Changing the real account password from here is worse: the only proof the
 *   app can offer as `CurrentPw` is that app PIN, so a leaked PIN would become
 *   a takeover of the whole account. SSO and forward-auth users have no local
 *   password at all.
 * - `ResetPassword: true` (reset to empty in Jellyfin) has no meaning here.
 *
 * The app PIN is reset in Lumastra's settings (Jellyfin apps), the account
 * password on the Account page. A request for another user gets Jellyfin's
 * "not allowed" message instead; neither answer depends on whether that user
 * exists.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getParam } from './utils';
import { isOtherUser } from './self-user';

export function handleUpdatePassword(event: RequestEvent): Response {
    const requested = event.params.userId ?? getParam(event.url, 'UserId');
    if (isOtherUser(requested, event.locals.user.userId)) {
        return ApiResponses.forbidden('User is not allowed to update the password.');
    }
    return ApiResponses.forbidden(
        'Passwords cannot be changed from an app. Reset the app password in Lumastra under Settings.',
    );
}
