// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A homepage widget that declares a `featureFlag` must actually be gated on it.
 *
 * The home page and the admin widget editor each carried their own hand-written
 * flag list. They drifted: the editor's had five entries, the home page's had
 * four, and `trending` was in only the editor's. So FEATURE_TRENDING=false
 * greyed the widget out in admin settings and rendered it anyway on the home
 * page — with live third-party content on an instance meant to show none.
 *
 * The parity that matters is that a declared flag resolves to a key the
 * `features` object really exposes. A typo or a rename produces `undefined`,
 * `undefined === false` is false, and the widget silently renders forever.
 */

import { describe, expect, it } from 'vitest';
import { WIDGET_DEFINITIONS, featureKeyForFlag, widgetFeatureKey } from './schema';
import { features } from '$lib/server/config';

describe('featureKeyForFlag', () => {
    it.each([
        ['FEATURE_TRENDING', 'trending'],
        ['FEATURE_SESSIONS', 'sessions'],
        ['FEATURE_CALENDAR', 'calendar'],
        ['FEATURE_WATCH_TOGETHER', 'watchTogether'],
        ['FEATURE_AI_RECOMMENDATIONS', 'aiRecommendations'],
    ])('%s -> %s', (flag, key) => {
        expect(featureKeyForFlag(flag)).toBe(key);
    });
});

describe('widget feature flags', () => {
    const flagged = WIDGET_DEFINITIONS.filter((w) => w.featureFlag);

    it('has at least one flagged widget to check', () => {
        expect(flagged.length).toBeGreaterThan(0);
    });

    it.each(flagged.map((w) => [w.id, w.featureFlag as string]))(
        '%s declares %s, which resolves to a real key on `features`',
        (_id, flag) => {
            expect(features).toHaveProperty(featureKeyForFlag(flag));
        },
    );

    it('resolves the flag key for a widget that has one', () => {
        expect(widgetFeatureKey('trending')).toBe('trending');
    });

    it('returns undefined for a widget with no flag', () => {
        // 'watchlist' is deliberately unflagged — the helper must not invent a key
        // for it, or shouldShowWidget would read features.undefined.
        expect(widgetFeatureKey('watchlist')).toBeUndefined();
        expect(widgetFeatureKey('not-a-widget')).toBeUndefined();
    });
});
