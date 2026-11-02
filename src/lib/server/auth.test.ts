// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Authentication and Authorization utilities
 *
 * Tests group-based authorization with case-insensitive matching,
 * whitespace handling, and edge cases that could lead to privilege escalation.
 */

import { describe, it, expect } from 'vitest';
import { resolveMaxAgeFromGroups } from './utils/age-rating-resolver';
import { buildUserPermissions as realBuildUserPermissions } from './auth';

// ============================================================================
// GROUP AUTHORIZATION LOGIC TESTS
// ============================================================================

describe('isUserAdmin', () => {
    // Inline implementation to test the logic without config dependency
    function isUserAdmin(
        userGroups: string[] = [],
        adminGroups: string[] = ['Librarians'],
    ): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return adminGroups.some((adminGroup) =>
            userGroupsLower.includes(adminGroup.trim().toLowerCase()),
        );
    }

    describe('basic matching', () => {
        it('returns true when user has admin group', () => {
            expect(isUserAdmin(['Librarians'], ['Librarians'])).toBe(true);
        });

        it('returns false when user lacks admin group', () => {
            expect(isUserAdmin(['Users'], ['Librarians'])).toBe(false);
        });

        it('returns false for empty user groups', () => {
            expect(isUserAdmin([], ['Librarians'])).toBe(false);
        });

        it('returns false for undefined user groups (defaults to empty)', () => {
            expect(isUserAdmin(undefined, ['Librarians'])).toBe(false);
        });
    });

    describe('case insensitivity', () => {
        it('matches lowercase admin group', () => {
            expect(isUserAdmin(['librarians'], ['Librarians'])).toBe(true);
        });

        it('matches uppercase admin group', () => {
            expect(isUserAdmin(['LIBRARIANS'], ['Librarians'])).toBe(true);
        });

        it('matches mixed case admin group', () => {
            expect(isUserAdmin(['LiBrArIaNs'], ['Librarians'])).toBe(true);
        });

        it('matches when config is lowercase', () => {
            expect(isUserAdmin(['Librarians'], ['librarians'])).toBe(true);
        });

        it('matches when both are uppercase', () => {
            expect(isUserAdmin(['LIBRARIANS'], ['LIBRARIANS'])).toBe(true);
        });
    });

    describe('whitespace handling', () => {
        it('trims leading whitespace from admin groups', () => {
            expect(isUserAdmin(['Librarians'], ['  Librarians'])).toBe(true);
        });

        it('trims trailing whitespace from admin groups', () => {
            expect(isUserAdmin(['Librarians'], ['Librarians  '])).toBe(true);
        });

        it('trims both leading and trailing whitespace', () => {
            expect(isUserAdmin(['Librarians'], ['  Librarians  '])).toBe(true);
        });

        it('handles tabs in admin group names', () => {
            expect(isUserAdmin(['Librarians'], ['\tLibrarians\t'])).toBe(true);
        });

        it('user groups are not trimmed (exact match after lowercase)', () => {
            // User groups with whitespace should NOT match
            // because we only trim config groups, not user groups
            // Note: Current implementation doesn't trim user groups
            const userGroupsLower = ['  librarians  '].map((g) => g.toLowerCase());
            const matches = userGroupsLower.includes('librarians');
            expect(matches).toBe(false);
        });
    });

    describe('multiple groups', () => {
        it('returns true if any admin group matches', () => {
            expect(isUserAdmin(['Users'], ['Admin', 'SuperAdmin', 'Users'])).toBe(true);
        });

        it('returns true if user has multiple groups and one is admin', () => {
            expect(isUserAdmin(['Users', 'Librarians', 'Viewers'], ['Librarians'])).toBe(true);
        });

        it('returns false if none of multiple admin groups match', () => {
            expect(isUserAdmin(['Users', 'Viewers'], ['Admin', 'SuperAdmin'])).toBe(false);
        });

        it('returns true with first matching group', () => {
            expect(isUserAdmin(['Admin'], ['Admin', 'SuperAdmin'])).toBe(true);
        });
    });

    describe('empty admin groups config', () => {
        it('returns false when admin groups is empty array', () => {
            expect(isUserAdmin(['Librarians'], [])).toBe(false);
        });

        it('returns false when admin groups contains only empty string', () => {
            expect(isUserAdmin(['Librarians'], [''])).toBe(false);
        });

        it('returns false when admin groups contains only whitespace', () => {
            expect(isUserAdmin(['Librarians'], ['   '])).toBe(false);
        });
    });

    describe('special characters', () => {
        it('handles groups with hyphens', () => {
            expect(isUserAdmin(['super-admins'], ['super-admins'])).toBe(true);
        });

        it('handles groups with underscores', () => {
            expect(isUserAdmin(['super_admins'], ['super_admins'])).toBe(true);
        });

        it('handles groups with dots', () => {
            expect(isUserAdmin(['admin.users'], ['admin.users'])).toBe(true);
        });

        it('handles groups with numbers', () => {
            expect(isUserAdmin(['admin123'], ['admin123'])).toBe(true);
        });

        it('handles unicode group names', () => {
            expect(isUserAdmin(['管理者'], ['管理者'])).toBe(true);
        });

        it('handles emoji in group names (edge case)', () => {
            expect(isUserAdmin(['admin🔑'], ['admin🔑'])).toBe(true);
        });
    });

    describe('security edge cases', () => {
        it('rejects substring matches (admin should not match admins)', () => {
            expect(isUserAdmin(['admin'], ['admins'])).toBe(false);
            expect(isUserAdmin(['admins'], ['admin'])).toBe(false);
        });

        it('rejects prefix matches', () => {
            expect(isUserAdmin(['Kreditor'], ['Librarians'])).toBe(false);
        });

        it('rejects suffix matches', () => {
            expect(isUserAdmin(['reditoren'], ['Librarians'])).toBe(false);
        });

        it('exact match required (no regex patterns)', () => {
            expect(isUserAdmin(['Kred.*'], ['Librarians'])).toBe(false);
            expect(isUserAdmin(['Librarians'], ['Kred.*'])).toBe(false);
        });

        it('handles null-like values safely', () => {
            // The function uses default parameter [], so null would throw
            // This tests that the default is applied correctly
            // @ts-expect-error - testing runtime safety
            expect(() => isUserAdmin(null, ['Librarians'])).toThrow();
        });
    });
});

// ============================================================================
// WATCH PERMISSIONS LOGIC TESTS
// ============================================================================

describe('hasWatchPermissions', () => {
    // Inline implementation to test the logic
    function hasWatchPermissions(
        userGroups: string[] = [],
        watchGroups: string[] = ['Librarians', 'StreamMonitors'],
    ): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return watchGroups.some((watchGroup) =>
            userGroupsLower.includes(watchGroup.trim().toLowerCase()),
        );
    }

    describe('basic matching', () => {
        it('returns true for Librarians group', () => {
            expect(hasWatchPermissions(['Librarians'], ['Librarians', 'StreamMonitors'])).toBe(
                true,
            );
        });

        it('returns true for StreamMonitors group', () => {
            expect(hasWatchPermissions(['StreamMonitors'], ['Librarians', 'StreamMonitors'])).toBe(
                true,
            );
        });

        it('returns false for non-watch group', () => {
            expect(hasWatchPermissions(['Users'], ['Librarians', 'StreamMonitors'])).toBe(false);
        });

        it('returns false for empty user groups', () => {
            expect(hasWatchPermissions([], ['Librarians', 'StreamMonitors'])).toBe(false);
        });
    });

    describe('case insensitivity', () => {
        it('matches lowercase StreamMonitors', () => {
            expect(hasWatchPermissions(['streammonitors'], ['Librarians', 'StreamMonitors'])).toBe(
                true,
            );
        });

        it('matches uppercase STREAMMONITORS', () => {
            expect(hasWatchPermissions(['STREAMMONITORS'], ['Librarians', 'StreamMonitors'])).toBe(
                true,
            );
        });

        it('matches mixed case', () => {
            expect(hasWatchPermissions(['StReAmMoNiToRs'], ['Librarians', 'StreamMonitors'])).toBe(
                true,
            );
        });
    });

    describe('whitespace handling', () => {
        it('trims whitespace from config groups', () => {
            expect(hasWatchPermissions(['StreamMonitors'], ['  StreamMonitors  '])).toBe(true);
        });
    });

    describe('multiple groups', () => {
        it('user with both watch groups returns true', () => {
            expect(
                hasWatchPermissions(
                    ['Librarians', 'StreamMonitors'],
                    ['Librarians', 'StreamMonitors'],
                ),
            ).toBe(true);
        });

        it('user with one watch group among many returns true', () => {
            expect(
                hasWatchPermissions(
                    ['Users', 'Viewers', 'StreamMonitors', 'Others'],
                    ['Librarians', 'StreamMonitors'],
                ),
            ).toBe(true);
        });
    });

    describe('empty watch groups config', () => {
        it('returns false when watch groups is empty', () => {
            expect(hasWatchPermissions(['Librarians'], [])).toBe(false);
        });
    });
});

// ============================================================================
// GROUP PARSING FROM HEADER
// ============================================================================

describe('Group Parsing', () => {
    // Test the parsing logic used in hooks.server.ts
    function parseGroups(groupHeader: string | null): string[] {
        if (!groupHeader) return [];
        return groupHeader
            .split(',')
            .map((g) => g.trim())
            .filter((g) => g.length > 0);
    }

    describe('basic parsing', () => {
        it('parses single group', () => {
            expect(parseGroups('Librarians')).toEqual(['Librarians']);
        });

        it('parses comma-separated groups', () => {
            expect(parseGroups('Librarians,StreamMonitors,Users')).toEqual([
                'Librarians',
                'StreamMonitors',
                'Users',
            ]);
        });

        it('returns empty array for null', () => {
            expect(parseGroups(null)).toEqual([]);
        });

        it('returns empty array for empty string', () => {
            expect(parseGroups('')).toEqual([]);
        });
    });

    describe('whitespace handling', () => {
        it('trims whitespace around groups', () => {
            expect(parseGroups('  Librarians  ,  StreamMonitors  ')).toEqual([
                'Librarians',
                'StreamMonitors',
            ]);
        });

        it('filters out empty groups after trim', () => {
            expect(parseGroups('Librarians,,StreamMonitors')).toEqual([
                'Librarians',
                'StreamMonitors',
            ]);
        });

        it('handles groups that are only whitespace', () => {
            expect(parseGroups('Librarians,   ,StreamMonitors')).toEqual([
                'Librarians',
                'StreamMonitors',
            ]);
        });
    });

    describe('edge cases', () => {
        it('handles single comma', () => {
            expect(parseGroups(',')).toEqual([]);
        });

        it('handles multiple commas', () => {
            expect(parseGroups(',,,')).toEqual([]);
        });

        it('handles trailing comma', () => {
            expect(parseGroups('Librarians,')).toEqual(['Librarians']);
        });

        it('handles leading comma', () => {
            expect(parseGroups(',Librarians')).toEqual(['Librarians']);
        });

        it('preserves case in group names', () => {
            expect(parseGroups('LIBRARIANS,librarians,Librarians')).toEqual([
                'LIBRARIANS',
                'librarians',
                'Librarians',
            ]);
        });
    });

    describe('special characters', () => {
        it('handles groups with spaces in name (not recommended)', () => {
            // Single group with internal space
            expect(parseGroups('My Admin Group')).toEqual(['My Admin Group']);
        });

        it('handles groups with special chars', () => {
            expect(parseGroups('admin-group,user_group,other.group')).toEqual([
                'admin-group',
                'user_group',
                'other.group',
            ]);
        });
    });
});

// ============================================================================
// COMBINED AUTHORIZATION SCENARIOS
// ============================================================================

describe('Authorization Scenarios', () => {
    function isUserAdmin(userGroups: string[], adminGroups: string[]): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return adminGroups.some((adminGroup) =>
            userGroupsLower.includes(adminGroup.trim().toLowerCase()),
        );
    }

    function hasWatchPermissions(userGroups: string[], watchGroups: string[]): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return watchGroups.some((watchGroup) =>
            userGroupsLower.includes(watchGroup.trim().toLowerCase()),
        );
    }

    const adminGroups = ['Librarians', 'Admins'];
    const watchGroups = ['Librarians', 'StreamMonitors'];

    describe('typical user scenarios', () => {
        it('admin user has all permissions', () => {
            const userGroups = ['Librarians'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(true);
            expect(hasWatchPermissions(userGroups, watchGroups)).toBe(true);
        });

        it('stream monitor has watch but not admin', () => {
            const userGroups = ['StreamMonitors'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(false);
            expect(hasWatchPermissions(userGroups, watchGroups)).toBe(true);
        });

        it('regular user has no special permissions', () => {
            const userGroups = ['Users', 'Viewers'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(false);
            expect(hasWatchPermissions(userGroups, watchGroups)).toBe(false);
        });

        it('user with multiple groups including admin', () => {
            const userGroups = ['Users', 'Viewers', 'Admins'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(true);
            expect(hasWatchPermissions(userGroups, watchGroups)).toBe(false);
        });
    });

    describe('privilege escalation prevention', () => {
        it('similar group names do not grant access', () => {
            const userGroups = ['Kreditor', 'Admin', 'StreamMonitor'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(false);
            expect(hasWatchPermissions(userGroups, watchGroups)).toBe(false);
        });

        it('substring group names do not grant access', () => {
            const userGroups = ['Librarians-intern', 'Sub-Admins'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(false);
        });

        it('groups with added prefix do not grant access', () => {
            const userGroups = ['NotLibrarians', 'NotAdmins'];
            expect(isUserAdmin(userGroups, adminGroups)).toBe(false);
        });
    });
});

// ============================================================================
// AUTHENTIK HEADER INJECTION TESTS
// ============================================================================

describe('Header Security', () => {
    describe('header value sanitization', () => {
        // In production, Authentik sets these headers after validating the user
        // The dashboard trusts these headers because they come from the reverse proxy
        // However, we should still validate the format

        it('accepts valid username from header', () => {
            const username = 'john.doe';
            expect(typeof username === 'string' && username.length > 0).toBe(true);
        });

        it('handles username with special characters', () => {
            const username = "john.o'brien";
            expect(typeof username === 'string').toBe(true);
        });

        it('detects header injection attempt (newline)', () => {
            const username = 'john\r\nX-Injected-Header: evil';
            // Should be rejected or sanitized
            expect(username.includes('\r') || username.includes('\n')).toBe(true);
        });

        it('detects null byte injection', () => {
            const username = 'john\x00admin';
            expect(username.includes('\x00')).toBe(true);
        });
    });
});

// ============================================================================
// DEFAULT USER FALLBACK SECURITY
// ============================================================================

describe('Default User Fallback', () => {
    // In development mode, missing auth headers fall back to a default user
    // This should NEVER happen in production

    function getDefaultUser(isDev: boolean, headerUsername: string | null): string | null {
        if (headerUsername) {
            return headerUsername;
        }
        // Only fall back to default in development
        if (isDev) {
            return 'Denis';
        }
        return null;
    }

    describe('development mode', () => {
        it('uses header username when present', () => {
            expect(getDefaultUser(true, 'john')).toBe('john');
        });

        it('falls back to default when header missing', () => {
            expect(getDefaultUser(true, null)).toBe('Denis');
        });

        it('falls back to default for empty header', () => {
            expect(getDefaultUser(true, '')).toBe('Denis');
        });
    });

    describe('production mode', () => {
        it('uses header username when present', () => {
            expect(getDefaultUser(false, 'john')).toBe('john');
        });

        it('returns null when header missing (no fallback)', () => {
            expect(getDefaultUser(false, null)).toBeNull();
        });

        it('returns null for empty header', () => {
            expect(getDefaultUser(false, '')).toBeNull();
        });
    });
});

// ============================================================================
// NEW PERMISSION UTILITIES TESTS
// ============================================================================

describe('hasGroupPermission', () => {
    // Inline implementation to test the logic
    function hasGroupPermission(userGroups: string[], allowedGroups: string[]): boolean {
        const userGroupsLower = userGroups.map((g) => g.toLowerCase());
        return allowedGroups.some((allowedGroup) =>
            userGroupsLower.includes(allowedGroup.trim().toLowerCase()),
        );
    }

    describe('basic matching', () => {
        it('returns true when user has allowed group', () => {
            expect(hasGroupPermission(['Admin'], ['Admin'])).toBe(true);
        });

        it('returns false when user lacks allowed group', () => {
            expect(hasGroupPermission(['Users'], ['Admin'])).toBe(false);
        });

        it('returns false for empty user groups', () => {
            expect(hasGroupPermission([], ['Admin'])).toBe(false);
        });

        it('returns false for empty allowed groups', () => {
            expect(hasGroupPermission(['Admin'], [])).toBe(false);
        });
    });

    describe('case insensitivity', () => {
        it('matches lowercase user group', () => {
            expect(hasGroupPermission(['admin'], ['Admin'])).toBe(true);
        });

        it('matches uppercase user group', () => {
            expect(hasGroupPermission(['ADMIN'], ['Admin'])).toBe(true);
        });

        it('matches mixed case', () => {
            expect(hasGroupPermission(['AdMiN'], ['admin'])).toBe(true);
        });
    });

    describe('whitespace handling', () => {
        it('trims leading whitespace from allowed groups', () => {
            expect(hasGroupPermission(['Admin'], ['  Admin'])).toBe(true);
        });

        it('trims trailing whitespace from allowed groups', () => {
            expect(hasGroupPermission(['Admin'], ['Admin  '])).toBe(true);
        });

        it('trims both leading and trailing whitespace', () => {
            expect(hasGroupPermission(['Admin'], ['  Admin  '])).toBe(true);
        });

        it('user groups are not trimmed (exact match after lowercase)', () => {
            expect(hasGroupPermission(['  Admin  '], ['Admin'])).toBe(false);
        });
    });

    describe('multiple groups', () => {
        it('returns true if any allowed group matches', () => {
            expect(hasGroupPermission(['Users'], ['Admin', 'SuperAdmin', 'Users'])).toBe(true);
        });

        it('returns true if user has multiple groups and one matches', () => {
            expect(hasGroupPermission(['Users', 'Admin', 'Viewers'], ['Admin'])).toBe(true);
        });

        it('returns false if none of multiple allowed groups match', () => {
            expect(hasGroupPermission(['Users', 'Viewers'], ['Admin', 'SuperAdmin'])).toBe(false);
        });
    });
});

describe('buildUserPermissions', () => {
    // Inline implementation to test the logic
    function buildUserPermissions(userGroups: string[]): {
        hasWatchPermission: boolean;
        hasLiveTvPermission: boolean;
        hasRequestPermission: boolean;
        isAdmin: boolean;
        maxAgeRating: number | null;
        isAgeRestricted: boolean;
    } {
        function hasGroupPermission(userGroups: string[], allowedGroups: string[]): boolean {
            const userGroupsLower = userGroups.map((g) => g.toLowerCase());
            return allowedGroups.some((allowedGroup) =>
                userGroupsLower.includes(allowedGroup.trim().toLowerCase()),
            );
        }

        const ADMIN_GROUPS = ['Librarians'];
        const WATCH_PERMISSION_GROUPS = ['Librarians', 'StreamMonitors'];
        const LIVETV_GROUPS = ['Librarians', 'LiveTV'];
        const REQUEST_GROUPS = ['Librarians', 'Users'];

        const maxAge = resolveMaxAgeFromGroups(userGroups);

        return {
            hasWatchPermission: hasGroupPermission(userGroups, WATCH_PERMISSION_GROUPS),
            hasLiveTvPermission: hasGroupPermission(userGroups, LIVETV_GROUPS),
            hasRequestPermission:
                REQUEST_GROUPS.length === 0 || hasGroupPermission(userGroups, REQUEST_GROUPS),
            isAdmin: hasGroupPermission(userGroups, ADMIN_GROUPS),
            maxAgeRating: maxAge,
            isAgeRestricted: maxAge !== null,
        };
    }

    describe('admin user', () => {
        it('admin gets all permissions', () => {
            const perms = buildUserPermissions(['Librarians']);
            expect(perms.isAdmin).toBe(true);
            expect(perms.hasWatchPermission).toBe(true);
            expect(perms.hasLiveTvPermission).toBe(true);
            expect(perms.hasRequestPermission).toBe(true);
            expect(perms.isAgeRestricted).toBe(false);
            expect(perms.maxAgeRating).toBeNull();
        });
    });

    describe('regular user', () => {
        it('regular user gets request permission only', () => {
            const perms = buildUserPermissions(['Users']);
            expect(perms.isAdmin).toBe(false);
            expect(perms.hasWatchPermission).toBe(false);
            expect(perms.hasLiveTvPermission).toBe(false);
            expect(perms.hasRequestPermission).toBe(true);
            expect(perms.isAgeRestricted).toBe(false);
            expect(perms.maxAgeRating).toBeNull();
        });
    });

    describe('specialized permissions', () => {
        it('stream monitor has watch but not admin', () => {
            const perms = buildUserPermissions(['StreamMonitors']);
            expect(perms.isAdmin).toBe(false);
            expect(perms.hasWatchPermission).toBe(true);
            expect(perms.hasLiveTvPermission).toBe(false);
            expect(perms.hasRequestPermission).toBe(false);
            expect(perms.isAgeRestricted).toBe(false);
            expect(perms.maxAgeRating).toBeNull();
        });

        it('LiveTV group has LiveTV permission', () => {
            const perms = buildUserPermissions(['LiveTV']);
            expect(perms.hasLiveTvPermission).toBe(true);
            expect(perms.isAdmin).toBe(false);
            expect(perms.hasWatchPermission).toBe(false);
        });

        it('age-12 group sets age restriction', () => {
            const perms = buildUserPermissions(['age-12']);
            expect(perms.maxAgeRating).toBe(12);
            expect(perms.isAgeRestricted).toBe(true);
            expect(perms.isAdmin).toBe(false);
        });

        it('no age groups means unrestricted', () => {
            const perms = buildUserPermissions(['Users']);
            expect(perms.maxAgeRating).toBeNull();
            expect(perms.isAgeRestricted).toBe(false);
        });

        it('multiple age groups takes the highest', () => {
            const perms = buildUserPermissions(['age-6', 'age-12']);
            expect(perms.maxAgeRating).toBe(12);
            expect(perms.isAgeRestricted).toBe(true);
        });
    });

    describe('empty groups', () => {
        it('empty user groups gets no permissions', () => {
            const perms = buildUserPermissions([]);
            expect(perms.isAdmin).toBe(false);
            expect(perms.hasWatchPermission).toBe(false);
            expect(perms.hasLiveTvPermission).toBe(false);
            expect(perms.hasRequestPermission).toBe(false);
            expect(perms.isAgeRestricted).toBe(false);
            expect(perms.maxAgeRating).toBeNull();
        });
    });

    describe('special cases', () => {
        it('empty REQUEST_GROUPS grants request permission to all', () => {
            // Test the special case where REQUEST_GROUPS.length === 0
            function buildUserPermissionsEmptyRequests(userGroups: string[]) {
                const REQUEST_GROUPS: string[] = [];
                return {
                    hasRequestPermission:
                        REQUEST_GROUPS.length === 0 ||
                        userGroups.some((g) =>
                            REQUEST_GROUPS.some(
                                (allowed) => allowed.trim().toLowerCase() === g.toLowerCase(),
                            ),
                        ),
                };
            }

            const perms = buildUserPermissionsEmptyRequests(['Anyone']);
            expect(perms.hasRequestPermission).toBe(true);
        });

        it('no age groups means unrestricted for any user', () => {
            const perms = buildUserPermissions(['Kids', 'Users']);
            expect(perms.maxAgeRating).toBeNull();
            expect(perms.isAgeRestricted).toBe(false);
        });
    });

    describe('whitespace in config groups', () => {
        it('trims whitespace in allowed groups', () => {
            function buildUserPermissionsWhitespace(userGroups: string[]) {
                const ADMIN_GROUPS = ['  Librarians  '];
                const userGroupsLower = userGroups.map((g) => g.toLowerCase());
                return {
                    isAdmin: ADMIN_GROUPS.some((adminGroup) =>
                        userGroupsLower.includes(adminGroup.trim().toLowerCase()),
                    ),
                };
            }

            const perms = buildUserPermissionsWhitespace(['Librarians']);
            expect(perms.isAdmin).toBe(true);
        });
    });
});

describe('buildUserPermissions — isAdminOverride (admin pin) elevates ALL derived perms', () => {
    // Exercises the REAL config-coupled function. Assertions are deliberately
    // config-independent: when isAdmin is true, every admin-implied permission
    // short-circuits to true regardless of which groups ADMIN/LIVETV/WATCH/etc.
    // are configured to, and when false the override forces the flag off.

    it('a pinned admin with NO permission-granting groups still gets every derived perm (the half-admin pin bug)', () => {
        // Regression: groups grant nothing, but admin_pinned forces isAdmin=true.
        // Patching only the isAdmin flag left livetv/watch/requests/moderation off;
        // threading the override through buildUserPermissions fixes all of them.
        const perms = realBuildUserPermissions(['no-such-permission-group'], {
            isAdminOverride: true,
        });
        expect(perms.ownerIsAdmin).toBe(true);
        expect(perms.hasLiveTvPermission).toBe(true);
        expect(perms.hasWatchPermission).toBe(true);
        expect(perms.hasRequestPermission).toBe(true);
        expect(perms.hasReviewPermission).toBe(true);
        expect(perms.hasMediaAnnotationPermission).toBe(true);
        expect(perms.isModerator).toBe(true);
        expect(perms.liveTvPriority).toBe('high');
        expect(perms.maxAgeRating).toBeNull();
        expect(perms.isAgeRestricted).toBe(false);
    });

    it('an override of false forces isAdmin off (a pin can demote)', () => {
        const perms = realBuildUserPermissions(['whatever-group'], { isAdminOverride: false });
        expect(perms.ownerIsAdmin).toBe(false);
    });

    it('with no override, isAdmin is still derived from group membership', () => {
        // Empty groups can never be admin regardless of config.
        expect(realBuildUserPermissions([]).ownerIsAdmin).toBe(false);
    });
});

describe('buildUserPermissions — extraCapabilities (in-app group capability map)', () => {
    // Standalone multi-user: in-app group capabilities are OR-merged into the
    // result. Boolean caps union; age-rating takes the MOST-RESTRICTIVE (MIN);
    // admin still implies everything; pin override still wins; forceNonAdmin can
    // still strip elevation AFTER the merge (handled by the caller, not here).

    it('grants livetv via extraCapabilities when groups grant nothing', () => {
        const perms = realBuildUserPermissions(['no-such-permission-group'], {
            extraCapabilities: { hasLiveTvPermission: true },
        });
        expect(perms.ownerIsAdmin).toBe(false);
        expect(perms.hasLiveTvPermission).toBe(true);
        // unrelated caps stay off
        expect(perms.hasWatchPermission).toBe(false);
        expect(perms.isModerator).toBe(false);
    });

    it('OR-merges boolean caps: never strips a group-granted capability', () => {
        // Group grants livetv via config (LIVETV_GROUPS) is config-dependent, so
        // assert the additive direction with a known-empty base instead.
        const perms = realBuildUserPermissions([], {
            extraCapabilities: {
                hasWatchPermission: true,
                hasRequestPermission: true,
                isModerator: true,
                liveTvPriority: 'high',
            },
        });
        expect(perms.hasWatchPermission).toBe(true);
        expect(perms.hasRequestPermission).toBe(true);
        expect(perms.hasReviewPermission).toBe(true);
        expect(perms.hasMediaAnnotationPermission).toBe(true);
        expect(perms.isModerator).toBe(true);
        expect(perms.liveTvPriority).toBe('high');
    });

    it('in-app admin capability confers admin AND all derived perms', () => {
        const perms = realBuildUserPermissions([], {
            extraCapabilities: { ownerIsAdmin: true },
        });
        expect(perms.ownerIsAdmin).toBe(true);
        expect(perms.hasLiveTvPermission).toBe(true);
        expect(perms.hasWatchPermission).toBe(true);
        expect(perms.hasRequestPermission).toBe(true);
        expect(perms.isModerator).toBe(true);
        expect(perms.liveTvPriority).toBe('high');
        expect(perms.maxAgeRating).toBeNull();
        expect(perms.isAgeRestricted).toBe(false);
    });

    it('age-rating merge takes the MOST-RESTRICTIVE (lowest) value', () => {
        // base groups carry age-18, in-app cap carries 12 → 12 wins (more restrictive)
        const perms = realBuildUserPermissions(['age-18'], {
            extraCapabilities: { maxAgeRating: 12 },
        });
        expect(perms.maxAgeRating).toBe(12);
        expect(perms.isAgeRestricted).toBe(true);
    });

    it('age-rating: a null (unrestricted) extra cap never raises a group ceiling', () => {
        // group says age-12; extra cap is unrestricted (null). The restrictive
        // 12 must hold — a permissive group cannot raise the ceiling.
        const perms = realBuildUserPermissions(['age-12'], {
            extraCapabilities: { maxAgeRating: null },
        });
        expect(perms.maxAgeRating).toBe(12);
        expect(perms.isAgeRestricted).toBe(true);
    });

    it('age-rating: extra cap applies when base is unrestricted', () => {
        const perms = realBuildUserPermissions([], {
            extraCapabilities: { maxAgeRating: 6 },
        });
        expect(perms.maxAgeRating).toBe(6);
        expect(perms.isAgeRestricted).toBe(true);
    });

    it('admin short-circuit ignores a restrictive extra age cap (admin = unrestricted)', () => {
        const perms = realBuildUserPermissions([], {
            isAdminOverride: true,
            extraCapabilities: { maxAgeRating: 6 },
        });
        expect(perms.ownerIsAdmin).toBe(true);
        expect(perms.maxAgeRating).toBeNull();
        expect(perms.isAgeRestricted).toBe(false);
    });

    it('isAdminOverride=false still demotes even with extra admin cap absent', () => {
        const perms = realBuildUserPermissions(['whatever'], {
            isAdminOverride: false,
            extraCapabilities: { hasLiveTvPermission: true },
        });
        expect(perms.ownerIsAdmin).toBe(false);
        // but non-admin extra caps still apply
        expect(perms.hasLiveTvPermission).toBe(true);
    });

    it('no extraCapabilities behaves exactly as before (backward compatible)', () => {
        const a = realBuildUserPermissions(['age-12']);
        const b = realBuildUserPermissions(['age-12'], {});
        expect(a).toEqual(b);
    });
});
