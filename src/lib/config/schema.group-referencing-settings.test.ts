// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { configSchema, getGroupReferencingSettings } from './schema';

// The exact tag set chosen for the Access page's "Group-based rules" audit panel.
// Settings here are ones whose VALUE is itself a group name / list of group names
// controlling access to a feature. Keep this list in sync with schema.ts —
// when it drifts, the test below documents WHY each key was included or excluded.
const EXPECTED_TAGGED_KEYS = [
    'MODERATOR_GROUPS',
    'MEDIA_ANNOTATION_GROUPS',
    'SOCIAL_REVIEW_GROUPS',
    // Value is the designated listening trust circle. Tagged like its siblings even
    // though it reads inverted (empty = feature dark, not "everyone allowed") —
    // the Access audit panel's job is to show WHICH groups a setting names.
    'SOCIAL_TRUST_GROUPS',
    'ASSISTANT_SHARED_HISTORY_GROUPS',
    'LIVETV_HIGH_PRIORITY_GROUPS',
    'WATCH_PERMISSION_GROUPS',
    'ADMIN_GROUPS',
    'LIVETV_GROUPS',
    'ARR_MANAGER_GROUPS',
    'REQUEST_GROUPS',
    'AGE_RATING_GROUP_PREFIX',
    'PLAYLIST_PUBLIC_GROUPS',
].sort();

// Keys that mention "group" but were deliberately NOT tagged — each fails the
// "value is a group name / list of group names" test for a different reason.
const DELIBERATELY_UNTAGGED_KEYS = [
    'GROUPHEADER', // value is an HTTP header NAME, not a group name
    'AUTH_OIDC_GROUPS_CLAIM', // value is a token CLAIM name, not a group name
    'SHOWCASE_PUBLIC_LIBRARY_GROUP_ID', // "group" here means a library_groups (media collection) row, not an auth group
    'TRENDING_DROPDOWN_GROUPS', // "group" here means grouping MDBList lists in a dropdown, unrelated to auth
    'NAVIGATION_AVAILABLE_GROUPS', // a supplemental pool for the nav-link permission dropdown, with its own bespoke editor/validation (group-service.ts) — does not itself gate anything
    'UNRATED_CONTENT_VISIBLE', // lives in the 'groups' section for proximity, but its value is a boolean, not a group reference
];

describe('getGroupReferencingSettings', () => {
    it('returns exactly the chosen tag set', () => {
        const keys = getGroupReferencingSettings()
            .map((s) => s.key)
            .sort();
        expect(keys).toEqual(EXPECTED_TAGGED_KEYS);
    });

    it('every returned setting is actually tagged uiHints.groups === true', () => {
        for (const setting of getGroupReferencingSettings()) {
            expect(setting.uiHints?.groups).toBe(true);
        }
    });

    it('every returned setting carries a non-empty home section id', () => {
        for (const setting of getGroupReferencingSettings()) {
            expect(typeof setting.section).toBe('string');
            expect(setting.section.length).toBeGreaterThan(0);
        }
    });

    it('deliberately-excluded "group"-named keys stay untagged', () => {
        for (const key of DELIBERATELY_UNTAGGED_KEYS) {
            const setting = configSchema.find((s) => s.key === key);
            expect(setting, `expected schema to still define ${key}`).toBeDefined();
            expect(setting?.uiHints?.groups).not.toBe(true);
        }
    });
});
