# Developer Guide

Comprehensive reference for Lumastra development patterns, utilities, and best practices.

**Quick Links:**

- 🚀 [Quick Start Guide](./QUICK-START.md) - Commands, setup, testing
- 📖 [Main Project Guide](../CLAUDE.md) - Core architecture and critical rules

## Table of Contents

- [Configuration](#configuration)
- [Authentication](#authentication)
- [Query Modules](#query-modules)
- [Services](#services)
- [Centralized Utilities](#centralized-utilities)
- [Provider-Agnostic Patterns](#provider-agnostic-patterns)
- [Universal Media ID Resolution](#universal-media-id-resolution)
- [Media Query Fragments](#media-query-fragments)
- [Watch History Analytics](#watch-history-analytics)
- [Server-Driven UI Patterns](#server-driven-ui-patterns)
- [Jellyfin Client Formats](#jellyfin-client-formats)
- [Task System](#task-system)
- [Testing Patterns](#testing-patterns)

---

## Configuration

Server configuration with three-tier precedence: JSON settings (admin UI) → environment variables → schema defaults.

### Config Access

```typescript
import { config } from '$lib/server/config';

// All settings available as typed properties
const jellyfin = config.JELLYFIN_SERVER;
const openai = config.OPENAI_API_KEY;

// Feature flags
if (config.FEATURES.REQUESTS) {
    // Enable request modal
}

// Backend-only features (excluded from frontend API)
if (config.FEATURES.WATCH_TOGETHER) {
    // Server-side watch together logic
}
```

### BACKEND_ONLY_FEATURES Pattern

Controls which features are exposed to frontend through the shared server helper for SSR and `/api/v1/server`.

```typescript
// In config.ts
const BACKEND_ONLY_FEATURES = new Set<keyof Features>(['watchTogether']);

// Features in this set are:
// - Available via config.FEATURES.WATCH_TOGETHER on server
// - Excluded from client-facing server features
// - Not included in $page.data.branding.features
```

**Use for**: Server-side-only features, admin-only settings, infrastructure flags.

**Client access**: Use `$page.data?.branding?.features` instead of `config.FEATURES`.

### Feature Flag Levels

Three abstraction levels — use the highest level appropriate for your context:

| Level              | Object                       | Use When                                                       | Example                                                                    |
| ------------------ | ---------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `config.FEATURE_*` | Raw env boolean              | Only in `config.ts` initialization                             | `config.FEATURE_JELLYFIN_SYNC`                                             |
| `features.*`       | Flag + infrastructure check  | In services/routes checking if a feature is available          | `features.jellyfinSync` (checks flag AND `JELLYFINURL` + `JELLYFINAPIKEY`) |
| `operationMode.*`  | Highest-level mode semantics | In routes/components choosing behavior based on operation mode | `operationMode.isJellyfinEnabled`                                          |

**Rule:** Routes and services should use `features.*` or `operationMode.*`, never `config.FEATURE_*` directly (except in config initialization).

```typescript
// ✅ Good — uses features level (checks flag + infrastructure)
import { features } from '$lib/server/config';
if (features.jellyfinSync) { ... }

// ✅ Good — uses operationMode for UI behavior
import { operationMode } from '$lib/server/config';
if (operationMode.isJellyfinEnabled) { ... }

// ❌ Bad — raw env flag, doesn't check infrastructure
if (config.FEATURE_JELLYFIN_SYNC) { ... }
```

---

## Authentication

Three sign-in methods: built-in accounts, OIDC SSO (`AUTH_OIDC_*`) and forward auth from a
trusted reverse proxy (`USERHEADER`/`GROUPHEADER`, opt-in via `FORWARD_AUTH_ENABLED`, honoured
only from `TRUSTED_PROXY_IPS`).
Apps and API clients authenticate with bearer tokens. The permission utilities below work the
same for every method.

### Permission Utilities

```typescript
import {
    buildUserPermissions,
    hasGroupPermission,
    isUserAdmin,
    hasWatchPermissions,
} from '$lib/server/auth';

// Build all permissions from group membership
const permissions = buildUserPermissions(userGroups);
// Returns: {
//   hasWatchPermission: boolean,
//   hasLiveTvPermission: boolean,
//   hasRequestPermission: boolean,
//   isAdmin: boolean,
//   isKidsProfile: boolean
// }

// Check specific permission
if (hasGroupPermission(userGroups, config.ADMIN_GROUPS)) {
    // Admin-only logic
}

// Empty config arrays have special semantics:
// - Empty REQUEST_GROUPS → grants permission to ALL users
```

**Case handling**: All group comparisons are case-insensitive with whitespace trimming.

**Headers** (forward auth only): `USERHEADER` (username), `GROUPHEADER` (comma-separated groups).

---

## Query Modules

Query modules provide pure SQL queries without side effects. All functions take `sql: postgres.Sql` as first parameter.

### Available Query Modules (28+)

| Module                            | Purpose                      | Key Methods                                                        |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `search.queries.ts`               | Full-text & trigram search   | `searchMedia()`, `searchMediaFulltext()`, `searchEpisode()`        |
| `browse.queries.ts`               | Alphabetical browsing        | `getMediaAlphabetical()`, `getAvailableLibraries()`                |
| `media-lookup.queries.ts`         | ID resolution                | `resolveTmdbToUuid()`, `resolveUuidToTmdb()`, `findSeriesByName()` |
| `embeddings.queries.ts`           | Embedding reads              | `getDualEmbedding()`, `getEmbeddingCount()`                        |
| `watch-status.queries.ts`         | User watch history           | `hasUserWatched()`, `batchGetWatchStatus()`                        |
| `user-ratings.queries.ts`         | User ratings                 | Rating CRUD operations                                             |
| `watch-history.queries.ts`        | Watch history tracking       | Watch history query operations                                     |
| `external-ids.queries.ts`         | External ID lookups          | ID resolution helpers                                              |
| `for-you-helpers.queries.ts`      | Recommendation helpers       | UUID resolution, filtering                                         |
| `ai-sync.queries.ts`              | AI sync operations           | Embedding sync tracking                                            |
| `catalog-operations.queries.ts`   | Catalog management           | Media catalog operations                                           |
| `media-upsert.queries.ts`         | Media upserts                | Upsert operations with validation                                  |
| `oauth-refresh-tokens.queries.ts` | OAuth token management       | Token CRUD operations                                              |
| `binge-worthy.queries.ts`         | Binge-worthy recommendations | `getBingeWorthySeries()` - TV series with quality thresholds       |

**Location:** `src/lib/server/database/queries/`

### Search Queries

```typescript
import {
    searchMedia,
    searchMediaFulltext,
    searchEpisode,
} from '$lib/server/database/queries/search.queries';

// Trigram search (searches: title, original_title, overview)
const results = await searchMedia(sql, 'last signal', {
    limit: 20,
    mediaTypes: ['movie'],
    availableOnly: true,
});

// Full-text search (PostgreSQL tsvector)
const fullTextResults = await searchMediaFulltext(sql, 'action adventure', {
    limit: 20,
});

// Search for specific episode
const episodes = await searchEpisode(sql, 'Harbor Lights', 1, 1);
```

### Browse Queries

```typescript
import {
    getMediaAlphabetical,
    getAvailableLibraries,
} from '$lib/server/database/queries/browse.queries';

// Get media alphabetically
const { items, totalCount } = await getMediaAlphabetical(sql, {
    mediaType: 'movie',
    letter: 'A',
    limit: 50,
    offset: 0,
    sortBy: 'title', // 'title' | 'release_date' | 'date_added'
    sortOrder: 'asc',
});

// Get all available libraries
const libraries = await getAvailableLibraries(sql);
```

### Media Lookup Queries

```typescript
import {
    resolveTmdbToUuid,
    resolveUuidToTmdb,
    batchResolveTmdbToUuid,
    findSeriesByName,
} from '$lib/server/database/queries/media-lookup.queries';

// Convert TMDB ID to internal UUID
const uuid = await resolveTmdbToUuid(sql, 550, 'movie');

// Convert UUID to TMDB ID
const tmdbId = await resolveUuidToTmdb(sql, uuid);

// Batch convert TMDB IDs to UUIDs
const uuids = await batchResolveTmdbToUuid(sql, [
    { tmdbId: 10000001, mediaType: 'movie' },
    { tmdbId: 1399, mediaType: 'tv' },
]);

// Find series by name (fuzzy matching)
const series = await findSeriesByName(sql, 'harbor lights');
```

### Migration from Database Class

```typescript
// ❌ OLD - Database class method
const results = await db.searchMedia('last signal', { limit: 20 });
const uuid = await db.resolveTmdbToUuid(550, 'movie');

// ✅ NEW - Query module
import { searchMedia } from '$lib/server/database/queries/search.queries';
import { resolveTmdbToUuid } from '$lib/server/database/queries/media-lookup.queries';

const results = await searchMedia(db.getSql(), 'last signal', { limit: 20 });
const uuid = await resolveTmdbToUuid(db.getSql(), 550, 'movie');
```

---

## Services

Services handle complex operations requiring transaction management, race condition handling, or multi-stage orchestration.

### Embedding Operations Service

```typescript
import { EmbeddingOperationsService } from '$lib/server/services/embedding-operations.service';

const service = new EmbeddingOperationsService(sql);

// Upsert media embedding (handles transactions, race conditions)
const media = await service.upsertMediaEmbedding(
    {
        tmdbId: 10000001,
        mediaType: 'movie',
        title: 'The Last Signal',
        overview: '...',
        // ... other fields
    },
    'jellyfin',
);

// Build embedding from UUID (orchestrates multiple operations)
const embedding = await service.buildMediaEmbeddingFromUuid(mediaId);

// Generate embedding vector from text
const vector = await service.generateEmbedding('Action-packed thriller');
```

### Catalog Service

**⚠️ REQUIRED for all `external_ids` writes (ESLint enforced)**

```typescript
import { CatalogService } from '$lib/server/services/catalog.service';

const catalogService = new CatalogService(sql);

// Single external ID upsert
await catalogService.upsertExternalId(mediaId, {
    provider: 'tmdb',
    id: tmdbId.toString(),
    mediaType: 'movie', // REQUIRED
    source: 'api',
});

// Batch upsert multiple IDs
await catalogService.batchUpsertExternalIds([
    {
        mediaId,
        externalId: {
            provider: 'tmdb',
            id: '10000001',
            mediaType: 'movie',
            source: 'sync',
        },
    },
    {
        mediaId,
        externalId: {
            provider: 'imdb',
            id: 'tt0000001',
            mediaType: 'movie',
            source: 'sync',
        },
    },
    {
        mediaId,
        externalId: {
            provider: 'jellyfin',
            id: jellyfinId,
            mediaType: 'movie',
            source: 'sync',
        },
    },
]);

// Update media_type (for TMDB type corrections)
await catalogService.updateExternalIdMediaType('tmdb', '550', 'movie', 'tv');
```

### User Profile Service

```typescript
import { UserProfileService } from '$lib/server/services/user-profile.service';

const service = new UserProfileService(sql);

// Get user's profile with stats
const profile = await service.getUserProfile(userId);

// Get user preferences
const prefs = await service.getUserPreferences(userId);

// Update preferences
await service.updatePreferences(userId, {
    language: 'en',
    region: 'US',
});
```

### Image Proxy Service

**Centralized image handling** that eliminates internal HTTP calls and provides consistent caching/conversion.

```typescript
import { getImageProxyService } from '$lib/server/services/image-proxy';
import type { ImageType, ImageOptions } from '$lib/server/services/image-proxy';

const service = getImageProxyService(); // Singleton

// UUID catalog lookup (with automatic fallback chain)
const result = await service.getImageByCatalogId(mediaUuid, 'poster' as ImageType, {
    size: 'thumb',
    quality: 85,
    format: 'webp',
});

// Composite key (provider:id:mediaType)
const result = await service.getImageByCompositeKey('tmdb:10000001:movie', 'poster', {
    size: 'full',
});

// Direct provider access
const tmdbImage = await service.getTmdbImage('550', 'movie', 'backdrop', {
    size: 'full',
    quality: 85,
});

const jellyfinImage = await service.getJellyfinImage(itemId, 'poster', {
    maxWidth: '500',
    quality: 80,
});

const audiobookImage = await service.getAudiobookImage(bookId);

const radarrImage = await service.getArrImage('radarr', movieId, 'poster', url);

// Response handling
if (!result) {
    return new Response(null, { status: 404 });
}

return new Response(result.buffer, {
    headers: {
        'Content-Type': result.contentType,
        'Cache-Control': result.cacheControl,
        'X-Cache': result.cacheStatus, // 'HIT' or 'MISS'
    },
});
```

**Features:**

- Request deduplication (prevents stampede)
- Provider-specific caching (TMDB: 180d, Jellyfin: 14d)
- Rate limiting (TMDB: 100ms between requests)
- Fallback chains (Episode → Series, Audio → Album)
- WebP conversion with quality optimization
- Demo mode support

**Providers:**

- `TmdbImageProvider` - TMDB API with in-memory + file caching
- `JellyfinImageProvider` - Jellyfin proxy with complex fallbacks

---

## Centralized Utilities

Use these centralized utilities instead of defining inline versions.

### Data Extraction (`$lib/utils/data-extraction`)

Type guards and data extraction helpers for handling unknown values:

```typescript
import {
    isRecord,
    toString,
    toNumber,
    toNumberOr,
    parseInteger,
    toBoolean,
    toStringArray,
    extractBody,
} from '$lib/utils/data-extraction';

// Type guard for objects
const data: unknown = JSON.parse(input);
if (isRecord(data)) {
    const name = toString(data.name); // string | undefined
    const age = toNumber(data.age); // number | undefined
}

// Number extraction with fallback
const limit = toNumberOr(data.limit, 10); // number (never undefined)
const page = toNumberOr(params.page, 1);

// Parse integers from strings (useful for query params)
const id = parseInteger(params.id); // number | undefined
if (id === undefined) {
    return ApiResponses.badRequest('Invalid ID');
}

// Boolean extraction
const includeAdult = toBoolean(data.include_adult); // boolean | undefined

// String array extraction
const genres = toStringArray(data.genres); // string[] | undefined

// Extract request body safely
const body = await extractBody(request);
if (!isRecord(body)) {
    return ApiResponses.badRequest('Invalid request body');
}
```

### Pagination (`$lib/utils/pagination`)

Consistent pagination handling for API endpoints:

```typescript
import { parsePagination, buildPaginationMeta } from '$lib/utils/pagination';

// Parse pagination from query params
const { offset, limit } = parsePagination(url.searchParams, {
    defaultLimit: 50,
    maxLimit: 100,
});

// Query with pagination
const items = await db.query(offset, limit);
const totalCount = await db.getTotalCount();

// Build response metadata
const pagination = buildPaginationMeta(offset, limit, items.length, totalCount);

// Returns:
// {
//   offset: number;
//   limit: number;
//   hasMore: boolean;
//   nextOffset?: number;
//   totalCount?: number;
// }

return ApiResponses.success({
    items,
    pagination,
});
```

### Embedding Utilities (`$lib/server/utils/embedding-utils`)

Central embedding parsing - **DO NOT duplicate this logic**:

```typescript
import { parseEmbedding } from '$lib/server/utils/embedding-utils';

// Handles: number[], string (JSON), null, undefined
const embedding = parseEmbedding(row.embedding); // number[] | null

if (embedding) {
    // Use embedding vector
    const similarity = cosineSimilarity(embedding, userEmbedding);
}
```

### Error Handler Middleware (`$lib/server/middleware/error-handler`)

Automatic error handling for API endpoints:

```typescript
import {
    withErrorHandler,
    withAIErrorHandler,
    withMediaErrorHandler,
} from '$lib/server/middleware/error-handler';

// Basic usage - wraps handler with try/catch
export const GET = withErrorHandler(async ({ params }) => {
    const data = await fetchData(params.id);
    return ApiResponses.success(data);
});

// With custom error message
export const POST = withErrorHandler(
    async ({ request }) => {
        const data = await processRequest(request);
        return ApiResponses.success(data);
    },
    { errorMessage: 'Failed to process request' },
);

// Combined with auth middleware
import { requireAuth } from '$lib/server/middleware/auth';

export const GET = requireAuth(
    withErrorHandler(async ({ locals }) => {
        return ApiResponses.success({ user: locals.user });
    }),
);

// Pre-configured handlers for common endpoint types
export const GET = withAIErrorHandler(async ({ locals }) => {
    // AI-specific error handling
});

export const GET = withMediaErrorHandler(async ({ params }) => {
    // Media-specific error handling
});
```

---

## Provider-Agnostic Patterns

Patterns for handling content from multiple sources without hardcoding TMDB dependencies.

### ExternalIds Construction

**Always include ALL available provider IDs:**

```typescript
import { createExternalIdsFromTmdb } from '$lib/utils/external-id-helpers';

// ✅ CORRECT: Include all providers
const externalIds = createExternalIdsFromTmdb(item.tmdb_id);
if (item.jellyfin_id) {
    externalIds.jellyfin = item.jellyfin_id;
}
if (item.imdb_id) {
    externalIds.imdb = item.imdb_id;
}

// ❌ WRONG: Only TMDB
const externalIds = { tmdb: String(item.tmdb_id) };
```

**Why:** Enables image fallback chain (TMDB → Jellyfin → placeholder) and provider-agnostic request flows.

### Request Validation

**Use `canRequestMedia()` instead of checking specific providers:**

```typescript
import { canRequestMedia } from '$lib/utils/request-utils';

// ✅ CORRECT: Provider-agnostic validation
const validation = canRequestMedia(item.externalIds, requestsEnabled, requestUrl);

if (validation.canRequest) {
    // Show request button/modal
    handleRequestAction(item);
} else if (validation.reason === 'requests_disabled') {
    // Don't show request UI
} else if (validation.reason === 'tmdb_required_for_external_url') {
    toasts.info('This content requires TMDB metadata for external requests');
}

// ❌ WRONG: Component-level TMDB check
if (!hasTmdbId(item.externalIds)) {
    return; // Blocks content that server could resolve!
}
```

**Validation reasons:**

- `requests_disabled` - Feature not enabled
- `no_external_ids` - No provider IDs available
- `tmdb_required_for_external_url` - Jellyseerr URL requires TMDB ID
- `no_request_url` - Request URL not configured

### Universal Media Keys

**Use `getBestMediaKey()` for media details/modals:**

```typescript
import { getBestMediaKey } from '$lib/utils/media-id-helpers';

// ✅ CORRECT: Provider-agnostic key selection
function openDetails(item: UniversalMediaItem) {
    const mediaKey = getBestMediaKey({
        id: item.id,
        jellyfinId: item.jellyfinId,
        externalIds: item.externalIds,
        mediaType: item.mediaType,
    });

    if (mediaKey) {
        openMediaModal(modalStore, mediaKey);
    }
}

// ❌ WRONG: Hardcoded TMDB assumption
const key = `tmdb:${item.tmdbId}:${item.mediaType}`;
```

**Priority:** Internal UUID → Jellyfin UUID → Composite key (first available provider: TMDB, IMDB, etc.)

### TMDB Dependency Guidelines

**TMDB is required ONLY for:**

1. External Jellyseerr URL when request modal disabled
    - URL format: `https://jellyseerr.example.com/movie/550`
    - This is a Jellyseerr limitation, not our architecture

**TMDB is NOT required for:**

1. Request modal (server resolves any provider → TMDB)
2. Image display (fallback chain handles missing TMDB)
3. Media cards, sections, search results (provider-agnostic)
4. Ratings, similar content (use internal UUID)

---

## Universal Media ID Resolution

**Status:** Standard pattern for all `[id]`-style routes. Use `withIdResolution` for any new route that accepts a media identifier.

Middleware that accepts three ID formats and resolves to all ID types:

1. **Internal UUID**: `a3f5e8c7-1234-5678-90ab-cdef12345678`
2. **Provider UUID**: `0c0bcb2a78a54b0be51f45d97f9e4d1c` (Jellyfin, etc.)
3. **Composite**: `tmdb:10000001:movie`, `jellyfin:abc123:tv`, `imdb:tt0000001:movie`

### Usage

```typescript
import { withIdResolution } from '$lib/server/middleware/id-resolution.js';
import { ApiResponses } from '$lib/server/utils/api-responses';

export const GET: RequestHandler = withIdResolution(async ({ locals, params }) => {
    // Middleware populates locals.resolvedIds with all ID formats
    const { internalId, jellyfinId, externalIds, mediaType } = locals.resolvedIds || {};

    // Use whichever ID format you need
    if (!jellyfinId) {
        return ApiResponses.notFound('Content not found in Jellyfin');
    }

    const data = await jellyfinService.getData(jellyfinId);

    return ApiResponses.success({
        data,
        // Include resolved IDs in response
        ids: {
            internal: internalId,
            jellyfin: jellyfinId,
            external: externalIds,
        },
    });
});
```

### Benefits

- **Flexible input** - Client can send any ID format they have
- **Auto-resolution** - Middleware resolves to all formats
- **2-tier caching** - <2ms cached, <20ms cold
- **Type-safe** - TypeScript interfaces for resolved IDs

### Resolved IDs Structure

```typescript
interface ResolvedIds {
    internalId?: string; // Internal UUID
    jellyfinId?: string; // Jellyfin UUID (if available)
    externalIds: ExternalIds; // All provider IDs
    mediaType?: MediaType; // Normalized media type
}
```

---

## Media Query Fragments

Reusable SQL query building blocks in `$lib/server/database/queries/media-queries`.

### Provider Filters

```typescript
import { MediaQueryFragments } from '$lib/server/database/queries/media-queries';

// Provider filter constants
const tmdbFilter = MediaQueryFragments.tmdbProviderFilter; // "provider = 'tmdb'"
const jellyfinFilter = MediaQueryFragments.jellyfinProviderFilter; // "provider = 'jellyfin'"

// Use in queries
const items = await sql`
    SELECT mi.*
    FROM media_items mi
    JOIN external_ids ei ON ei.media_id = mi.id
    WHERE ${tmdbFilter}
`;
```

### Status/Availability Filters

```typescript
// Availability filters
const available = MediaQueryFragments.isAvailableFilter;
// "COALESCE(la.available, FALSE) = TRUE"

const notAvailable = MediaQueryFragments.notAvailableFilter;
// "COALESCE(la.available, FALSE) = FALSE"

// Use with library_availability join
const items = await sql`
    SELECT mi.*
    FROM media_items mi
    LEFT JOIN library_availability la ON la.media_id = mi.id
    WHERE ${available}
`;
```

### EXISTS Checks for External IDs

```typescript
import { buildExternalIdExistsChecks } from '$lib/server/database/queries/media-queries';

// Build EXISTS checks for a media_id expression
const checks = buildExternalIdExistsChecks('mi.id');

// Available checks:
// - checks.hasTmdb - Has TMDB ID
// - checks.notHasTmdb - No TMDB ID
// - checks.hasJellyfin - Has Jellyfin ID
// - checks.notHasJellyfin - No Jellyfin ID
// - checks.hasImdb - Has IMDB ID
// - checks.notHasImdb - No IMDB ID

// Use in WHERE clauses
const items = await sql`
    SELECT mi.*
    FROM media_items mi
    WHERE ${checks.hasTmdb}
      AND ${checks.hasJellyfin}
`;
```

### Array Exclusion Patterns

```typescript
import { buildExternalIdExclusions } from '$lib/server/database/queries/media-queries';

// Build exclusion patterns for a media_id expression
const exclusions = buildExternalIdExclusions('mi.id');

// Exclude by TMDB IDs
const excludedTmdbIds = [550, 1399, 680];
const items = await sql`
    SELECT mi.*
    FROM media_items mi
    WHERE ${exclusions.tmdbNotIn(sql`${excludedTmdbIds}`)}
`;

// Exclude by Jellyfin IDs
const items2 = await sql`
    SELECT mi.*
    FROM media_items mi
    WHERE ${exclusions.jellyfinNotIn(sql`${excludedJellyfinIds}`)}
`;
```

### CTE Patterns for User Data Filtering

```typescript
import { MediaQueryFragments } from '$lib/server/database/queries/media-queries';

// CTE for user's disliked media (rating <= 4)
const dislikedCTE = MediaQueryFragments.cteDislikedMoviesSimple;
// WITH disliked_movies AS (SELECT media_id FROM user_ratings_v2 WHERE user_id = $1 AND rating <= 4)

// CTE for user's liked media (rating >= 7)
const likedCTE = MediaQueryFragments.cteLikedMoviesSimple;

// CTE for recent watches (last 30 days)
const recentWatchesCTE = MediaQueryFragments.cteRecentWatches;

// Exclusion pattern (NOT EXISTS with disliked CTE)
const excludeDisliked = MediaQueryFragments.excludeDislikedPattern;
// NOT EXISTS (SELECT 1 FROM disliked_movies WHERE media_id = mi.id)

// Full query example
const items = await sql`
    ${dislikedCTE}
    SELECT mi.*
    FROM media_items mi
    WHERE mi.media_type = 'MOVIE'
      AND ${excludeDisliked}
    LIMIT 20
`;
```

### Scalar Subqueries for External IDs

**Use these to avoid JOIN row multiplication:**

```typescript
import {
    MediaQueryFragments,
    buildExternalIdSubquery,
} from '$lib/server/database/queries/media-queries';

// Pre-built scalar subqueries
const tmdbIdSubquery = MediaQueryFragments.scalarTmdbId;
// "(SELECT external_id::integer FROM external_ids WHERE media_id = mi.id AND provider = 'tmdb' LIMIT 1)"

const jellyfinIdSubquery = MediaQueryFragments.scalarJellyfinId;
const imdbIdSubquery = MediaQueryFragments.scalarImdbId;

// Use in SELECT clauses
const items = await sql`
    SELECT
        mi.id,
        mi.title,
        ${tmdbIdSubquery} as tmdb_id,
        ${jellyfinIdSubquery} as jellyfin_id
    FROM media_items mi
`;

// Custom media_id expression
const customSubquery = buildExternalIdSubquery('ur.media_id', 'tmdb', true);
// true = castToInt (returns ::integer)
```

### Composite Key JOINs (Safe)

```typescript
import { MediaQueryFragments } from '$lib/server/database/queries/media-queries';

// JOIN external_ids with media_type safety
const safeJoin = MediaQueryFragments.tmdbExtWithMediaTypeJoin;
// "JOIN external_ids tmdb_ext ON tmdb_ext.media_id = mi.id AND tmdb_ext.provider = 'tmdb' AND tmdb_ext.media_type = mi.media_type"

// With is_primary filter
const primaryJoin = MediaQueryFragments.primaryTmdbExtWithMediaTypeJoin;
// "... AND tmdb_ext.is_primary = TRUE"

// Use in queries
const items = await sql`
    SELECT
        mi.*,
        tmdb_ext.external_id::integer as tmdb_id
    FROM media_items mi
    ${safeJoin}
`;
```

---

## Watch History Analytics

SQL building blocks for analytics on `watch_history` table.

### Aggregation Expressions

```typescript
import { WatchHistoryFragments } from '$lib/server/database/queries/media-queries';

// Use in SELECT clauses
const stats = await sql`
    SELECT
        mi.title,
        ${WatchHistoryFragments.totalWatchMinutes} as total_minutes,
        ${WatchHistoryFragments.uniqueViewers} as viewer_count,
        ${WatchHistoryFragments.completionRate} as completion_pct,
        ${WatchHistoryFragments.trendingScore} as trending_score
    FROM media_items mi
    JOIN watch_history vs ON vs.media_id = mi.id
    GROUP BY mi.id, mi.title
`;

// Available aggregations:
// - totalWatchMinutes: SUM(actual_watch_time) / 60
// - uniqueViewers: COUNT(DISTINCT user_id)
// - completionRate: (completed / total) * 100
// - trendingScore: (viewers * 100 + total_minutes)
```

### Combined Stat Groups

```typescript
// Pre-packaged field lists for common analytics queries

// Basic content stats
const basicStats = WatchHistoryFragments.basicContentStats;
// "COUNT(*) as session_count, COUNT(DISTINCT vs.user_id) as unique_viewers, SUM(vs.actual_watch_time_seconds) / 60 as total_minutes, AVG(vs.actual_watch_time_seconds) / 60 as avg_minutes"

// Engagement stats
const engagementStats = WatchHistoryFragments.engagementStats;
// "COUNT(DISTINCT vs.user_id) as viewers, COUNT(*) / COUNT(DISTINCT vs.user_id) as sessions_per_viewer, SUM(vs.actual_watch_time_seconds) / 3600 as total_hours"

// Completion stats
const completionStats = WatchHistoryFragments.completionStats;
// "SUM(CASE WHEN vs.is_completed THEN 1 ELSE 0 END) as completion_count, (SUM(CASE WHEN vs.is_completed THEN 1 ELSE 0 END)::float / COUNT(*)) * 100 as completion_rate_pct, AVG(vs.completion_percentage) as avg_completion_pct"

// Use in queries
const analytics = await sql`
    SELECT
        mi.title,
        ${basicStats}
    FROM media_items mi
    JOIN watch_history vs ON vs.media_id = mi.id
    GROUP BY mi.id, mi.title
`;
```

### Filter Expressions

```typescript
import {
    WatchHistoryFragments,
    timeframeToDays,
    buildTimeWindowFilter,
    buildMinWatchTimeFilter,
} from '$lib/server/database/queries/media-queries';

// Media type filters
const movieFilter = WatchHistoryFragments.movieFilter;
// "UPPER(vs.media_type) = 'MOVIE'"

const episodeFilter = WatchHistoryFragments.episodeFilter;
// "UPPER(vs.media_type) = 'EPISODE'"

// Minimum watch time filter
const minWatch5Min = WatchHistoryFragments.minWatchTime5Min;
// "COALESCE(vs.actual_watch_time_seconds, 0) >= 300"

// Use in WHERE clauses
const recentMovies = await sql`
    SELECT mi.*
    FROM media_items mi
    JOIN watch_history vs ON vs.media_id = mi.id
    WHERE ${movieFilter}
      AND ${minWatch5Min}
      AND vs.session_start_time >= NOW() - INTERVAL '7 days'
`;
```

### Timeframe Utilities

```typescript
import {
    timeframeToDays,
    buildTimeWindowFilter,
    buildMinWatchTimeFilter,
} from '$lib/server/database/queries/media-queries';

// Convert timeframe enum to days
const days = timeframeToDays('LastMonth'); // 30
const weekDays = timeframeToDays('LastWeek'); // 7

// Build time window filter
const timeFilter = buildTimeWindowFilter(30);
// "vs.session_start_time >= NOW() - INTERVAL '30 days'"

// Build minimum watch time filter (in minutes)
const minWatchFilter = buildMinWatchTimeFilter(5);
// "COALESCE(vs.actual_watch_time_seconds, 0) >= 300"

// Use in queries
const trending = await sql`
    SELECT mi.*, COUNT(*) as view_count
    FROM media_items mi
    JOIN watch_history vs ON vs.media_id = mi.id
    WHERE ${timeFilter}
      AND ${minWatchFilter}
    GROUP BY mi.id
    ORDER BY view_count DESC
    LIMIT 20
`;
```

---

## Server-Driven UI Patterns

Core architecture for displaying media content. Used extensively (232+ usages across 37 files).

### Types

```typescript
import type { UniversalMediaItem, PageSection, CardVariant } from '$lib/types/server-driven-ui';

// UniversalMediaItem - Unified media structure
interface UniversalMediaItem {
    id: string; // Internal UUID
    tmdbId?: number;
    mediaType: MediaType;
    title: string;
    image?: string;
    backdrop?: string;
    rating?: number | null;
    userRating?: number;
    isAvailable?: boolean;
    canRequest?: boolean;
    jellyfinId?: string;
    externalIds?: ExternalIds;
    // ... additional fields
}

// PageSection - Section configuration
interface PageSection {
    type: 'media-carousel' | 'media-grid' | 'hero' | 'custom';
    title: string;
    items: UniversalMediaItem[];
    variant?: CardVariant;
    // ... additional fields
}

// CardVariant
type CardVariant = 'poster' | 'backdrop' | 'list';
```

### Components

```svelte
<script lang="ts">
    import UniversalMediaCard from '$lib/components/ui/UniversalMediaCard.svelte';
    import SectionRenderer from '$lib/components/sections/SectionRenderer.svelte';
    import StandardSection from '$lib/components/sections/StandardSection.svelte';

    // UniversalMediaCard - Universal card renderer
    // - Auto-formats rating display
    // - Handles availability badges
    // - Provider-agnostic image fallback

    // SectionRenderer - Routes sections to appropriate renderers
    // StandardSection - Carousel/grid layouts
</script>

<SectionRenderer sections={pageSections} />

<!-- Or use components directly -->
<StandardSection title="Trending Now" items={trendingItems} variant="backdrop" />

{#each items as item}
    <UniversalMediaCard {item} variant="poster" on:click={() => openDetails(item)} />
{/each}
```

### Transform Pattern

```typescript
function transformItem(apiItem: ApiItem): UniversalMediaItem {
    return {
        id: apiItem.id,
        tmdbId: apiItem.tmdb_id,
        mediaType: apiItem.type,
        title: apiItem.name || apiItem.title,
        image: getPosterUrl(apiItem.tmdb_id, apiItem.type),
        backdrop: getBackdropUrl(apiItem.tmdb_id, apiItem.type),
        rating: apiItem.rating, // Card formats automatically
        userRating: apiItem.user_rating,
        isAvailable: apiItem.available,
        canRequest: !apiItem.available, // Card shows "Anfragen" badge
        jellyfinId: apiItem.jellyfin_id,
        externalIds: buildExternalIds(apiItem),
    };
}

// ✅ Correct reactivity - pass dependencies as parameters
$: section = buildSection(items, loading, error);
$: transformedItems = items.map(transformItem);
```

### Image Helpers

```typescript
import { getPosterUrl, getBackdropUrl } from '$lib/utils/image-helpers';

// Get poster image URL (with fallback chain)
const poster = getPosterUrl(tmdbId, mediaType, jellyfinId);
// Priority: TMDB → Jellyfin → Placeholder

// Get backdrop image URL
const backdrop = getBackdropUrl(tmdbId, mediaType, jellyfinId);
```

---

## Jellyfin Client Formats

**⚠️ JellyfinSeriesService methods return different formats:**

| Method                | Format                    | Properties                    |
| --------------------- | ------------------------- | ----------------------------- |
| SDK methods           | Raw Jellyfin (PascalCase) | `Id`, `Name`, `UserData.*`    |
| `getSeriesSeasons()`  | Mapped (camelCase)        | `id`, `seasonNumber`          |
| `getSeasonEpisodes()` | Mapped (camelCase)        | `id`, `playbackPositionTicks` |

### Consuming Data from Mixed Sources

**When consuming data, support both formats:**

```typescript
// Episode ID
const episodeId = episode.Id || episode.id;

// Playback position
const positionTicks = episode.UserData?.PlaybackPositionTicks || episode.playbackPositionTicks || 0;

// Name/Title
const title = episode.Name || episode.name;

// Watch status
const isPlayed = episode.UserData?.Played || episode.played || false;
```

### Why Different Formats?

- **SDK methods** return raw Jellyfin API responses (PascalCase)
- **Custom methods** map to camelCase for consistency with TypeScript conventions
- Both formats are supported during transition period

---

## Testing Patterns

### Unit Tests

```bash
npm test
```

**Pattern:**

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('MyService', () => {
    it('should transform data correctly', () => {
        const result = transformData(input);
        expect(result).toEqual(expected);
    });

    it('should handle errors gracefully', async () => {
        const mockFn = vi.fn().mockRejectedValue(new Error('Test error'));
        await expect(myFunction(mockFn)).rejects.toThrow('Test error');
    });
});
```

### Integration Tests

```bash
npm run test:integration
```

**Requirements:** Running PostgreSQL database (uses `DATABASE_URL` from env)

**Pattern:**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestDatabase } from '$lib/server/database/test-helpers';

describe('MediaLookup Integration', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = await getTestDatabase();
    });

    afterAll(async () => {
        await sql.end();
    });

    it('should resolve TMDB ID to UUID', async () => {
        const uuid = await resolveTmdbToUuid(sql, 550, 'movie');
        expect(uuid).toBeDefined();
    });
});
```

### E2E API Tests

```bash
npm run test:e2e:api
```

**Requirements:** Running dev server + database

**Pattern:**

```typescript
import { test, expect } from '@playwright/test';

test('GET /api/media/search', async ({ request }) => {
    const response = await request.get('/api/media/search?q=last signal');

    expect(response.status()).toBe(200);

    const data = await response.json();
    expect(data).toHaveProperty('items');
    expect(Array.isArray(data.items)).toBe(true);
});
```

---

## Task System

Background work (library scans, metadata sync, embeddings, maintenance) runs on the
task system under `src/lib/server/tasks/` — an orchestrator, a runner and a plugin
registry on top of BullMQ, with per-task queues and `stage_state` bookkeeping. It
replaced the earlier `src/lib/server/queue/` module that older revisions of this guide
described.

- **Concepts and operations:** <https://lumastra.org/architecture/task-system/>
- **Schema, Valkey keys and the raw DDL:** [`docs/architecture/task-system-schema.md`](../architecture/task-system-schema.md)
- **Writing a task (plugin authors):** <https://lumastra.org/developers/plugins/>
- **Module guidance for contributors:** `src/lib/server/tasks/CLAUDE.md`

---

## Additional Resources

- 📖 [Main Project Guide](../CLAUDE.md) - Core architecture and critical rules
- 🚀 [Quick Start Guide](./QUICK-START.md) - Commands, setup, deployment
- 📁 [Query Modules](../../src/lib/server/database/queries/) - Source code
- 📁 [Services](../../src/lib/server/services/) - Source code
- 📁 [Utilities](../../src/lib/utils/) - Source code
- 📁 [Task System](../../src/lib/server/tasks/) - Orchestrator, runner, plugin registry
