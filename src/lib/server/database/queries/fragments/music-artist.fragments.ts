// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Music Artist SQL Fragments
 *
 * Shared SQL expressions for resolving how a track's artist should be
 * displayed in lists, cards, and embedding text.
 *
 * @module fragments/music-artist
 */

import type postgres from 'postgres';

/**
 * Matches UUID text, so a malformed `additional_artist_ids` entry can be dropped
 * *before* it reaches a `::uuid` cast.
 *
 * This matters more than it looks. The cast lives inside a scalar subquery on
 * the queue-candidate queries, and `invalid input syntax for type uuid` aborts
 * the whole statement — so one corrupted track would kill autoplay for every
 * user whose candidate pool happened to include it, not just that row. (The
 * album-detail path casts the same way, but a throw there only breaks one album
 * page.) Nothing writes non-UUIDs today — `findOrCreateMusicArtist` returns
 * UUIDs and prod has zero violations — but the blast radius makes a guard worth
 * the regex.
 *
 * Deliberately written without backslash escapes: postgres.js interpolates the
 * COOKED template string, so `\s`/`\d` would arrive as a bare `s`/`d` and match
 * the wrong thing.
 */
const UUID_TEXT_PATTERN =
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/*
 * ARTIST_LOOKUP_NOTE. Every artist lookup below is a `LATERAL (... OFFSET 0)`
 * subquery keyed on media_items.id, not a plain JOIN. The planner assumes a
 * jsonb_array_elements call returns 100 rows, so with a plain JOIN it hashed
 * the whole artist table for every track row instead of doing one or two
 * primary-key lookups: about 1.5 ms per row on a 6.6k-artist library, which
 * made New For You take 17 s. OFFSET 0 keeps the subquery from being pulled
 * up into a join the planner could hash again. The predicates are the ones
 * the JOINs had, and id is the primary key, so each lookup still yields at
 * most one row.
 */

/** Scanner-owned credits are authoritative, including unresolved names. */
function trackMetadataSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't',
): postgres.PendingQuery<postgres.Row[]> {
    return alias === 'mi'
        ? sql`mi.custom_metadata`
        : alias === 't'
          ? sql`t.custom_metadata`
          : sql`track.custom_metadata`;
}

/** Resolve names live, so a catalog rename never requires rewriting file tags. */
export function canonicalTrackArtistsSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    const meta = trackMetadataSql(sql, alias);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- referenced artist identities inherit the caller's scoped track; artist click-through gates access independently
    return sql`CASE WHEN jsonb_typeof(NULLIF(${meta}->'track_artist_credits', '[]'::jsonb)) = 'array' THEN (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'id', credited.id,
            'title', COALESCE(credited.title, CASE WHEN jsonb_typeof(credit->'credited_name') = 'string'
                THEN NULLIF(btrim(credit->>'credited_name'), '') END)
        ) ORDER BY ord) FILTER (WHERE COALESCE(credited.title, CASE WHEN jsonb_typeof(credit->'credited_name') = 'string'
                THEN NULLIF(btrim(credit->>'credited_name'), '') END) IS NOT NULL
                -- Various Artists is a compilation marker, never a performer: drop credits that
                -- resolve to a VA row or whose name is a VA alias.
                AND va_credit.id IS NULL
                AND NOT (credited.id IS NULL AND jsonb_typeof(credit->'credited_name') = 'string'
                    AND regexp_replace(lower(btrim(credit->>'credited_name')), '[^a-z0-9 ]', '', 'g')
                        = ANY(ARRAY['va', 'various', 'various artist', 'various artists']))), '[]'::jsonb)
        FROM jsonb_array_elements(${meta}->'track_artist_credits') WITH ORDINALITY credits(credit, ord)
        -- Primary-key lookups: see ARTIST_LOOKUP_NOTE.
        LEFT JOIN LATERAL (
            SELECT a.id, a.title FROM media_items a
            WHERE a.id = CASE WHEN credit->>'id' ~ ${UUID_TEXT_PATTERN} THEN (credit->>'id')::uuid END
              AND a.media_type = 'artist' AND a.status = 'active'
              AND a.parent_id IS NULL AND NOT a.is_various_artists
            OFFSET 0
        ) credited ON true
        LEFT JOIN LATERAL (
            SELECT a.id FROM media_items a
            WHERE a.id = CASE WHEN credit->>'id' ~ ${UUID_TEXT_PATTERN} THEN (credit->>'id')::uuid END
              AND a.media_type = 'artist' AND a.is_various_artists
            OFFSET 0
        ) va_credit ON true
    ) END`;
}

/**
 * Resolve {@link canonicalTrackArtistsSql} ONCE per row and expose it as
 * `track_credit.artists` ({@link trackCreditArtistsSql}). Pass that column as
 * `resolved` to trackDisplayArtistSql, trackArtistIdSql and trackArtistsSql:
 * each of them otherwise embeds its own copy of the credit lookup (a
 * jsonb_array_elements scan plus two media_items joins per credit), so a row
 * selecting all three paid for it three times.
 *
 * Join it after the LIMIT that bounds the rows, not inside a candidate pool:
 * a LATERAL in the FROM list runs for every row the join produces, before any
 * Sort above it. `OFFSET 0` keeps the planner from pulling the subquery up,
 * which would paste the expression back into every reference.
 *
 * Requires `<alias>.custom_metadata` in the surrounding FROM list.
 */
export function canonicalTrackArtistsJoinSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    return sql`LEFT JOIN LATERAL (
        SELECT ${canonicalTrackArtistsSql(sql, alias)} AS artists OFFSET 0
    ) track_credit ON true`;
}

/** The column {@link canonicalTrackArtistsJoinSql} exposes. */
export function trackCreditArtistsSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`track_credit.artists`;
}

export function trackDisplayArtistSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
    resolved?: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const canonical = resolved ?? canonicalTrackArtistsSql(sql, alias);
    const meta = trackMetadataSql(sql, alias);
    return sql`CASE WHEN jsonb_typeof(NULLIF(${meta}->'track_artist_credits', '[]'::jsonb)) = 'array'
        THEN (SELECT string_agg(credit->>'title', ', ' ORDER BY ord)
        FROM jsonb_array_elements(${canonical}) WITH ORDINALITY credits(credit, ord))
        ELSE ${legacyTrackDisplayArtistSql(sql, alias)} END`;
}

export function trackArtistIdSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
    resolved?: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const meta = trackMetadataSql(sql, alias);
    return sql`CASE WHEN jsonb_typeof(NULLIF(${meta}->'track_artist_credits', '[]'::jsonb)) = 'array'
        THEN (${resolved ?? canonicalTrackArtistsSql(sql, alias)}->0->>'id')::uuid
        ELSE ${legacyTrackArtistIdSql(sql, alias)} END`;
}

export function trackArtistsSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
    resolved?: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`COALESCE(${resolved ?? canonicalTrackArtistsSql(sql, alias)}, ${legacyTrackArtistsSql(sql, alias)})`;
}

/** Remixers are title navigation targets, never implicit performer credits. */
export function trackRemixerArtistsSql(
    sql: postgres.Sql,
    alias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    const meta = trackMetadataSql(sql, alias);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- referenced artist identities inherit the caller's scoped track; artist click-through gates access independently
    return sql`(SELECT jsonb_agg(jsonb_build_object('id', remixer.id, 'title', remixer.title) ORDER BY ord)
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(${meta}->'remixer_artist_ids') = 'array'
            THEN ${meta}->'remixer_artist_ids' ELSE '[]'::jsonb END) WITH ORDINALITY ids(id, ord)
        CROSS JOIN LATERAL (
            SELECT a.id, a.title FROM media_items a
            WHERE a.id = CASE WHEN ids.id ~ ${UUID_TEXT_PATTERN} THEN ids.id::uuid END
              AND a.media_type = 'artist' AND a.status = 'active'
              AND a.parent_id IS NULL AND NOT a.is_various_artists
            OFFSET 0
        ) remixer)`;
}

/**
 * Merge already-resolved primary and additional credits, keeping the first
 * occurrence of each UUID in credit order. An empty result stays NULL so the
 * caller can retain its raw-tag fallback. Requires the existing track_artist
 * and additional_artists aliases; performs no additional artist lookup.
 */
export function resolvedTrackArtistsSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(
        SELECT jsonb_agg(credit ORDER BY ord)
        FROM (
            SELECT DISTINCT ON (credit->>'id') credit, ord
            FROM jsonb_array_elements(
                COALESCE(track_artist.artists, '[]'::jsonb)
                || COALESCE(additional_artists.artists, '[]'::jsonb)
            ) WITH ORDINALITY credits(credit, ord)
            ORDER BY credit->>'id', ord
        ) unique_credits
    )`;
}

/**
 * Build the SQL expression that resolves a track's display artist.
 *
 * Priority:
 *   1. Per-track tag (`<trackAlias>.custom_metadata->>'artist'`) when non-empty
 *   2. Album-artist (`<artistAlias>.title`) when not the placeholder "Unknown Artist"
 *   3. Raw album-artist title (last-resort fallback)
 *
 * The per-track tag wins because the album-artist row stores "Various Artists"
 * for compilations — falling through to the per-track tag surfaces the actual
 * performer (e.g. "Megalanterns" on a VA dancefloor compilation) instead of the
 * compilation marker. For non-compilation albums the per-track tag normally
 * matches the album-artist; when it differs it carries feature credits
 * ("Megalanterns feat. X") which is more informative anyway.
 *
 * Requires the surrounding query to expose:
 *   - `<trackAlias>.custom_metadata` (jsonb) — the track row
 *   - `<artistAlias>.title` (text) — the album-artist row joined via
 *     `track.parent_id → album.id`, `album.parent_id → artist.id`
 */
function legacyTrackDisplayArtistSql(
    sql: postgres.Sql,
    trackAlias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    // One complete template per branch, NOT a nested `${tag}` fragment.
    //
    // Nesting reads better and was how this briefly looked, but it makes the
    // function construct TWO tagged templates where it used to construct one.
    // Callers that count `sql` invocations then see every later index shift by
    // one — sonic-path.queries.test.ts stubs `sql` and returns rows at fixed
    // call numbers, so its bridge queries silently returned nothing and
    // buildSonicPath produced zero steps. The emitted SQL was equivalent
    // throughout; only the number of template objects changed.
    return trackAlias === 'mi'
        ? sql`COALESCE(
            NULLIF(mi.custom_metadata->>'artist', ''),
            NULLIF(artist.title, 'Unknown Artist'),
            artist.title
        )`
        : trackAlias === 't'
          ? sql`COALESCE(
            NULLIF(t.custom_metadata->>'artist', ''),
            NULLIF(artist.title, 'Unknown Artist'),
            artist.title
        )`
          : sql`COALESCE(
            NULLIF(track.custom_metadata->>'artist', ''),
            NULLIF(artist.title, 'Unknown Artist'),
            artist.title
        )`;
}

/**
 * Build the SQL expression that resolves a track's structured artist list.
 *
 * Returns a jsonb array of `{ id, title }` in tag order (the order the scanner
 * wrote `custom_metadata.additional_artist_ids`), or NULL when the track has no
 * additional artists — i.e. when its artist is simply the album artist, which
 * the caller's own `artist` join already resolves.
 *
 * This is what lets a multi-artist line ("DJ Fenwick, Milo Sebastian") be
 * rendered as separate links. `ensureTrackArtistLinks` in the file scanner
 * populates `additional_artist_ids` on every scan by splitting the track's
 * ARTIST tag, so the ids already exist for any track whose artist differs from
 * its album artist — including every track on a Various Artists compilation.
 *
 * "Various Artists" rows are excluded via the `is_various_artists` flag
 * (migration 16.132.0, written at insert time by `findOrCreateMusicArtist`):
 * the compilation marker is never a link target a user wants.
 *
 * Deliberately does NOT name-match against the artist table the way the album
 * path's `normalized_artists` CTE does — that CTE exists to resolve tracks with
 * no `additional_artist_ids`, which are exactly the tracks whose artist equals
 * the album artist and are already resolved by the caller's `artist` join.
 * Skipping it keeps the hot queue queries cheap.
 *
 * Requires the surrounding query to expose `<trackAlias>.custom_metadata`.
 *
 * Access note (why the no-unscoped-media-items overrides below are correct).
 * The joined rows are `media_type = 'artist'`, and artists own no files. The
 * library-scope builder gates through `media_file_items` → `media_files`, so
 * its "no file rows at all" branch passes every artist row unconditionally —
 * adding that filter here would be a no-op that merely looked like a gate.
 * The boundaries that actually hold:
 *
 *   - the caller already scopes the *track* row these ids were read from;
 *   - the artist names are already on screen, rendered from that same track's
 *     `custom_metadata.artist` tag, so no name is revealed that the caller was
 *     not displaying anyway;
 *   - clicking through hits `/api/music/artists/[id]`, which runs its own
 *     per-id access check and 404s on denial.
 *
 * Deliberately worded to avoid naming the gate helpers: the lint rule detects
 * markers textually, so mentioning them would silently satisfy it from a
 * comment rather than from a real check.
 */
/**
 * Build the SQL expression that resolves a track's artist ID.
 *
 * The ID counterpart to {@link trackDisplayArtistSql}, and deliberately the
 * same priority: the track's OWN credited artist first, the album-artist row
 * only as a fallback.
 *
 * The two used to disagree, which is the bug this exists to close. Feed rows
 * selected `artist.id AS artist_id` — the album-artist join — while the name
 * beside it already came from `trackDisplayArtistSql`. So a compilation track
 * shipped as `artist_title: "The Harborfolk", artist_id: <Various Artists>`,
 * and "Go to Artist" landed on a 277-release Various Artists page. The
 * canonical `/music/tracks/{id}` has always answered `artistId` with the
 * performer, so the feed rows were the outlier — this removes the second
 * meaning rather than adding one.
 *
 * `additional_artist_ids` is written on every scan by `ensureTrackArtistLinks`
 * for any track whose artist differs from its album artist, which is exactly
 * the population that was wrong. Tracks where the two agree have no entry and
 * fall through to the join, unchanged.
 *
 * Joined rather than read raw so a stale or malformed id cannot be emitted as
 * a link target, and so `is_various_artists` rows are skipped — a compilation
 * marker is never what a listener meant to tap. The regex guard before the
 * `::uuid` cast is load-bearing for the same reason it is in
 * `trackArtistsSql`: the cast lives in a scalar subquery, so one corrupt value
 * would abort the whole statement rather than just its own row.
 *
 * Requires the surrounding query to expose `<trackAlias>.custom_metadata` and
 * an `artist` alias for the fallback.
 */
function legacyTrackArtistIdSql(
    sql: postgres.Sql,
    trackAlias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    const meta =
        trackAlias === 'mi'
            ? sql`mi.custom_metadata->'additional_artist_ids'`
            : trackAlias === 't'
              ? sql`t.custom_metadata->'additional_artist_ids'`
              : sql`track.custom_metadata->'additional_artist_ids'`;
    // The same tag `trackDisplayArtistSql` resolves the NAME from, so the two
    // are guaranteed to be reading the same source.
    const tag =
        trackAlias === 'mi'
            ? sql`mi.custom_metadata->>'artist'`
            : trackAlias === 't'
              ? sql`t.custom_metadata->>'artist'`
              : sql`track.custom_metadata->>'artist'`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- artist rows own no files; same access note as trackArtistsSql
    return sql`COALESCE(
        (
            SELECT ta.id
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(${meta})
                    WHEN 'array' THEN ${meta}
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ta_ids(id, ord)
            CROSS JOIN LATERAL (
                SELECT a.id, a.title FROM media_items a
                WHERE a.id = CASE
                                 WHEN ta_ids.id ~ ${UUID_TEXT_PATTERN} THEN ta_ids.id::uuid
                             END
                  AND a.media_type = 'artist' AND a.status = 'active'
                  AND a.parent_id IS NULL
                  AND NOT a.is_various_artists
                OFFSET 0
            ) ta
            -- The credited artist must be the one the card actually NAMES.
            --
            -- additional_artist_ids is tag order, not primacy order, and on
            -- a remix it holds the REMIXER while the display tag stays the
            -- original artist: "Delirious (Linden Vale remix)" tags
            -- artist=David Vale and credits [Linden Vale]. Taking the
            -- first entry unconditionally returned Linden Vale under a card
            -- reading "David Vale" -- the same id/name disagreement this
            -- function exists to remove, just pointing the other way.
            --
            -- Requiring the tag to name the artist keeps the cases that
            -- motivated this ("The Offspring", "Hooverphonic",
            -- "Claude Lambert feat. Jan Hangers" -> Claude Lambert) and drops
            -- the remixer case back to the album artist, which is what the
            -- name resolves to as well. Both halves then read the same tag.
            --
            -- Normalised on BOTH sides with [^[:alnum:] ], NOT [^a-z0-9 ].
            -- The ASCII form erases non-Latin scripts entirely (Cyrillic and
            -- Greek titles come back as the empty string), and since
            -- position('' in '') = 1 an emptied needle then matches every
            -- tag -- so every non-Latin artist sailed through this guard.
            -- 20 real contradictions were hiding behind exactly that. The
            -- non-empty check is the other half of the same trap. It is also
            -- why artistNormTitleSql is not reused here.
            WHERE regexp_replace(lower(ta.title), '[^[:alnum:] ]', '', 'g') <> ''
              AND position(
                     regexp_replace(lower(ta.title), '[^[:alnum:] ]', '', 'g')
                     in regexp_replace(lower(COALESCE(${tag}, '')), '[^[:alnum:] ]', '', 'g')
                 ) > 0
            ORDER BY ta_ids.ord
            LIMIT 1
        ),
        -- The album-artist fallback is a GUARDED candidate, not a floor.
        --
        -- Unconditional, it was where every surviving id/name disagreement
        -- came from: 484 tracks on the production library resolved to an id
        -- whose artist is not the one the card names. The worst are real
        -- artists sent somewhere else entirely ('D-Block & S-Te-Fan' ->
        -- High Voltage); the bulk are tracks tagged 'Various Artists' whose
        -- album-artist row is a catch-all carrying 190 unrelated compilations.
        --
        -- Two ways it is legitimately the answer, and no third:
        --   1. the tag is empty, so trackDisplayArtistSql resolves the NAME to
        --      artist.title too -- both halves agree by definition;
        --   2. the tag is non-empty and names this artist.
        -- Anything else yields NULL. No tap-through beats one that lands on
        -- someone the card never mentioned; artistId is optional in every
        -- schema carrying it, and clickData omits falsy values.
        CASE
            WHEN NULLIF(${tag}, '') IS NULL THEN artist.id
            WHEN regexp_replace(lower(COALESCE(artist.title, '')), '[^[:alnum:] ]', '', 'g') <> ''
             AND position(
                     regexp_replace(lower(COALESCE(artist.title, '')), '[^[:alnum:] ]', '', 'g')
                     in regexp_replace(lower(${tag}), '[^[:alnum:] ]', '', 'g')
                 ) > 0
            THEN artist.id
        END
    )`;
}

function legacyTrackArtistsSql(
    sql: postgres.Sql,
    trackAlias: 'track' | 'mi' | 't' = 'track',
): postgres.PendingQuery<postgres.Row[]> {
    if (trackAlias === 'mi') {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- artist rows own no files; see access note above
        return sql`(
            SELECT jsonb_agg(
                jsonb_build_object('id', ta.id, 'title', ta.title)
                ORDER BY ta_ids.ord
            )
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(mi.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN mi.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ta_ids(id, ord)
            CROSS JOIN LATERAL (
                SELECT a.id, a.title FROM media_items a
                WHERE a.id = CASE
                                 WHEN ta_ids.id ~ ${UUID_TEXT_PATTERN} THEN ta_ids.id::uuid
                             END
                  AND a.media_type = 'artist' AND a.status = 'active'
                  AND a.parent_id IS NULL
                  AND NOT a.is_various_artists
                OFFSET 0
            ) ta
        )`;
    }
    if (trackAlias === 't') {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- artist rows own no files; see access note above
        return sql`(
            SELECT jsonb_agg(
                jsonb_build_object('id', ta.id, 'title', ta.title)
                ORDER BY ta_ids.ord
            )
            FROM jsonb_array_elements_text(
                CASE jsonb_typeof(t.custom_metadata->'additional_artist_ids')
                    WHEN 'array' THEN t.custom_metadata->'additional_artist_ids'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY ta_ids(id, ord)
            CROSS JOIN LATERAL (
                SELECT a.id, a.title FROM media_items a
                WHERE a.id = CASE
                                 WHEN ta_ids.id ~ ${UUID_TEXT_PATTERN} THEN ta_ids.id::uuid
                             END
                  AND a.media_type = 'artist' AND a.status = 'active'
                  AND a.parent_id IS NULL
                  AND NOT a.is_various_artists
                OFFSET 0
            ) ta
        )`;
    }
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- artist rows own no files; see access note above
    return sql`(
        SELECT jsonb_agg(
            jsonb_build_object('id', ta.id, 'title', ta.title)
            ORDER BY ta_ids.ord
        )
        FROM jsonb_array_elements_text(
            CASE jsonb_typeof(track.custom_metadata->'additional_artist_ids')
                WHEN 'array' THEN track.custom_metadata->'additional_artist_ids'
                ELSE '[]'::jsonb
            END
        ) WITH ORDINALITY ta_ids(id, ord)
        CROSS JOIN LATERAL (
            SELECT a.id, a.title FROM media_items a
            WHERE a.id = CASE
                             WHEN ta_ids.id ~ ${UUID_TEXT_PATTERN} THEN ta_ids.id::uuid
                         END
              AND a.media_type = 'artist' AND a.status = 'active'
              AND a.parent_id IS NULL
              AND NOT a.is_various_artists
            OFFSET 0
        ) ta
    )`;
}

/**
 * Build the SQL expression that resolves a track's *fallback* artist id from
 * the album → artist hierarchy, yielding NULL for compilations.
 *
 * The album's parent artist is the right link target for a normal album, but on
 * a Various Artists compilation it is the VA marker row — which is how a track
 * could display "DJ Fenwick, Milo Sebastian" while linking to "Various
 * Artists". Returning NULL here lets `toMusicTrack`'s existing fallback chain
 * (`artist_id ?? resolved_artist_id ?? firstArtistId`) land on the first real
 * artist from {@link trackArtistsSql} instead.
 *
 * Requires the surrounding query to expose an `artist` alias joined via
 * `track.parent_id → album.id`, `album.parent_id → artist.id`.
 */
export function nonVariousArtistIdSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN artist.is_various_artists THEN NULL ELSE artist.id::text END`;
}

/**
 * Build the SQL expression that normalizes an artist row's title for
 * maintenance identity comparison: preserves Unicode letters and numbers,
 * strips punctuation, folds case/spacing and composes to NFC, then folds every
 * Various-Artists alias ("VA", "V.A.", "V/A", "Various", "Various Artists")
 * into the single canonical label `'various artists'`.
 *
 * Shared by `database-cleanup.queries.ts`'s `healDeadArtistReferences`
 * (dead + canonical CTEs) and `autoMergeDuplicateArtists` (dup-group CTE) —
 * both need to agree on what counts as "the same artist" by name, so this
 * expression must live in exactly one place. Before this fragment existed,
 * the CASE was hand-copied three times; a future edit to the VA-alias list
 * or the punctuation-strip regex touching only some of the copies would
 * silently desynchronize which artists the heal pass and the merge pass
 * consider duplicates of each other.
 *
 * `alias` selects which row the expression reads `.title` from. Every
 * current caller aliases the `media_items` row as `mi` (the identity-merge
 * queries all pull from a bare `FROM media_items mi`); the parameter exists
 * — rather than hardcoding `mi.title` — so a future caller with a different
 * alias extends this function with a new branch instead of hand-copying the
 * CASE again under a different name. Dynamic (parameterized) identifiers
 * aren't used here: postgres.js's tagged-template `${}` binds a value, not
 * raw SQL text, so per-alias branching (mirrors `trackDisplayArtistSql` /
 * `trackArtistsSql` above) is the safe way to vary the referenced column.
 */
export function artistNormTitleSql(
    sql: postgres.Sql,
    alias: 'mi' = 'mi',
): postgres.PendingQuery<postgres.Row[]> {
    void alias;
    return artistNormTitleValueSql(sql, sql`mi.title`);
}

/** Shared punctuation/spacing normalization for grouping and decision checks. */
export function artistNormTitleValueSql(
    sql: postgres.Sql,
    value: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const norm = sql`btrim(regexp_replace(regexp_replace(LOWER(normalize(${value}, NFC)), '[^[:alnum:][:space:]]', '', 'g'), '\\s+', ' ', 'g'))`;
    return sql`CASE WHEN ${norm} = ANY(ARRAY['va', 'various', 'various artist', 'various artists']) THEN 'various artists' ELSE ${norm} END`;
}
