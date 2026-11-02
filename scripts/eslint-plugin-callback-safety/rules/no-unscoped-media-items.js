// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: no-unscoped-media-items
 *
 * Flags any `sql`...`` tagged template literal that reads from or joins
 * `media_items` unless the file contains a RUNNABLE reference to one of the
 * canonical access-filter helpers. (Scope note: the check is FILE-scoped,
 * not function-scoped — one gated function vouches for the whole module.
 * Naming a helper in a comment, a string, a type, or an unused import does
 * NOT count; see `hasAccessMarkerInFile`.) This is the rule that
 * would have caught the 50+ access-gate gaps we fixed across the
 * security campaign (commits 6db0a1e2a through 2c26c59be).
 *
 * The bug shape: a route or query joins media_items and returns title /
 * internal_id / poster URL / overview / ratings to the caller without
 * filtering by the caller's library group or age policy. A restricted
 * user receives metadata for content they cannot otherwise browse.
 *
 * Accepted access-marker tokens (any one is enough — the rule cannot
 * tell semantic correctness, only that an access check is present):
 *   - `buildLibraryAccessFilter`           (SQL fragment)
 *   - `buildAgeRatingFilter`               (SQL fragment)
 *   - `checkMediaAccess`                   (single-id gate)
 *   - `withMediaAccess`                    (route middleware)
 *   - `withAgeGate`                        (route middleware)
 *   - `filterAccessibleMediaIds`           (batch helper)
 *   - `filterAccessibleRows`               (batch helper)
 *   - `isMediaAccessible`                  (legacy library-only — discouraged but accepted)
 *   - `buildSearchAccessContext`           (context builder; co-occurring tokens implied)
 *   - `accessibleMedia`                    (future canonical primitive, reserved)
 *
 * Scope: routes, query modules, and services. Exempt: migrations, the
 * access primitives themselves, scanner/pipeline tasks that operate on
 * the full catalog by design, integration tests, and admin-only paths.
 *
 * Override per-line:
 *   // eslint-disable-next-line callback-safety/no-unscoped-media-items
 *
 * @see docs/dev/eslint-exceptions.md (section 7, "Unscoped `media_items` Queries")
 */

// Files under these path fragments are checked.
const APPLICABLE_PATH_FRAGMENTS = [
    '/src/routes/',
    '/src/lib/server/database/queries/',
    '/src/lib/server/services/',
    '/src/lib/server/api/defs/',
];

// Files that are themselves access primitives, scanner/pipeline code that
// MUST read all rows, migrations, tests, or admin-only paths.
const EXEMPT_PATH_FRAGMENTS = [
    '.test.ts',
    '.spec.ts',
    '.integration.test.ts',
    '/migrations/',
    // Access primitive sources
    '/src/lib/server/middleware/media-access.ts',
    '/src/lib/server/middleware/library-access.ts',
    '/src/lib/server/utils/media-access-batch.ts',
    '/src/lib/server/utils/resolve-and-gate.ts',
    '/src/lib/server/utils/search-access-context.ts',
    '/src/lib/server/cache/library-group-permissions-cache.ts',
    '/src/lib/server/database/queries/builders/library-access.builder.ts',
    '/src/lib/server/database/queries/builders/age-rating.builder.ts',
    // Catalog mutation operations and scanner-style queries that own the
    // full media_items lifecycle.
    '/src/lib/server/database/queries/catalog-operations.queries.ts',
    '/src/lib/server/database/queries/media-upsert.ts',
    '/src/lib/server/database/queries/media-queries.ts',
    '/src/lib/server/database/queries/external-ids.queries.ts',
    '/src/lib/server/database/queries/ai-admin.queries.ts',
    '/src/lib/server/database/queries/ai-sync.queries.ts',
    '/src/lib/server/database/queries/cluster-nodes.queries.ts',
    '/src/lib/server/database/queries/admin-media.queries.ts',
    // The admin media browser's base-population builder and the music-hygiene
    // predicates/counts, split out of admin-media.queries.ts above so that the
    // browser's list and the badge counts taken for its deep links are over one
    // population. Same category as the file they came from: pure SQL, `sql` as
    // the first parameter, no user context to gate on, and reachable only from
    // /admin/** routes that already require an admin.
    '/src/lib/server/database/queries/builders/admin-media-scope.builder.ts',
    '/src/lib/server/database/queries/music-hygiene.queries.ts',
    '/src/lib/server/database/queries/integrity.queries.ts',
    '/src/lib/server/database/queries/metadata-aggregation.queries.ts',
    '/src/lib/server/database/queries/resolvers/',
    // Background/scanner services — operate on full catalog
    '/src/lib/server/services/catalog.service.ts',
    '/src/lib/server/services/media-deletion.service.ts',
    '/src/lib/server/services/media-lifecycle.service.ts',
    '/src/lib/server/services/embedding-operations.service.ts',
    '/src/lib/server/services/jellyfin-sync.service.ts',
    '/src/lib/server/services/suggestion-engine.service.ts',
    '/src/lib/server/services/personal-stats.service.ts',
    '/src/lib/server/services/playback-analytics.service.ts',
    // Admin-only routes
    '/src/routes/admin/',
    '/src/routes/api/admin/',
    // Admin-only API defs (2026-09-18, C3 fix-plan-4; corrected 2026-09-18
    // TWICE after review — see both corrections below before trusting any
    // number in this comment). 176 files under this path (excl. `.test.ts`).
    // 174 of them call `defineEndpoint(` exactly once each (verified: zero
    // files call it twice, zero call it zero times among the 174); the other
    // 2 (`admin/fix/disk-pressure-attention.ts`, `admin/trigger-type.ts`)
    // call it not at all — one is an unwired adapter, the other a shared
    // type/validation helper, neither reachable as a route.
    //
    // Second correction: a naive `grep -hoE "auth:\s*\{[^}]*\}"` sweep is
    // COMMENT-BLIND and over-counted at 176 by picking up two `auth: {...}`
    // strings that are prose, not code — a doc comment in
    // `admin/media/search.ts` and a file-header JSDoc in
    // `admin/plugins/external/install.ts`, neither a second `defineEndpoint`.
    // Swept instead by stripping `//` and `/* */` comments (and string/
    // template-literal bodies, so a comment-like sequence INSIDE a string
    // cannot be mistaken for a real comment either) before matching, and by
    // anchoring the auth-stanza count against the verified 174
    // `defineEndpoint(` calls rather than trusting the regex alone:
    //   node -e "
    //     const {readdirSync,readFileSync,statSync}=require('fs');
    //     const {join}=require('path');
    //     const root='src/lib/server/api/defs/admin';
    //     function walk(d){let o=[];for(const e of readdirSync(d)){const p=join(d,e);
    //       const s=statSync(p);if(s.isDirectory())o=o.concat(walk(p));
    //       else if(e.endsWith('.ts')&&!e.endsWith('.test.ts'))o.push(p);}return o;}
    //     function strip(src){let out='',i=0,inStr=null;while(i<src.length){
    //       const c=src[i],c2=src[i+1];
    //       if(inStr){out+=c;if(c==='\\\\'){out+=src[i+1]??'';i+=2;continue;}
    //         if(c===inStr)inStr=null;i++;continue;}
    //       if(c===\"'\"||c==='\"'||c==='\`'){inStr=c;out+=c;i++;continue;}
    //       if(c==='/'&&c2==='/'){while(i<src.length&&src[i]!=='\\n')i++;continue;}
    //       if(c==='/'&&c2==='*'){i+=2;while(i<src.length&&!(src[i]==='*'&&src[i+1]==='/'))i++;i+=2;continue;}
    //       out+=c;i++;}return out;}
    //     const files=walk(root);let defs=0;const auth=new Map();
    //     for(const f of files){const clean=strip(readFileSync(f,'utf8'));
    //       defs+=(clean.match(/\\bdefineEndpoint\\s*\\(/g)||[]).length;
    //       for(const m of clean.matchAll(/auth:\\s*(\\{[^}]*\\}|'[^']*'|\"[^\"]*\")/g)){
    //         const k=m[1].replace(/\\s+/g,'');auth.set(k,(auth.get(k)||0)+1);}}
    //     console.log('defineEndpoint(:',defs);
    //     console.log([...auth.entries()].sort((a,b)=>b[1]-a[1]));
    //   "
    // Result: 174 `defineEndpoint(` calls (one per file, matching the 174
    // route files above), and 193 `auth:` occurrences of which only 174 are
    // enforcement stanzas — ten shapes:
    //   130  { kind: 'admin' }
    //    12  { kind: 'scope', anyOf: ['library:admin'] }
    //    11  { kind: 'scope', anyOf: ['users:admin'] }
    //     9  { kind: 'scope', anyOf: ['tasks:admin'] }
    //     5  { kind: 'scope', anyOf: ['library:admin', 'admin'] }
    //     2  { kind: 'scope', anyOf: ['tokens:admin'] }
    //     2  { kind: 'scope', anyOf: ['metrics:read', 'admin'] }
    //     1  { kind: 'scope', anyOf: ['providers:admin'] }
    //     1  { kind: 'scope', anyOf: ['playback:admin', 'admin'] }
    //     1  { kind: 'scope', anyOf: ['access:admin'] }
    // (130+12+11+9+5+2+2+1+1+1 = 174.) The remaining 19 `auth:` occurrences
    // (18 × `auth: 'bearer'`, 1 × `auth: 'none'`) are `docs:` OpenAPI
    // metadata sitting next to `tags`/`summary`/`stability` inside a def's
    // documentation block — NOT the enforcement stanza, and on the one file
    // with `auth: 'none'` (`admin/ingest/stream/index.ts:103`) the real
    // enforcement stanza is `{ kind: 'admin' }` at `:89`. A def's OpenAPI
    // `docs:` block can say something different from its `auth:` gate — see
    // `reference_def_header_lies_about_v1_mount` — so re-running the command
    // above and trusting its RAW count without filtering to the 174 real
    // stanzas reproduces this exact false-176 mistake.
    //
    // None of this rests on matching one of ten literal stanza shapes either
    // — it rests on `isAdminClassScope()` (`src/lib/server/api/principal.ts:333`:
    // `scope === 'admin' || scope.endsWith(':admin')`), the SINGLE
    // "is this scope admin-class?" predicate shared by `stripAdminScopes`
    // (strip time) and `token-minting.ts`'s mint ceiling (mint time, see
    // `token-minting.ts:35,51,111`) since the 2026-09-15 security-review
    // collapse. Every `<area>:admin` literal above is therefore only
    // satisfiable by a principal that already holds an admin-class scope:
    // session/forward-auth resolves admin via `sessionIsAdmin`; a PAT/
    // service token additionally requires `ownerIsAdmin`, and
    // `patScopeSchema` (`src/lib/schemas/admin.ts:145`) /
    // `serviceTokenScopeSchema` (`:422`) do not let a token mint a
    // fine-grained `<area>:admin` scope directly — only the coarse `admin`
    // alias, which `expandScopes` (gate at `principal.ts:228`) then fans out
    // into every `<area>:admin` scope. The one stanza shape that is NOT
    // admin-shaped by name — `metrics:read` (`admin/ops/system-metrics.ts`,
    // `admin/ops/lock-metrics.ts`, both `anyOf: ['metrics:read', 'admin']`)
    // — is still admin-only in practice: `expandScopes` adds `metrics:read`
    // ONLY inside the branches gated on `out.has('admin')` or
    // `out.has('tasks:admin')` (`principal.ts:256`, `:306`), and it is not
    // independently mintable via either scope schema. `grep -c media_items`
    // on both ops files returns 0, so this is a documentation-precision gap,
    // not a live hole.
    //
    // If a future def under this path has an `auth.kind` other than
    // `'admin'` or `'scope'`, it is NOT covered — pull it out and triage it
    // on its own. If its `auth.kind` IS `'scope'`, the test is UNIVERSAL, not
    // existential: `anyOf` is disjunctive (`mount.ts:186`,
    // `spec.anyOf.some(...)`), so a caller needs only ONE listed scope to
    // pass — `anyOf: ['read', 'admin']` would be satisfied by a plain `read`
    // PAT and must NOT be treated as covered by this exemption just because
    // `'admin'` also appears in the array. The correct check is: EVERY entry
    // in `scope.anyOf` is admin-class (`=== 'admin'` or `.endsWith(':admin')`)
    // or is the whitelisted `'metrics:read'` exception above — if even one
    // entry fails that, the def is not covered, pull it out and triage it on
    // its own. Do not widen this comment to cover a new shape by assumption;
    // re-run the sweep above and re-verify against `isAdminClassScope` first.
    '/src/lib/server/api/defs/admin/',
    // ─────────────────────────────────────────────────────────────────────
    // Pure data-layer query modules + background/admin services (2026-06-05).
    //
    // These were audited individually while bringing lint:typed to green.
    // Every one falls into a category the rule already exempts elsewhere but
    // that the original curated list had not yet enumerated:
    //
    //   • Query modules under queries/ are the pure-SQL data tier. They take
    //     `sql` as their first parameter and have NO user context to gate on;
    //     the access decision is enforced by the *calling* route/service
    //     (verified: media-details→checkMediaAccess, social-activity→
    //     checkMediaAccess, genre-recommendations→filterAccessibleMediaIds,
    //     series episodes→withMediaAccess, etc.). This matches the documented
    //     three-tier architecture (CLAUDE.md): queries never gate, routes do.
    //   • Background / sync-plugin / metadata / pipeline / livetv / trickplay /
    //     embedding / file-infrastructure code operates on the full catalog
    //     by design — same rationale as the catalog/scanner entries above.
    //   • media-id-resolver is itself an *upstream* of the access primitives
    //     (it translates any id format to an internal UUID; gating runs after).
    //
    // If you add a NEW user-facing query that returns media metadata directly
    // to an un-gated caller, do NOT add it here — gate it.
    '/src/lib/server/database/queries/admin-stats.queries.ts',
    '/src/lib/server/database/queries/album-art.queries.ts',
    '/src/lib/server/database/queries/album-local-art.queries.ts',
    '/src/lib/server/database/queries/album-enrichment.queries.ts',
    '/src/lib/server/database/queries/artist-enrichment.queries.ts',
    '/src/lib/server/database/queries/artist-merge.queries.ts',
    '/src/lib/server/database/queries/attention.queries.ts',
    '/src/lib/server/database/queries/availability.queries.ts',
    '/src/lib/server/database/queries/builders/library-group.builder.ts',
    '/src/lib/server/database/queries/builders/search-filter.builder.ts',
    '/src/lib/server/database/queries/coverage-grid.queries.ts',
    '/src/lib/server/database/queries/database-cleanup.queries.ts',
    '/src/lib/server/database/queries/embedding-operations.queries.ts',
    '/src/lib/server/database/queries/embedding-stats.queries.ts',
    '/src/lib/server/database/queries/embeddings.queries.ts',
    '/src/lib/server/database/queries/episode-chapters.queries.ts',
    '/src/lib/server/database/queries/episode-detail.queries.ts',
    '/src/lib/server/database/queries/episode-orderings.queries.ts',
    '/src/lib/server/database/queries/episode-reorder.queries.ts',
    '/src/lib/server/database/queries/episode-reconciliation.queries.ts',
    '/src/lib/server/database/queries/external-subtitles.queries.ts',
    '/src/lib/server/database/queries/file-rematch.queries.ts',
    '/src/lib/server/database/queries/genre-recommendations.queries.ts',
    '/src/lib/server/database/queries/group-provider-config.queries.ts',
    '/src/lib/server/database/queries/image-sync.queries.ts',
    '/src/lib/server/database/queries/intro-analysis.queries.ts',
    '/src/lib/server/database/queries/jellyfin-item-detail.queries.ts',
    '/src/lib/server/database/queries/livetv-channels.queries.ts',
    '/src/lib/server/database/queries/livetv-programs.queries.ts',
    '/src/lib/server/database/queries/livetv-setup.queries.ts',
    '/src/lib/server/database/queries/media-artwork.queries.ts',
    '/src/lib/server/database/queries/media-details.queries.ts',
    '/src/lib/server/database/queries/media-external-groupings.queries.ts',
    '/src/lib/server/database/queries/media-files.queries.ts',
    '/src/lib/server/database/queries/media-hierarchy.queries.ts',
    '/src/lib/server/database/queries/media-items.queries.ts',
    '/src/lib/server/database/queries/media-segment-candidates.queries.ts',
    // Selects the blackframe-fingerprinted Outros for the one-shot repair
    // pass. Joins media_items only to scope the predicate to episodes and to
    // reach the season for the cohort step; it returns detector arithmetic
    // (segment id, timings, file duration), never user-facing metadata, and
    // its only caller is a background task with no user context to gate on.
    '/src/lib/server/database/queries/media-segment-repair.queries.ts',
    '/src/lib/server/database/queries/media-segments.queries.ts',
    '/src/lib/server/database/queries/media-type-cache.queries.ts',
    '/src/lib/server/database/queries/music-admin.queries.ts',
    '/src/lib/server/database/queries/music-analysis.queries.ts',
    '/src/lib/server/database/queries/play-sessions.queries.ts',
    '/src/lib/server/database/queries/playlist-items.queries.ts',
    '/src/lib/server/database/queries/popularity.queries.ts',
    '/src/lib/server/database/queries/provider-preference.queries.ts',
    '/src/lib/server/database/queries/season-detail.queries.ts',
    '/src/lib/server/database/queries/series-health.queries.ts',
    '/src/lib/server/database/queries/social-activity.queries.ts',
    '/src/lib/server/database/queries/suggestion-engine.queries.ts',
    '/src/lib/server/database/queries/suggestion-management.queries.ts',
    '/src/lib/server/database/queries/system-status.queries.ts',
    '/src/lib/server/database/queries/trickplay-params.queries.ts',
    '/src/lib/server/database/queries/trickplay.queries.ts',
    '/src/lib/server/database/queries/user-media-flags.queries.ts',
    '/src/lib/server/database/queries/user-watch-history.queries.ts',
    '/src/lib/server/database/queries/watch-history-insert.queries.ts',
    '/src/lib/server/database/queries/watch-history.queries.ts',
    '/src/lib/server/database/queries/watch-status.queries.ts',
    '/src/lib/server/database/queries/watchlist.queries.ts',
    '/src/lib/server/services/auto-identify.service.ts',
    '/src/lib/server/services/availability.service.ts',
    '/src/lib/server/services/chapter-sync.service.ts',
    '/src/lib/server/services/dismiss.service.ts',
    '/src/lib/server/services/image-proxy/providers/tmdb.provider.ts',
    '/src/lib/server/services/image-proxy/service.ts',
    '/src/lib/server/services/library-backdrop.service.ts',
    '/src/lib/server/services/media-id-resolver.ts',
    '/src/lib/server/services/metadata-sync-single.service.ts',
    '/src/lib/server/services/new-episodes.service.ts',
    '/src/lib/server/services/play-sessions.service.ts',
    '/src/lib/server/services/provider-artwork-materialization.service.ts',
    '/src/lib/server/services/series-health.service.ts',
    '/src/lib/server/services/stage-state.service.ts',
    '/src/lib/server/services/video-frame-extractor.service.ts',
    '/src/lib/server/services/watch-sync-engine.service.ts',
];

// Tokens that mark an access decision was made in the file. ANY one of
// these appearing as a real identifier IN VALUE POSITION is enough — the
// rule is high-recall, not semantically perfect. The presence of an
// access-aware parameter name (`deniedGroupIds`, `ageRating`) counts
// because it shows the author wired the access plumbing through, even if
// they routed it through a locally-named filter helper.
//
// A token does NOT count when it appears only in: a comment, a string
// body, type syntax, or an unused import binding. See
// `hasAccessMarkerInFile` for why each of those is inert.
const ACCESS_MARKER_TOKENS = [
    // Canonical SQL fragment builders
    'buildLibraryAccessFilter',
    'buildAgeRatingFilter',
    // Single-item gate helpers
    'checkMediaAccess',
    'withMediaAccess',
    'withAgeGate',
    'isMediaAccessible',
    // Batch helpers
    'filterAccessibleMediaIds',
    'filterAccessibleRows',
    // Context + write-side primitives
    'buildSearchAccessContext',
    'accessibleMedia',
    'resolveAndGate',
    'MediaAccessDeniedError',
    // Parameter names indicating access plumbing was threaded through —
    // catches locally-defined helpers like `buildEpisodeLibraryFilter`
    // that take the same shape but don't share the canonical name.
    'deniedGroupIds',
    'ageRating',
    // Lower-level cache primitives some files use directly (typically
    // Jellyfin compat / library-aggregation routes). Their presence means
    // the file knows about the access boundary even if it doesn't route
    // through the standard sql-fragment helpers.
    'getDeniedLibraryGroups',
    'toLibraryAccessUser',
    // Route-level admin gates. An admin-gated route is by policy allowed
    // to read every media row; the access boundary is enforced at the
    // wrapper, not inside the SQL.
    'requireAdmin',
    'requireSelfOrAdmin',
];

// Regex matching SQL that reads from or joins media_items. Accepts an
// optional `schema.` qualifier and optional surrounding double-quotes
// to cover Postgres-quoted identifier forms. Word-boundary anchored on
// the trailing side to avoid matching e.g. `media_items_view`.
const MEDIA_ITEMS_SQL = /\b(?:from|join)\s+(?:[\w$]+\.)?"?media_items"?\b/i;

// ── Type-vs-value classification for the marker walk ────────────────────
// A marker only proves a gate exists if it can RUN. Everything below marks
// the positions where an identifier is erased at compile time (so it cannot
// enforce anything) or is a bare import binding (so nothing calls it).

// Nodes whose entire subtree is type syntax.
const TYPE_ONLY_NODES = new Set([
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'TSDeclareFunction',
    'TSIndexSignature',
    'TSPropertySignature',
    'TSMethodSignature',
    'TSTypeLiteral',
    'TSTypeReference',
    'TSQualifiedName',
    'TSTypeOperator',
    'TSTypePredicate',
    'TSMappedType',
    'TSConditionalType',
    'TSFunctionType',
    'TSConstructorType',
    'TSUnionType',
    'TSIntersectionType',
    'TSArrayType',
    'TSTupleType',
    'TSIndexedAccessType',
    'TSLiteralType',
    'TSTypeQuery',
    'TSImportType',
    'TSInferType',
    'TSOptionalType',
    'TSRestType',
    'TSNamedTupleMember',
    'TSTemplateLiteralType',
]);

// Child KEYS that hold type syntax on nodes that also hold real values.
// Keyed per-property on purpose: `TSAsExpression` and a generic call both
// carry live code alongside their type, so a whole-node test would wrongly
// erase the code. See the note on `visit`.
const TYPE_POSITION_KEYS = new Set([
    'typeAnnotation',
    'typeParameters',
    'typeArguments',
    'returnType',
    'constraint',
    'superTypeArguments',
    'typeParameterInstantiation',
]);

// An identifier here is only a name being bound/re-exported. The USE, if
// there is one, appears elsewhere in the file and is what counts.
const IMPORT_BINDING_NODES = new Set([
    'ImportSpecifier',
    'ImportDefaultSpecifier',
    'ImportNamespaceSpecifier',
    'ExportSpecifier',
]);

/**
 * Positions where a marker NAME appears but no access decision can occur.
 *
 * The same family as the type-only and unused-import exclusions: the token is
 * present, and nothing runs. Measured bypasses that survived the prose fix:
 *
 *   - `const doc = { checkMediaAccess: true };` — a non-computed property KEY is
 *     just a string spelled without quotes. This is the plausible accident: a
 *     marker name used as an options-object key in the same file.
 *   - `function checkMediaAccess() {}` / `class checkMediaAccess {}` /
 *     `enum E { ageRating }` — a DECLARATION of that name. If it is ever called,
 *     the call site is a separate identifier and still counts, so only a dead
 *     declaration is excluded here.
 *   - `checkMediaAccess: for (;;) {}` and `break checkMediaAccess;` — a statement
 *     label shares the identifier namespace with nothing at all.
 *
 * A computed key (`{ [checkMediaAccess]: 1 }`) is a real value read and is NOT
 * excluded.
 */
function isNonEnforcingPosition(node, parent) {
    if (!parent) return false;
    switch (parent.type) {
        case 'Property':
            return parent.key === node && parent.computed !== true;
        case 'FunctionDeclaration':
        case 'ClassDeclaration':
        case 'TSEnumMember':
            return parent.id === node;
        case 'LabeledStatement':
        case 'BreakStatement':
        case 'ContinueStatement':
            return parent.label === node;
        default:
            return false;
    }
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require an access-filter marker when a sql template touches media_items',
            category: 'Possible Errors',
            recommended: true,
        },
        schema: [],
        messages: {
            unscoped:
                'sql template touches `media_items` but no access-gate marker ' +
                '({{markers}}) is referenced anywhere in this file. (The check ' +
                'is file-scoped, and a marker named only in a comment or a ' +
                'string does not count — it must be a real code reference.) ' +
                'Add one of `buildLibraryAccessFilter(sql, deniedGroupIds)` + ' +
                '`buildAgeRatingFilter(sql, ageRating)` to the WHERE, or ' +
                '`checkMediaAccess(sql, id, user)` / `filterAccessibleRows(...)` ' +
                'in this file. Use `// eslint-disable-next-line ' +
                'callback-safety/no-unscoped-media-items` to override when ' +
                'the access decision lives elsewhere (e.g. wrapping middleware).',
        },
    },

    create(context) {
        const filename = context.filename || context.getFilename?.() || '';
        const normalised = filename.replace(/\\/g, '/');

        const isApplicable = APPLICABLE_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (!isApplicable) return {};

        const isExempt = EXEMPT_PATH_FRAGMENTS.some((frag) => normalised.includes(frag));
        if (isExempt) return {};

        // File-scoped marker check: any of the access-marker tokens appearing
        // as a REAL CODE REFERENCE anywhere in the file counts. This handles
        // the common case where a route's SQL lives inside an inner handler
        // but the access decision is at the module-level middleware
        // composition (`withMediaAccess(...)`, `requireAuth(...)`).
        //
        // Trade-off: the check is file-scoped, not function-scoped (despite
        // what the rule name suggests), so one gated function still vouches
        // for its ungated neighbours. The lint is a backstop, not a proof of
        // correctness. It is NOT, however, satisfied by prose — see
        // hasAccessMarkerInFile below.
        let fileMarkerCache = null;

        function flatTemplateText(quasi) {
            // Concatenate quasi.quasis[].value.cooked. Substitution
            // expressions are ignored — `media_items` must appear literally
            // in the SQL, not be smuggled via interpolation.
            return quasi.quasis.map((q) => (q.value && q.value.cooked) || '').join(' '); // single space placeholder between segments
        }

        function hasAccessMarkerInFile() {
            if (fileMarkerCache !== null) return fileMarkerCache;

            // Match against IDENTIFIER NODES IN VALUE POSITION — never against
            // raw source text, and never against type-only or import-only
            // occurrences.
            //
            // This previously ran a `\bTOKEN\b` regex over
            // `sourceCode.getText()`, which is the whole file including
            // comments and string bodies. A doc comment that merely *named*
            // `checkMediaAccess` therefore marked the entire file as gated, so
            // a query module could read `media_items` with no library/age
            // scoping at all and lint stayed green. The rule never complained
            // about itself — the hole only surfaced when the surrounding
            // eslint-disable directives got reported as unused (2026-07-30).
            //
            // Walking the AST closes that, and closes two weaker variants of
            // the same "the name is present but nothing enforces anything"
            // shape that a token-stream check still accepted:
            //   - a TYPE-ONLY mention (`interface O { ageRating: string }`,
            //     `type G = typeof checkMediaAccess`, a return-type reference).
            //     Types are erased at runtime; they gate nothing.
            //   - an IMPORT BINDING with no use (`import { requireAdmin }` and
            //     never called). Dead imports cannot enforce access either.
            // Both are prose with a compiler in front of it. A marker now
            // counts only where it can actually run: a call, a callee passed by
            // reference, a parameter/variable binding, or a property read.
            //
            // Deliberately still accepted, because distinguishing them needs
            // type information this rule does not have: a same-named local that
            // has nothing to do with access (`const ageRating = 1`). The two
            // bare plumbing names `deniedGroupIds` / `ageRating` are the weak
            // end of ACCESS_MARKER_TOKENS generally — they evidence intent, not
            // enforcement. See docs/dev/eslint-exceptions.md.
            //
            // Three further name-without-a-decision shapes are excluded by
            // `isNonEnforcingPosition`: a non-computed object property KEY, a
            // declaration `id`, and a statement label. See its doc comment.
            //
            // One consequence worth knowing: bracket access on a marker
            // (`gates['checkMediaAccess'](…)`) is a string, not an identifier,
            // so it does not count. No call site in the tree uses that form;
            // write the dotted call, or take a line-scoped disable.
            const markers = new Set(ACCESS_MARKER_TOKENS);
            fileMarkerCache = false;
            visit(context.sourceCode.ast, null, false);
            return fileMarkerCache;

            // Walks the AST looking for a marker identifier in a position that
            // can actually enforce something at runtime.
            //
            // `inType` is threaded down rather than derived from the ancestor
            // node types, because several TS nodes mix value and type children:
            // `(await sql`…`) as Row[]` is a TSAsExpression whose `expression`
            // child is live code, and `sql<Row[]>`…`` hangs a real call off a
            // node with `typeArguments`. An ancestor-type test marks those as
            // type-only and reports a file whose gate calls sit inside the
            // cast — measured: 3 false reports in /j/Shows/[seriesId]/Episodes,
            // whose gate calls are real and are wrapped in `as [{count: string}]`.
            // Descending per-KEY keeps value children live.
            function visit(node, parent, inType) {
                if (fileMarkerCache) return;
                if (
                    (node.type === 'Identifier' || node.type === 'JSXIdentifier') &&
                    markers.has(node.name) &&
                    !inType &&
                    !(parent && IMPORT_BINDING_NODES.has(parent.type)) &&
                    !isNonEnforcingPosition(node, parent)
                ) {
                    fileMarkerCache = true;
                    return;
                }
                const childInType = inType || TYPE_ONLY_NODES.has(node.type);
                for (const key of Object.keys(node)) {
                    if (key === 'parent') continue;
                    const nextInType = childInType || TYPE_POSITION_KEYS.has(key);
                    const value = node[key];
                    if (Array.isArray(value)) {
                        for (const child of value) {
                            if (child && typeof child.type === 'string') {
                                visit(child, node, nextInType);
                            }
                        }
                    } else if (value && typeof value.type === 'string') {
                        visit(value, node, nextInType);
                    }
                }
            }
        }

        return {
            TaggedTemplateExpression(node) {
                // Only flag `sql\`...\`` (or `db\`...\``, etc.) — heuristic:
                // tag is an Identifier or MemberExpression. We don't try
                // to verify it's a postgres.js client; tagged-template SQL
                // is the dominant form in this codebase.
                const tag = node.tag;
                const isSqlTag =
                    (tag.type === 'Identifier' &&
                        /^(sql|db|client|sqlClient|tx|trx|transaction)$/i.test(tag.name)) ||
                    (tag.type === 'MemberExpression' &&
                        tag.property &&
                        tag.property.type === 'Identifier' &&
                        /^(sql|unsafe)$/i.test(tag.property.name));
                if (!isSqlTag) return;

                const text = flatTemplateText(node.quasi);
                if (!MEDIA_ITEMS_SQL.test(text)) return;

                if (hasAccessMarkerInFile()) return;

                context.report({
                    node,
                    messageId: 'unscoped',
                    data: { markers: ACCESS_MARKER_TOKENS.join(', ') },
                });
            },
        };
    },
};
