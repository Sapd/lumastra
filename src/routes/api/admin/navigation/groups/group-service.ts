// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { NAV_GROUP_MAX_LENGTH } from '$lib/schemas/api-admin-navigation';

/**
 * Invisible "filler" letters (Hangul/halfwidth): category Lo, so they pass
 * letter checks and aren't caught by `\p{C}` or whitespace checks, yet render
 * blank — a group named with them would be a permanent dead chip.
 */
const NAV_GROUP_FILLER_CODEPOINTS = new Set([0x115f, 0x1160, 0x3164, 0xffa0]);

/**
 * A group name is unsafe / "dead" when it renders blank, never matches the
 * lowercase auth-header comparison, or smuggles invisible content. Rejected:
 *  - `\p{C}` — control (Cc), format (Cf: soft-hyphen U+00AD, ZWSP/ZWNJ/ZWJ
 *    U+200B–U+200D, word-joiner U+2060, BOM U+FEFF, the Unicode tag block
 *    U+E0000–U+E007F), surrogate (Cs), private-use (Co), unassigned (Cn)
 *  - any whitespace that isn't a plain ASCII space (`[^\S ]` catches NBSP, the
 *    other Unicode spaces, and line/paragraph separators); a single U+0020
 *    inside a name is allowed, nothing else is
 *  - the invisible filler letters above
 *
 * Built from property/ASCII escapes + a codepoint Set so the source contains no
 * literal invisible characters (and trips no `no-control-regex` ESLint rule).
 */
export function hasUnsafeGroupChars(name: string): boolean {
    if (/\p{C}/u.test(name)) return true;
    if (/[^\S ]/u.test(name)) return true;
    for (const ch of name) {
        const cp = ch.codePointAt(0);
        if (cp !== undefined && NAV_GROUP_FILLER_CODEPOINTS.has(cp)) return true;
    }
    return false;
}

/**
 * Upper bound on the number of explicit NAVIGATION_AVAILABLE_GROUPS entries.
 * Caps unbounded growth of the persisted config array (settings.json is read
 * back into memory on every reload) from repeated/abusive add calls.
 */
export const NAV_GROUP_MAX_COUNT = 250;

/** NFC-normalize and trim. Use identical logic on client + server so dedupe agrees. */
export function normalizeGroupName(raw: string): string {
    return raw.normalize('NFC').trim();
}

export type AddGroupDecision =
    | { kind: 'add'; group: string; updated: string[] }
    | { kind: 'noop' }
    | { kind: 'invalid' }
    | { kind: 'limit' }
    | { kind: 'env_locked' };

export interface AddGroupInput {
    raw: string;
    /** Current persisted NAVIGATION_AVAILABLE_GROUPS value (original casing). */
    currentNavGroups: string[];
    /** Full merged selectable list (admin + watch + nav), original casing. */
    mergedGroups: string[];
    /** True when NAVIGATION_AVAILABLE_GROUPS is locked by an env var. */
    envLocked: boolean;
}

export function computeAddGroup(input: AddGroupInput): AddGroupDecision {
    if (input.envLocked) return { kind: 'env_locked' };

    const group = normalizeGroupName(input.raw);
    if (group.length === 0 || group.length > NAV_GROUP_MAX_LENGTH || hasUnsafeGroupChars(group)) {
        return { kind: 'invalid' };
    }

    // Dedupe against the explicit NAVIGATION_AVAILABLE_GROUPS only (case-insensitive).
    // A name that exists solely in admin/watch groups is still appended for durability.
    const navLower = new Set(input.currentNavGroups.map((g) => g.toLowerCase()));
    if (navLower.has(group.toLowerCase())) return { kind: 'noop' };

    // Cap total explicit groups (a duplicate no-op above is always allowed, even at the cap).
    if (input.currentNavGroups.length >= NAV_GROUP_MAX_COUNT) return { kind: 'limit' };

    const updated = [...input.currentNavGroups, group];
    return { kind: 'add', group, updated };
}
