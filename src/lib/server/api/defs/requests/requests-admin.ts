// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * May this caller act on every user's media requests (list `scope=all`, read
 * or filter other users' requests)? An admin principal, or a token carrying
 * the `requests:admin` scope.
 *
 * Decided on the PRINCIPAL only, the way enforce({kind:'admin'}) decides.
 * `locals.user.isAdmin` is the owner's live admin status and ignores the
 * credential: an admin's device token or read-only PAT has it true while its
 * principal is non-admin. Every resolveAuth branch sets a principal, so none
 * means no admin rights.
 *
 * Replaces `principal?.scopes?.includes('requests:admin') ?? locals.user?.isAdmin`,
 * which fell back to the owner's admin flag whenever no principal was set.
 * (Admin sessions and admin-scoped tokens hold `requests:admin` through
 * expandScopes(); `principal.isAdmin` is checked too so the answer can never
 * be narrower than enforce({kind:'admin'}).)
 */
export function hasRequestsAdmin(locals: App.Locals): boolean {
    const principal = locals.principal;
    if (!principal) return false;
    return principal.isAdmin === true || principal.scopes?.includes('requests:admin') === true;
}
