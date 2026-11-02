<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Media-type vocabulary: `tv` vs `series`

**The database stores `tv`. Everything public says `series`. Neither is a
mistake, and you should not "fix" either one.**

If you only read one thing: never hand-convert between them. Call a converter
from [`src/lib/shared/media-type-domain.ts`](../../src/lib/shared/media-type-domain.ts)
and handle the `null` it can return.

## Why there are two words

`media_items.media_type` stores `'tv'`. That token is not arbitrary and not
legacy sloppiness — it mirrors **TMDB's entity namespace**, which is literally
`movie` and `tv` (`/3/tv/{id}`). The same token is a component of the
`external_ids` composite key `(provider, external_id, media_type)`, which keys
rows _against that provider_.

So renaming storage to `series` would make the provider key disagree with the
provider it keys against, and every TMDB call would need a `series → tv` map on
the way out. That is strictly worse than the current split, and it is why the
storage token stays `tv`.

The **public contract** — the API, the OpenAPI spec, every card the client
renders — uses `series`. `tv` is never emitted. Third-party integrators should
never see it.

## Which vocabulary am I in?

`media-type-domain.ts` owns one canonical internal union and an exhaustive
mapping table per outward vocabulary. Pick by where the value is _going_:

| Going to                           | Call                     | `tv` becomes |
| ---------------------------------- | ------------------------ | ------------ |
| The database, or a query filter    | `toInternalMediaType()`  | `tv`         |
| A public API response              | `toPublicMediaType()`    | `series`     |
| A `UniversalMediaItem` card        | `toUniversalMediaType()` | `series`     |
| A `MediaKey` / composite-key token | `toApiMediaType()`       | `series`     |
| A TMDB request or image path       | `toTmdbMediaType()`      | `tv`         |
| An `external_ids` write            | `toProviderMediaType()`  | `tv`         |

Every one of these returns `| null`. **That is the feature, not friction.**
`null` means "this type is not representable in the target vocabulary" —
an audiobook has no TMDB namespace, `UniversalMediaType` has no `season`
member. Decide explicitly: drop the item, or substitute with a stated reason.
The repo's standing precedent is to drop — _a card the client cannot open is
worse than no card_.

Do not write `?? 'movie'` to make the `null` go away. That reintroduces the
exact bug the module was built to delete: audiobooks rendering as movie cards
and offering "Watch Movie".

## When a hand-written conversion IS correct

Some wire contracts carry a **wider** vocabulary than the domain module's public
tables, because they legitimately hold rows the catalog surfaces don't. A
playlist can contain music, so `browserPlaylistItemSchema.type` declares
`'music'`, `'season'` and friends. Running those through `toPublicMediaType()`
would return `null` for `'music'` and silently empty a music playlist's playback
context.

In those places an inline `x === 'tv' ? 'series' : x` is the correct code, and
you'll find it with a comment saying so (see
`src/lib/server/api/defs/playlists/[id]/playback-context.ts`). The same applies
where the value is a closed union that isn't purely media types at all —
`browse/libraries.ts` maps `'movie' | 'tv' | 'mixed'`, and `'mixed'` is not a
media type.

The test is simple: **can the pass-through arm carry a token the destination has
no member for?** If yes, use a converter. If no, inline is fine — say why in a
comment.

## Adding a new media type

The checklist lives next to the code it affects, in the
`media-type-domain.ts` header. Short version: widen the DB CHECK constraint in a
migration, add the value to `INTERNAL_MEDIA_TYPES`, then run `npm run typecheck`
— every mapping table in that file is now a compile error until you decide what
the new type maps to. That forced decision is the entire design.

## How this is enforced

Per the ladder in [silent-default-hazards.md](silent-default-hazards.md#3-the-enforcement-ladder-in-order-of-durability)
(_types > differential tests > lint > docs_), this invariant sits on rung 1:

- **`UniversalMediaType`, `PublicMediaType` and `ApiMediaType` have no `tv`
  member.** Emitting the storage token into a public payload is a compile error.
  This is the load-bearing guard. When `tv` was removed from
  `UniversalMediaTypeSchema`, `tsgo` immediately found six live emitters that no
  reviewer and no lint rule had caught — including a binary fallback that
  labelled every album and audiobook in "Recently added" as a series.
- **Inbound stays tolerant.** Those schemas keep a `coerceLegacyTvToSeries`
  preprocess, so a cached payload or an older client sending `tv` still
  validates and is normalized to `series`. Tolerant on input, strict on output.
- **A unit test parses the DB CHECK constraint** out of `base-schema-sql.ts` and
  asserts set equality with `INTERNAL_MEDIA_TYPES`, so the union cannot drift
  from the database.
- **Lint covers the shapes types can't see** — case conventions
  (`no-bare-media-type-comparison`), dead guards
  (`no-comparator-on-narrowed-media-type`), narrowing casts
  (`no-narrowing-media-type-cast`), fabricated defaults
  (`no-inline-media-type-default`).

### Rejected: a rule banning bare lowercase `'tv'` / `'series'`

This comes up, so it is recorded here rather than re-litigated:

- `no-bare-media-type-comparison` **deliberately** does not flag canonical
  lowercase. Its docblock explains why — the rule is syntactic and cannot tell a
  provably-safe `PublicMediaType` comparison from a risky one, so flagging
  lowercase would bury a `--max-warnings=0` repo in false positives and get the
  rule switched off.
- A narrower variant targeting the pass-through converter
  (`x === 'tv' ? 'series' : x`) was prototyped and measured on 2026-08-04. It hit
  ~24 sites, and essentially all of them were the deliberate, already-commented
  wider-vocabulary cases described above. Forcing two dozen
  `eslint-disable-next-line`s onto correct code degrades the lint signal without
  catching anything.

The conclusion is the ladder's own advice: this belongs on rung 1, and it is
already there. Narrow the schema and let the compiler find the leaks — do not
add a rung-3 backstop for something a type already makes impossible.
