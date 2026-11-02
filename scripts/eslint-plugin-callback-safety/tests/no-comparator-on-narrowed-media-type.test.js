// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for no-comparator-on-narrowed-media-type (the dead-guard rule).
 *
 * The rule reports a comparator applied to an already-collapsed value ONLY when
 * the comparator's token is outside the narrowing function's range — i.e. the
 * guard is provably dead. The boundaries with coverage below:
 *
 *   - in-range comparators stay silent (`isSeries(toPublicMovieOrSeries(x))` is
 *     the normal, correct shape and appears all over the tree);
 *   - a comparator on a RAW value stays silent — that is the correct use;
 *   - a same-file narrower annotated with a type REFERENCE has unknown range and
 *     must stay silent (this is what keeps
 *     `context-primitives.ts::normalizeMediaType`, a passthrough cast, quiet);
 *   - a same-file narrower annotated with a literal union is read from the
 *     annotation, so the rule survives the concurrent domain rename.
 */

const { RuleTester } = require('eslint');
const rule = require('../rules/no-comparator-on-narrowed-media-type');

const ruleTester = new RuleTester({
    languageOptions: {
        parser: require('@typescript-eslint/parser'),
        ecmaVersion: 2020,
        sourceType: 'module',
    },
});

const STORE = '/repo/src/lib/stores/modal-url-sync.ts';
const DEF = '/repo/src/lib/server/api/defs/media-details/index.ts';
const COMPONENT = '/repo/src/lib/components/modal/ModalActions.svelte';
const TEST_FILE = '/repo/src/lib/stores/modal-url-sync.test.ts';

// The shipped bug, verbatim (modal-url-sync.ts). `normalizeType` is declared in
// the same file, so its range is read off the annotation — the table is not even
// consulted.
const SHIPPED_LOCAL_NARROWER = `
function normalizeType(type: string): 'movie' | 'tv' | 'episode' {
    const normalized = type.toUpperCase();
    switch (normalized) {
        case 'MOVIE': return 'movie';
        case 'SERIES':
        case 'TV': return 'tv';
        case 'EPISODE': return 'episode';
        default: return 'movie';
    }
}
`;

ruleTester.run('no-comparator-on-narrowed-media-type', rule, {
    valid: [
        // ── Comparator on a RAW value: the correct use ───────────────────────
        { code: `const k = isAudiobook(row.media_type) ? 'audiobook' : 'movie';`, filename: STORE },
        { code: `if (isAudiobook(String(props.mediaType))) { openBook(); }`, filename: STORE },
        {
            code: `const rawMediaType = String(props.mediaType); const k = isAudiobook(rawMediaType) ? 'audiobook' : 'movie';`,
            filename: STORE,
        },
        { code: `if (isSeries(item.mediaType)) { openSeries(); }`, filename: DEF },

        // ── Comparator IN RANGE of the narrowing function ───────────────────
        { code: `const t = isSeries(toPublicMovieOrSeries(x)) ? 'tv' : 'movie';`, filename: DEF },
        {
            code: `const canonicalType = toPublicMovieOrSeries(s.media_type); if (isMovie(canonicalType)) { m(); }`,
            filename: DEF,
        },
        {
            code: `if (isAudiobook(toPublicDetailType(row.media_type))) { openBook(); }`,
            filename: DEF,
        },
        { code: `if (isEpisode(normalizeMediaType(raw))) { ep(); }`, filename: DEF },
        { code: `if (isSeries(toTmdbType(x))) { series(); }`, filename: DEF },
        { code: `if (isTrack(toPublicMediaType(row.media_type))) { t(); }`, filename: DEF },
        // media-type-domain.ts (the consolidated module) — in-range combinations.
        {
            code: `if (isAudiobook(toDetailMediaType(row.media_type))) { openBook(); }`,
            filename: DEF,
        },
        {
            code: `if (isTvChannel(toUniversalMediaType(row.media_type))) { live(); }`,
            filename: DEF,
        },
        { code: `if (isEpisode(apiTypeOf(internalType))) { ep(); }`, filename: DEF },
        // `toInternalMediaType` collapses nothing (full internal vocabulary), so
        // it is intentionally not a narrower — no comparator is dead against it.
        { code: `if (isAudiobook(toInternalMediaType(raw))) { openBook(); }`, filename: DEF },
        { code: `if (isHomeVideo(toInternalMediaType(raw))) { hv(); }`, filename: DEF },

        // ── Unknown / unbounded range → never reported ──────────────────────
        // Same-file narrower annotated with a type REFERENCE: the rule cannot
        // know the range, so it stays silent (context-primitives.ts shape).
        {
            code: `function normalizeMediaType(value: string): InternalMediaType { return value as InternalMediaType; }
                   if (isAudiobook(normalizeMediaType(v))) { openBook(); }`,
            filename: DEF,
        },
        // Same name, `: string` annotation (ingest-map.constants.ts shape).
        {
            code: `function canonicalMediaType(raw: string): string { return raw.toLowerCase(); }
                   if (isAudiobook(canonicalMediaType(v))) { openBook(); }`,
            filename: DEF,
        },
        // Not a narrowing function at all.
        { code: `if (isAudiobook(getMediaType(id))) { openBook(); }`, filename: DEF },
        { code: `if (isAudiobook(x)) { openBook(); }`, filename: DEF },

        // ── A reassigned local could hold anything by the time it is read ────
        {
            code: `let mediaType = normalizeType(raw); mediaType = other; if (isAudiobook(mediaType)) { openBook(); }`,
            filename: STORE,
        },

        // ── Svelte 5 runes: a `$derived` over a RAW value is still raw ───────
        // This is the dominant shape in components and must not become noise.
        {
            code: `const mediaType = $derived(props.mediaType); if (isAudiobook(mediaType)) { openBook(); }`,
            filename: COMPONENT,
        },
        {
            code: `const mediaType = $derived(toDetailMediaType(props.mediaType)); if (isAudiobook(mediaType)) { openBook(); }`,
            filename: COMPONENT,
        },

        // ── Test files are exempt ───────────────────────────────────────────
        {
            code: `expect(isAudiobook(normalizeType('audiobook'))).toBe(false);`,
            filename: TEST_FILE,
        },
    ],

    invalid: [
        // ── The shipped bug, verbatim: local narrower + local variable ───────
        {
            code:
                SHIPPED_LOCAL_NARROWER +
                `
function updateUrlForModal(props) {
    const mediaType = normalizeType(String(props.mediaType));
    const slugKind = isSeries(mediaType)
        ? 'tv'
        : isAudiobook(mediaType)
          ? 'audiobook'
          : 'movie';
    return slugKind;
}
`,
            filename: STORE,
            errors: [
                {
                    messageId: 'deadGuard',
                    data: {
                        comparator: 'isAudiobook',
                        subject: '`mediaType`',
                        narrower: 'normalizeType',
                        range: "'movie' | 'tv' | 'episode'",
                    },
                },
            ],
        },
        // ── Direct shape (a): comparator wrapped straight around the call ────
        {
            code: `const k = isAudiobook(normalizeType(String(props.mediaType))) ? 'audiobook' : 'movie';`,
            filename: STORE,
            errors: [{ messageId: 'deadGuard' }],
        },
        {
            code: `if (isAudiobook(toPublicMovieOrSeries(row.media_type))) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        {
            code: `if (isTrack(toPublicMovieOrSeries(row.media_type))) { play(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // `toTmdbType` returns 'movie' | 'tv' — no episode can survive it.
        {
            code: `if (isEpisode(toTmdbType(session.media_type))) { ep(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // `toPublicMediaType` cannot emit 'tvchannel' (it maps to null).
        {
            code: `if (isTvChannel(toPublicMediaType(row.media_type))) { live(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // Jellyfin's vocabulary has no audiobook.
        {
            code: `if (isAudiobook(jellyfinToUIType(item.Type))) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // ── Shape (b) via an imported narrower and a local ──────────────────
        {
            code: `const canonicalType = toPublicMovieOrSeries(item.mediaType); if (isEpisode(canonicalType)) { ep(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // ── media-type-domain.ts (the consolidated module) ──────────────────
        // `TO_MOVIE_OR_SERIES` maps audiobook → null, so this guard is dead.
        {
            code: `if (isAudiobook(toMovieOrSeries(row.media_type))) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // `TO_API` has no audiobook member.
        {
            code: `const apiType = toApiMediaType(row.media_type); if (isAudiobook(apiType)) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // `TO_MOVIE_OR_SERIES` maps episode → null, so an episode check is dead.
        {
            code: `if (isEpisode(movieOrSeriesOf(internalType))) { ep(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // `TO_UNIVERSAL` has no 'season' member.
        {
            code: `if (isSeason(universalTypeOf(internalType))) { s(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // ── A same-file ARROW narrower with a literal-union annotation ───────
        // Proves the annotation path (not the table) carries the range, which is
        // what keeps the rule working through the domain rename.
        {
            code: `const collapseType = (t: string): 'movie' | 'series' => (t === 'tv' ? 'series' : 'movie');
                   if (isAudiobook(collapseType(row.media_type))) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
        // ── Svelte 5 runes: `$derived` / `$derived.by` over a narrowing call ─
        {
            code: `const mediaType = $derived(toMovieOrSeries(props.mediaType)); const label = isAudiobook(mediaType) ? 'read' : 'watch';`,
            filename: COMPONENT,
            errors: [{ messageId: 'deadGuard' }],
        },
        {
            code: `const mediaType = $derived.by(() => toMovieOrSeries(props.mediaType)); const label = isAudiobook(mediaType) ? 'read' : 'watch';`,
            filename: COMPONENT,
            errors: [{ messageId: 'deadGuard' }],
        },
        {
            code: `const label = isAudiobook($derived(toMovieOrSeries(props.mediaType))) ? 'read' : 'watch';`,
            filename: COMPONENT,
            errors: [{ messageId: 'deadGuard' }],
        },
        // ── `as` cast between the narrowing call and the comparator ─────────
        {
            code: `if (isAudiobook(toPublicMovieOrSeries(x) as string)) { openBook(); }`,
            filename: DEF,
            errors: [{ messageId: 'deadGuard' }],
        },
    ],
});

// The two domain tables are exported so a refactor can diff them against the
// real module. Assert they stay shaped as the rule expects.
const assert = require('node:assert');
assert.ok(rule.NARROWING_FUNCTIONS.normalizeType, 'NARROWING_FUNCTIONS must be exported');
assert.ok(rule.COMPARATOR_TOKENS.isAudiobook, 'COMPARATOR_TOKENS must be exported');
for (const [name, range] of Object.entries(rule.NARROWING_FUNCTIONS)) {
    assert.ok(
        Array.isArray(range) && range.length > 0 && range.every((t) => t === t.toUpperCase()),
        `${name}: range must be a non-empty UPPERCASE token array`,
    );
}
for (const [name, tokens] of Object.entries(rule.COMPARATOR_TOKENS)) {
    assert.ok(
        Array.isArray(tokens) && tokens.length > 0 && tokens.every((t) => t === t.toUpperCase()),
        `${name}: accepted tokens must be a non-empty UPPERCASE array`,
    );
}

console.log('no-comparator-on-narrowed-media-type: all tests passed');
