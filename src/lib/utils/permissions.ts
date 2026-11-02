// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Derives whether the current user has admin/moderator access by comparing
 * their groups against the configured admin groups from page data.
 *
 * This is used in components that need to determine admin status client-side,
 * e.g. to show admin controls in the watch page or modal overlays.
 */
export function deriveIsAdmin(pageData: {
    user?: { userGroups?: string[] };
    adminGroups?: string[];
}): boolean {
    const groups = (pageData?.user?.userGroups ?? []).map((g: string) => g.toLowerCase().trim());
    const adminGroups = (pageData?.adminGroups ?? []).map((g: string) => g.toLowerCase().trim());
    return groups.some((g) => adminGroups.includes(g));
}
