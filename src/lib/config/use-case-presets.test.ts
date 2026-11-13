// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    applyUseCasePreset,
    MANAGED_KEYS,
    USE_CASE_PRESETS,
    onValue,
    presetPreferenceDefaults,
    reapplyUseCasePreset,
    parseAppliedProfile,
    pendingProfileUpdates,
    serializeAppliedProfile,
    WIZARD_PREFERENCE_OVERLAP_KEYS,
    type PreviousProfile,
    type UseCaseId,
} from './use-case-presets';
import { TRAINING_USE_CASE } from './use-case-ids';
import { configSchema } from './schema';
import { SETUP_PREFERENCE_KEYS } from './setup-preferences';

const NO_CAPS = { hasEmbeddings: false, hasSonicEmbedder: false };
const ALL_CAPS = { hasEmbeddings: true, hasSonicEmbedder: true };

describe('applyUseCasePreset', () => {
    it('every preset patch covers every managed key', () => {
        for (const sel of [['vod'], ['music'], [TRAINING_USE_CASE], ['showcase'], []] as const) {
            const { patch } = applyUseCasePreset([...sel], NO_CAPS);
            for (const k of MANAGED_KEYS) expect(patch).toHaveProperty(k);
        }
    });

    it('music-only resolves to music-first', () => {
        const r = applyUseCasePreset(['music'], NO_CAPS);
        expect(r.primaryMode).toBe('music');
        expect(r.patch.FEATURE_MUSIC_FIRST).toBe(true);
        expect(r.patch.INSTANCE_PRIMARY_MODE).toBe('music');
        expect(r.landingPath).toBe('/music');
    });

    it('VOD always wins primary mode; no music-first', () => {
        const r = applyUseCasePreset(['vod', 'music'], NO_CAPS);
        expect(r.primaryMode).toBe('vod');
        expect(r.patch.FEATURE_MUSIC_FIRST).toBe(false);
        expect(r.landingPath).toBe('/');
    });

    it('training-only strips external + social and lands on library', () => {
        const r = applyUseCasePreset([TRAINING_USE_CASE], NO_CAPS);
        expect(r.primaryMode).toBe(TRAINING_USE_CASE);
        expect(r.patch.FEATURE_AI_RECOMMENDATIONS).toBe(false);
        expect(r.patch.FEATURE_GRAVATAR).toBe(false);
        expect(r.patch.FEATURE_AUTO_LYRICS).toBe(false);
        expect(r.patch.FEATURE_SOCIAL).toBe(false);
        expect(r.patch.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(false);
        expect(r.patch.DISABLE_LOCAL_TRICKPLAY).toBe(false); // trickplay kept on
        expect(r.landingPath).toBe('/library/home_video');
    });

    it('training turns the LMS on (assessment + training) so a fresh box has working /admin/{courses,trainings,reporting}', () => {
        const r = applyUseCasePreset([TRAINING_USE_CASE], NO_CAPS);
        expect(r.patch.FEATURE_ASSESSMENT).toBe(true);
        expect(r.patch.FEATURE_TRAINING_ASSIGNMENTS).toBe(true);
        // …but NOT the public showcase surface — that is its own preset.
        expect(r.patch.FEATURE_PUBLIC_SHOWCASE).toBe(false);
    });

    it('LMS flags stay off for non-training presets', () => {
        const v = applyUseCasePreset(['vod'], NO_CAPS);
        expect(v.patch.FEATURE_ASSESSMENT).toBe(false);
        expect(v.patch.FEATURE_TRAINING_ASSIGNMENTS).toBe(false);
    });

    it('enable-wins: VOD+Training re-enables external', () => {
        const r = applyUseCasePreset(['vod', TRAINING_USE_CASE], NO_CAPS);
        expect(r.patch.FEATURE_AI_RECOMMENDATIONS).toBe(true);
        expect(r.patch.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(true);
    });

    it('no ghost keys: a key set by an unselected preset returns to baseline', () => {
        // FEATURE_MUSIC_TRANSCODE is enabled by the music preset. With music NOT
        // selected, it must project to its schema baseline, never linger as true.
        const r = applyUseCasePreset([TRAINING_USE_CASE], NO_CAPS);
        expect(r.patch.FEATURE_MUSIC_TRANSCODE).toBe(false); // training disables it
        const v = applyUseCasePreset(['vod'], NO_CAPS);
        expect(v.patch).toHaveProperty('FEATURE_MUSIC_TRANSCODE'); // projected, not missing
    });

    it('enable-wins regardless of selection order', () => {
        const a = applyUseCasePreset(['vod', TRAINING_USE_CASE], NO_CAPS);
        const b = applyUseCasePreset([TRAINING_USE_CASE, 'vod'], NO_CAPS);
        expect(a.patch.FEATURE_AI_RECOMMENDATIONS).toBe(true);
        expect(b.patch.FEATURE_AI_RECOMMENDATIONS).toBe(true);
        expect(a.patch.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(true);
        expect(b.patch.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(true);
    });

    it('idempotent: same selection → identical patch', () => {
        const a = applyUseCasePreset(['vod', 'music'], ALL_CAPS);
        const b = applyUseCasePreset(['vod', 'music'], ALL_CAPS);
        expect(a.patch).toEqual(b.patch);
    });

    it('music capability gating', () => {
        const off = applyUseCasePreset(['music'], NO_CAPS);
        expect(off.patch.FEATURE_MUSIC_SONIC).toBe(false);
        expect(off.patch.FEATURE_MUSIC_LYRICS_SEARCH).toBe(false);
        const on = applyUseCasePreset(['music'], ALL_CAPS);
        expect(on.patch.FEATURE_MUSIC_SONIC).toBe(true);
        expect(on.patch.FEATURE_MUSIC_LYRICS_SEARCH).toBe(true);
        expect(on.patch.FEATURE_AI_RECOMMENDATIONS).toBe(true);
    });

    it('empty selection resets to baseline vod', () => {
        const r = applyUseCasePreset([], NO_CAPS);
        expect(r.primaryMode).toBe('vod');
        expect(r.patch.INSTANCE_PRIMARY_MODE).toBe('vod');
        expect(r.landingPath).toBe('');
    });

    it('showcase-only resolves to showcase mode with product library', () => {
        const r = applyUseCasePreset(['showcase'], NO_CAPS);
        expect(r.primaryMode).toBe('showcase');
        expect(r.patch.INSTANCE_PRIMARY_MODE).toBe('showcase');
        expect(r.patch.FEATURE_PUBLIC_SHOWCASE).toBe(true);
        expect(r.patch.SHOWCASE_REQUIRE_TOKEN).toBe(true);
        expect(r.patch.FEATURE_SOCIAL).toBe(false);
        expect(r.patch.FEATURE_AI_RECOMMENDATIONS).toBe(false);
        expect(r.patch.FEATURE_AI_ASSISTANT).toBe(false);
        expect(r.patch.DISABLE_LOCAL_TRICKPLAY).toBe(false); // trickplay kept on
        expect(r.patch.DISABLE_FILE_LIBRARY_SCAN).toBe(false); // scanning kept on
        expect(r.landingPath).toBe('/library/product');
        expect(r.libraryTypes).toContain('product');
    });

    it('vod wins over showcase (lower primaryRank)', () => {
        const r = applyUseCasePreset(['vod', 'showcase'], NO_CAPS);
        expect(r.primaryMode).toBe('vod');
        expect(r.patch.INSTANCE_PRIMARY_MODE).toBe('vod');
    });

    it('switching away from showcase resets FEATURE_PUBLIC_SHOWCASE to baseline (OFF)', () => {
        // Applying vod alone should NOT have FEATURE_PUBLIC_SHOWCASE=true
        const r = applyUseCasePreset(['vod'], NO_CAPS);
        expect(r.patch.FEATURE_PUBLIC_SHOWCASE).toBe(false);
    });

    // ── enable-wins must respect key POLARITY ────────────────────────────
    // The merge used to hardcode `true` as the winning value for every key,
    // which is only correct for positive-polarity keys (FEATURE_*, *_ENABLED).
    // For a `DISABLE_*` switch `true` is the OFF value, so hardcoding it
    // inverted enable-wins into disable-wins: one preset's `DISABLE_X: true`
    // silently overrode another's explicit `DISABLE_X: false`.
    //
    // Every assertion below covers a key some SELECTED preset explicitly turns
    // ON (`false`), so enable-wins must keep the task running.

    it('preprod repro: vod+music+training keeps vod/music tasks enabled', () => {
        // The exact selection running on preprod, where the training preset's
        // `DISABLE_FRIBB_ANIME_SYNC: true` beat vod's explicit `false` and left
        // 9,174 coverage rows stuck `pending` for 51 days.
        const r = applyUseCasePreset(['vod', 'music', TRAINING_USE_CASE], ALL_CAPS);
        expect(r.patch.DISABLE_FRIBB_ANIME_SYNC).toBe(false); // vod wants it on
        expect(r.patch.DISABLE_MAL_ANIME_ENRICHMENT).toBe(false); // vod wants it on
        expect(r.patch.DISABLE_CURATED_LISTS_SYNC).toBe(false); // vod wants it on
        expect(r.patch.DISABLE_MUSIC_ANALYSIS).toBe(false); // music wants it on
    });

    it('enable-wins on DISABLE_* holds regardless of selection order', () => {
        for (const sel of [
            ['vod', TRAINING_USE_CASE],
            [TRAINING_USE_CASE, 'vod'],
            ['showcase', 'vod'],
            ['vod', 'showcase'],
        ] as const) {
            const { patch } = applyUseCasePreset([...sel], ALL_CAPS);
            expect(patch.DISABLE_FRIBB_ANIME_SYNC, sel.join('+')).toBe(false);
            expect(patch.DISABLE_MAL_ANIME_ENRICHMENT, sel.join('+')).toBe(false);
        }
    });

    it('a DISABLE_* switch no preset turns on stays off', () => {
        // Guards against over-correcting: enable-wins only fires when some
        // SELECTED preset actually asks for the capability. vod never mentions
        // DISABLE_HOLIDAY_RECOMMENDATIONS, so the training preset's `true` stands.
        const r = applyUseCasePreset(['vod', TRAINING_USE_CASE], ALL_CAPS);
        expect(r.patch.DISABLE_HOLIDAY_RECOMMENDATIONS).toBe(true);
    });

    it('property: any conflicting taskSwitch resolves to its ON value', () => {
        // Generalises the cases above over every preset pair, so a newly added
        // preset or switch cannot reintroduce the polarity inversion.
        const ids = Object.keys(USE_CASE_PRESETS) as (keyof typeof USE_CASE_PRESETS)[];
        for (const a of ids) {
            for (const b of ids) {
                if (a === b) continue;
                const sa = USE_CASE_PRESETS[a].taskSwitches;
                const sb = USE_CASE_PRESETS[b].taskSwitches;
                for (const k of Object.keys(sa)) {
                    if (!(k in sb) || sa[k] === sb[k]) continue; // no conflict
                    const { patch } = applyUseCasePreset([a, b], ALL_CAPS);
                    expect(patch[k], `${k} for ${a}+${b}`).toBe(onValue(k));
                }
            }
        }
    });

    it('lint: every negative-polarity managed key is named DISABLE_*', () => {
        // onValue() infers polarity from the name. A negative-polarity key
        // named otherwise would merge backwards, so keep the naming honest —
        // or teach onValue() about it explicitly.
        const NEGATIVE_PREFIXES = ['DISABLE', 'NO_', 'SUPPRESS', 'HIDE', 'SKIP'];
        for (const k of MANAGED_KEYS) {
            const looksNegative = NEGATIVE_PREFIXES.some((p) => k.startsWith(p));
            if (looksNegative) expect(onValue(k), k).toBe(false);
        }
    });

    it('lint: no key in both enable and disable of a preset', () => {
        for (const p of Object.values(USE_CASE_PRESETS)) {
            const dis = new Set(p.disable);
            for (const e of p.enable) expect(dis.has(e)).toBe(false);
        }
    });

    it('every MANAGED_KEY has a configSchema entry (no silent false baseline)', () => {
        const keys = new Set(configSchema.map((s) => s.key));
        for (const k of MANAGED_KEYS) expect(keys.has(k)).toBe(true);
    });
});

describe('wizard preference overlap', () => {
    it('every declared overlap key is actually projected (else the seed is dead code)', () => {
        const managed = new Set(MANAGED_KEYS);
        for (const k of WIZARD_PREFERENCE_OVERLAP_KEYS) expect(managed.has(k), k).toBe(true);
    });

    it('seeds the VOD toggles to the values the projection would write', () => {
        const d = presetPreferenceDefaults(['vod']);
        // These two are where the wizard's old hardcoded `false` contradicted the
        // preset — the pair that made the race observable.
        expect(d.SHOW_UNAVAILABLE_MEDIA).toBe(true);
        expect(d.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(true);
    });

    it('seeds the showcase toggles to the storefront-safe values', () => {
        const d = presetPreferenceDefaults(['showcase']);
        expect(d.SHOW_UNAVAILABLE_MEDIA).toBe(false);
        expect(d.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED).toBe(false);
        expect(d.FEATURE_AUTO_LYRICS).toBe(false);
    });

    it('agrees with applyUseCasePreset for every selection and both capability sets', () => {
        for (const sel of [
            ['vod'],
            ['music'],
            [TRAINING_USE_CASE],
            ['showcase'],
            ['vod', 'music'],
            [],
        ]) {
            const seeded = presetPreferenceDefaults([...sel] as never);
            for (const caps of [NO_CAPS, ALL_CAPS]) {
                const { patch } = applyUseCasePreset([...sel] as never, caps);
                for (const k of WIZARD_PREFERENCE_OVERLAP_KEYS) {
                    expect(seeded[k], `${sel.join('+') || 'none'}/${k}`).toBe(patch[k] === true);
                }
            }
        }
    });
});

/** A previous apply from before recording existed: use cases only. */
const legacy = (useCases: UseCaseId[]): PreviousProfile => ({ useCases });

describe('reapplyUseCasePreset', () => {
    const baselineOf = (sel: Parameters<typeof applyUseCasePreset>[0]) =>
        applyUseCasePreset(sel, NO_CAPS).patch;

    it('no previous profile: the whole projection is written', () => {
        const r = reapplyUseCasePreset(null, ['music'], NO_CAPS, () => undefined);
        expect(r.writes).toEqual(applyUseCasePreset(['music'], NO_CAPS).patch);
        expect(r.overrides).toEqual([]);
    });

    it('the same selection writes nothing, whatever the admin changed since', () => {
        const projected = baselineOf(['vod']);
        const current: Record<string, unknown> = {
            ...projected,
            FEATURE_CALENDAR: false,
            FEATURE_LIVETV: true,
        };
        const r = reapplyUseCasePreset(legacy(['vod']), ['vod'], NO_CAPS, (k) => current[k]);
        expect(r.writes).toEqual({});
    });

    it('selection order does not count as a change', () => {
        const r = reapplyUseCasePreset(
            legacy(['music', 'vod']),
            ['vod', 'music'],
            NO_CAPS,
            () => null,
        );
        expect(r.writes).toEqual({});
    });

    it('writes only keys whose projection moves; an admin change the move agrees with survives', () => {
        const current: Record<string, unknown> = {
            ...baselineOf(['vod']),
            FEATURE_LIVETV: true, // admin's change; vod left it at baseline, music keeps it off
            FEATURE_SOCIAL: false, // admin's change; vod and music both want it on
            INSTANCE_LANDING_PATH: '/playlists', // admin's own landing page
        };
        const r = reapplyUseCasePreset(legacy(['vod']), ['music'], NO_CAPS, (k) => current[k]);
        expect(r.writes).not.toHaveProperty('FEATURE_LIVETV');
        expect(r.writes).not.toHaveProperty('FEATURE_SOCIAL');
        expect(r.writes.INSTANCE_PRIMARY_MODE).toBe('music');
        // vod turns the calendar on, music off: the move asks for it.
        expect(r.writes.FEATURE_CALENDAR).toBe(false);
        expect(r.overrides).not.toContain('FEATURE_CALENDAR');
        // The profile's landing page moves and replaces the admin's own one.
        expect(r.writes.INSTANCE_LANDING_PATH).toBe('/music');
        expect(r.overrides).toEqual(['INSTANCE_LANDING_PATH']);
    });

    it('capability-gated keys are written once the capability exists ("configure, then re-apply")', () => {
        const current = baselineOf(['music']);
        const r = reapplyUseCasePreset(legacy(['music']), ['music'], ALL_CAPS, (k) => current[k]);
        expect(r.writes.FEATURE_MUSIC_SONIC).toBe(true);
        expect(r.writes.FEATURE_MUSIC_MAP).toBe(true);
    });
});

describe('reapplyUseCasePreset with capabilities and the showcase token', () => {
    it('switching away from music turns off what music turned on with capabilities', () => {
        const current = applyUseCasePreset(['music'], ALL_CAPS).patch as Record<string, unknown>;
        const r = reapplyUseCasePreset(legacy(['music']), ['vod'], ALL_CAPS, (k) => current[k]);
        expect(r.writes.FEATURE_MUSIC_SONIC).toBe(false);
        expect(r.writes.FEATURE_MUSIC_LYRICS_SEARCH).toBe(false);
    });

    it('re-applying music with capabilities turns a feature the admin switched off back on, and says so', () => {
        const current: Record<string, unknown> = {
            ...applyUseCasePreset(['music'], ALL_CAPS).patch,
            FEATURE_MUSIC_SONIC: false,
        };
        const r = reapplyUseCasePreset(legacy(['music']), ['music'], ALL_CAPS, (k) => current[k]);
        expect(r.writes).toEqual({ FEATURE_MUSIC_SONIC: true });
        expect(r.overrides).toEqual(['FEATURE_MUSIC_SONIC']);
    });

    it('re-adding showcase restores the token requirement an earlier opt-out left off', () => {
        const current: Record<string, unknown> = {
            ...applyUseCasePreset(['vod'], NO_CAPS).patch,
            FEATURE_PUBLIC_SHOWCASE: false,
            SHOWCASE_REQUIRE_TOKEN: false,
        };
        const r = reapplyUseCasePreset(
            legacy(['vod']),
            ['vod', 'showcase'],
            NO_CAPS,
            (k) => current[k],
        );
        expect(r.writes.FEATURE_PUBLIC_SHOWCASE).toBe(true);
        expect(r.writes.SHOWCASE_REQUIRE_TOKEN).toBe(true);
        expect(r.overrides).toContain('SHOWCASE_REQUIRE_TOKEN');
    });

    it('an already-public showcase keeps its token setting on re-apply', () => {
        const current: Record<string, unknown> = {
            ...applyUseCasePreset(['showcase'], NO_CAPS).patch,
            SHOWCASE_REQUIRE_TOKEN: false,
        };
        const r = reapplyUseCasePreset(
            legacy(['showcase']),
            ['showcase'],
            NO_CAPS,
            (k) => current[k],
        );
        expect(r.writes).toEqual({});
    });
});

describe('WIZARD_PREFERENCE_OVERLAP_KEYS', () => {
    it('lists every key both the wizard preferences and the projection write', () => {
        const prefKeys = new Set<string>(Object.values(SETUP_PREFERENCE_KEYS));
        const overlap = MANAGED_KEYS.filter((k) => prefKeys.has(k)).sort();
        expect(overlap).toEqual([...WIZARD_PREFERENCE_OVERLAP_KEYS].sort());
    });
});

describe('reapplyUseCasePreset with a recorded previous apply', () => {
    const recordOf = (useCases: UseCaseId[], caps = NO_CAPS): PreviousProfile => ({
        useCases,
        values: applyUseCasePreset(useCases, caps).patch,
    });

    it('a key the preset gained since the record is written and marked added', () => {
        const prev = recordOf(['music']);
        delete prev.values!.FEATURE_LIVETV; // "the old release did not set it"
        const current: Record<string, unknown> = { ...prev.values, FEATURE_LIVETV: true };
        const r = reapplyUseCasePreset(prev, ['music'], NO_CAPS, (k) => current[k]);
        expect(r.writes).toEqual({ FEATURE_LIVETV: false });
        expect(r.added).toEqual(['FEATURE_LIVETV']);
        expect(r.overrides).toEqual([]);
    });

    it('capability catch-up: applied before the embedder existed, written now, not an override', () => {
        const prev = recordOf(['music'], NO_CAPS);
        const current = prev.values as Record<string, unknown>;
        const r = reapplyUseCasePreset(prev, ['music'], ALL_CAPS, (k) => current[k]);
        expect(r.writes.FEATURE_MUSIC_SONIC).toBe(true);
        expect(r.overrides).not.toContain('FEATURE_MUSIC_SONIC');
    });

    it('a capability feature the admin switched off after a capable apply stays off', () => {
        const prev = recordOf(['music'], ALL_CAPS);
        const current: Record<string, unknown> = { ...prev.values, FEATURE_MUSIC_SONIC: false };
        const r = reapplyUseCasePreset(prev, ['music'], ALL_CAPS, (k) => current[k]);
        expect(r.writes).toEqual({});
    });
});

describe('reapplyUseCasePreset when a capability goes away', () => {
    it('an apply while the embedder is down does not turn the music features off', () => {
        const prev: PreviousProfile = {
            useCases: ['music'],
            values: applyUseCasePreset(['music'], ALL_CAPS).patch,
        };
        const current = prev.values as Record<string, unknown>;
        const r = reapplyUseCasePreset(prev, ['music', 'vod'], NO_CAPS, (k) => current[k]);
        expect(r.writes).not.toHaveProperty('FEATURE_MUSIC_SONIC');
        expect(r.writes).not.toHaveProperty('FEATURE_MUSIC_LYRICS_SEARCH');
        expect(
            pendingProfileUpdates({ ...prev, at: 'x' } as never, NO_CAPS, (k) => current[k]),
        ).toEqual([]);
    });

    it('deselecting music still turns them off', () => {
        const prev: PreviousProfile = {
            useCases: ['music'],
            values: applyUseCasePreset(['music'], ALL_CAPS).patch,
        };
        const current = prev.values as Record<string, unknown>;
        const r = reapplyUseCasePreset(prev, ['vod'], NO_CAPS, (k) => current[k]);
        expect(r.writes.FEATURE_MUSIC_SONIC).toBe(false);
    });
});

describe('applied-profile record', () => {
    it('round-trips and drops unknown use cases', () => {
        const raw = serializeAppliedProfile({
            useCases: ['music'],
            values: { FEATURE_CALENDAR: false, INSTANCE_USE_CASES: ['music'] },
            at: '2026-10-07T10:00:00.000Z',
        });
        expect(parseAppliedProfile(raw)).toEqual({
            useCases: ['music'],
            values: { FEATURE_CALENDAR: false, INSTANCE_USE_CASES: ['music'] },
            at: '2026-10-07T10:00:00.000Z',
        });
        const withUnknown = raw.replace('["music"]', '["music","legacy"]');
        expect(parseAppliedProfile(withUnknown)?.useCases).toEqual(['music']);
        // Prototype names are not presets.
        const withProto = raw.replace('["music"]', '["music","constructor","toString"]');
        expect(parseAppliedProfile(withProto)?.useCases).toEqual(['music']);
        expect(() =>
            applyUseCasePreset(['constructor' as UseCaseId, 'music'], NO_CAPS),
        ).not.toThrow();
    });

    it.each(['', 'not json', '{"v":2}', '{"v":1,"at":"x","useCases":[],"values":[]}', 42])(
        'reads %j as not recorded',
        (raw) => {
            expect(parseAppliedProfile(raw)).toBeNull();
        },
    );

    it('requestedKeys names the profile choices, not the baseline it fills in', () => {
        const r = applyUseCasePreset(['music'], NO_CAPS);
        expect(r.requestedKeys).toContain('FEATURE_CALENDAR'); // music disables it
        expect(r.requestedKeys).toContain('INSTANCE_PRIMARY_MODE');
        expect(r.requestedKeys).not.toContain('FEATURE_PUBLIC_SHOWCASE'); // baseline only
    });
});

describe('pendingProfileUpdates', () => {
    const applied = (caps = NO_CAPS) => ({
        useCases: ['music'] as UseCaseId[],
        values: applyUseCasePreset(['music'], caps).patch,
        at: '2026-10-07T10:00:00.000Z',
    });

    it('is empty when nothing about the profile moved', () => {
        const a = applied();
        expect(pendingProfileUpdates(a, NO_CAPS, (k) => a.values[k])).toEqual([]);
    });

    it('lists capability features that became available, but not admin changes', () => {
        const a = applied(NO_CAPS);
        const current: Record<string, unknown> = { ...a.values, FEATURE_TRENDING: true };
        const pending = pendingProfileUpdates(a, ALL_CAPS, (k) => current[k]);
        expect(pending).toContain('FEATURE_MUSIC_SONIC');
        expect(pending).not.toContain('FEATURE_TRENDING');
    });

    it('is empty without a record', () => {
        expect(pendingProfileUpdates(null, ALL_CAPS, () => undefined)).toEqual([]);
    });
});
