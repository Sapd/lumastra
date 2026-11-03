# Database Architecture

This document describes Lumastra's database layer architecture and provides guidance on choosing the right pattern for new features.

## Overview

Lumastra uses a **three-tier architecture** for database operations:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Database Architecture                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  API Routes (src/routes/api/*)                                  │
│       │                                                          │
│       ├──> Query Modules (Pure SQL)                             │
│       │    └─> postgres.Sql instance                            │
│       │                                                          │
│       ├──> Services (Orchestration)                             │
│       │    ├─> Query Modules                                    │
│       │    ├─> Other Services                                   │
│       │    └─> Transactions & Business Logic                    │
│       │                                                          │
│       └──> Database Class (Legacy)                              │
│            ├─> Query Modules (delegated)                        │
│            ├─> Services (delegated)                             │
│            └─> Complex recommendation algorithms                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Media Items Hierarchy

The `media_items` table uses a parent-child hierarchy for TV series:

```
media_items hierarchy:
=====================

series (media_type = 'tv')
  └── season (media_type = 'season', parent_id = series.id)
        └── episode (media_type = 'episode', parent_id = season.id)
```

**Critical Rule:** When querying episodes for a series, you MUST join through seasons:

```sql
-- WRONG: Assumes episodes are direct children of series
SELECT * FROM media_items
WHERE parent_id = ${seriesId} AND media_type = 'episode'

-- CORRECT: Joins through seasons
SELECT mi.* FROM media_items mi
JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
WHERE season.parent_id = ${seriesId} AND mi.media_type = 'episode'
```

This pattern appears in many queries. See `series-hierarchy.integration.test.ts` for tests that verify this behavior.

## Three-Tier Pattern

### 1. Query Modules (`src/lib/server/database/queries/`)

**Purpose:** Pure SQL queries without side effects.

**Characteristics:**

- Exported functions taking `sql: postgres.Sql` as first parameter
- No complex orchestration or service dependencies
- Focused, single-responsibility modules
- Reusable across routes and services

**Example:**

```typescript
// src/lib/server/database/queries/search.queries.ts
import type postgres from 'postgres';

export interface SearchOptions {
    limit?: number;
    mediaTypes?: ('movie' | 'tv')[];
    availableOnly?: boolean;
}

export async function searchMedia(
    sql: postgres.Sql,
    query: string,
    options: SearchOptions = {},
): Promise<MediaItem[]> {
    const { limit = 50, mediaTypes = ['movie', 'tv'] } = options;

    return await sql`
        SELECT mi.*, ...
        FROM media_items mi
        WHERE ...
        LIMIT ${limit}
    `;
}
```

**Usage in route:**

```typescript
// src/routes/api/search/+server.ts
import { searchMedia } from '$lib/server/database/queries/search.queries';

export const GET: RequestHandler = async ({ url, locals }) => {
    const query = url.searchParams.get('q') || '';
    const results = await searchMedia(locals.sql, query, { limit: 20 });
    return ApiResponses.success({ results });
};
```

### 2. Services (`src/lib/server/services/`)

**Purpose:** Complex operations coordinating multiple queries and services.

**Characteristics:**

- Class-based design with dependency injection
- Transaction management (`sql.begin()`)
- Race condition handling (`ON CONFLICT`)
- Multi-table writes with validation
- Business logic and conditional orchestration

**Example:**

```typescript
// src/lib/server/services/embedding-operations.service.ts
import type postgres from 'postgres';
import { CatalogService } from './catalog.service';

export class EmbeddingOperationsService {
    private catalogService: CatalogService;

    constructor(private sql: postgres.Sql) {
        this.catalogService = new CatalogService(sql);
    }

    async upsertMediaEmbedding(
        media: MediaEmbeddingInput,
        embeddingType: 'jellyfin' | 'jellyseerr',
    ): Promise<MediaEmbedding> {
        // Multi-stage transaction with race-safe inserts
        return await this.sql.begin(async (tx) => {
            // 1. Lookup or create media item
            const mediaId = await this.getOrCreateMediaItem(tx, media);

            // 2. Upsert external IDs via CatalogService
            await this.catalogService.upsertExternalId(mediaId, {
                provider: 'tmdb',
                id: media.tmdb_id.toString(),
                mediaType: media.media_type,
                source: embeddingType,
            });

            // 3. Update provider metadata
            await this.updateProviderMetadata(tx, mediaId, media);

            // 4. Upsert embedding vector
            return await this.upsertEmbeddingVector(tx, mediaId, media);
        });
    }

    private async getOrCreateMediaItem(
        tx: postgres.TransactionSql,
        media: MediaEmbeddingInput,
    ): Promise<string> {
        // Race-safe INSERT with ON CONFLICT
        const [row] = await tx`
            INSERT INTO media_items (media_type, title, ...)
            VALUES (${media.media_type}, ${media.title}, ...)
            ON CONFLICT (tmdb_id, media_type) DO UPDATE
                SET title = EXCLUDED.title, ...
            RETURNING id
        `;
        return row.id;
    }
}
```

**Usage in route:**

```typescript
// An API route that delegates to a service (illustrative — the pattern, not a real file)
import { EmbeddingOperationsService } from '$lib/server/services/embedding-operations.service';

export const POST: RequestHandler = async ({ request, locals }) => {
    const data = await extractBody(request);
    const service = new EmbeddingOperationsService(locals.sql);

    const result = await service.upsertMediaEmbedding(data, 'jellyfin');
    return ApiResponses.success({ result });
};
```

### 3. Database Class (`src/lib/server/database/connection.ts`)

**Purpose:** Legacy entry point, being phased out.

**Current Status:**

- **Before refactoring:** 4,110 lines
- **After refactoring:** 2,713 lines (**-34%**)
- **Target:** 2,000-2,500 lines (50-60% reduction)

**What Remains:**

- Complex recommendation algorithms (until Phase 4 refactoring)
- Methods with advisory locks
- Legacy delegation wrappers (marked `@deprecated`)

**Migration Strategy:**

- New features: Use query modules or services directly
- Existing methods: Delegated to query modules with `@deprecated` notices
- Recommendation methods: Being refactored in Phase 4

## Decision Tree: Choosing the Right Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│         What type of database operation are you building?       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │  Simple SELECT query │ ────────> Query Module
                  │  (no transactions)   │
                  └──────────────────────┘
                             │
                             ▼
                  ┌──────────────────────┐
                  │ Multi-table write or │
                  │  transaction needed? │
                  └──────┬───────────────┘
                         │
                    ┌────┴────┐
                    │   YES   │
                    └────┬────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ Coordinates multiple   │
              │ services or complex    │ ──YES──> Service
              │ business logic?        │
              └────────┬───────────────┘
                       │
                  ┌────┴────┐
                  │   NO    │
                  └────┬────┘
                       │
                       ▼
              ┌────────────────────────┐
              │ Simple transaction or  │
              │ single-table upsert?   │ ──────> Query Module
              │ (use sql.begin())      │         (with transaction)
              └────────────────────────┘
```

### Decision Matrix

| Scenario                         | Pattern                 | Example                                                      |
| -------------------------------- | ----------------------- | ------------------------------------------------------------ |
| Simple SELECT query              | Query Module            | `searchMedia()`, `getUserRatings()`                          |
| Batch SELECT operations          | Query Module            | `batchGetWatchStatus()`, `resolveTmdbToUuid()`               |
| Simple INSERT/UPDATE             | Query Module            | `insertWatchHistoryEntry()`, `updateUserPreference()`        |
| Multi-table transaction          | Service                 | `upsertMediaEmbedding()`, `batchUpsertExternalIds()`         |
| Race condition handling          | Service                 | Any `ON CONFLICT` logic with business rules                  |
| Coordinates multiple services    | Service                 | `buildMediaEmbeddingFromUuid()` (calls TMDB, Jellyfin, etc.) |
| Complex recommendation algorithm | Database Class (legacy) | `generateSuggestionsFromProfile()` (being refactored)        |
| Advisory lock coordination       | Database Class (legacy) | Suggestion generation with locks                             |

## Query Module Guidelines

### File Naming Convention

- **Pattern:** `[feature].queries.ts`
- **Examples:**
    - `search.queries.ts` - Search operations
    - `browse.queries.ts` - Browse/discovery
    - `user-ratings.queries.ts` - User ratings
    - `watch-history.queries.ts` - Watch history tracking

### Function Signature Pattern

```typescript
export async function functionName(
    sql: postgres.Sql,
    ...params,
    options?: OptionsInterface,
): Promise<ReturnType> {
    // Implementation
}
```

**Key Points:**

- First parameter is ALWAYS `sql: postgres.Sql`
- Options parameter is optional and typed
- Return type is explicitly declared
- Exported as named function (not default export)

### Module Structure

```typescript
/**
 * Module docstring explaining purpose
 */

import type postgres from 'postgres';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('ModuleName');

// =============================================================================
// Types
// =============================================================================

export interface SearchOptions {
    limit?: number;
    offset?: number;
}

export interface SearchResult {
    id: string;
    title: string;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Function-level docstring
 */
export async function searchFunction(
    sql: postgres.Sql,
    query: string,
    options: SearchOptions = {},
): Promise<SearchResult[]> {
    const { limit = 50, offset = 0 } = options;

    return await sql<SearchResult[]>`
        SELECT ...
        LIMIT ${limit} OFFSET ${offset}
    `;
}
```

### Integration Testing

**Every query module MUST have integration tests:**

```typescript
// media-lookup.queries.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { getTestSql } from '../../../test-helpers/test-database';
import { resolveTmdbToUuid } from './media-lookup.queries';

describe('media-lookup.queries (Integration)', () => {
    const sql = getTestSql();

    beforeAll(async () => {
        // Insert test data
    });

    it('should resolve TMDB ID to UUID', async () => {
        const uuid = await resolveTmdbToUuid(sql, 550, 'movie');
        expect(uuid).toMatch(/^[a-f0-9-]{36}$/);
    });
});
```

## Service Guidelines

### Class Design Pattern

```typescript
import type postgres from 'postgres';
import { Logger } from '../utils/logger.js';

const logger = Logger.for('ServiceName');

/**
 * Service docstring
 */
export class ServiceName {
    // Dependency injection pattern
    private dependencyService: DependencyService;

    constructor(private sql: postgres.Sql) {
        this.dependencyService = new DependencyService(sql);
    }

    /**
     * Public method docstring
     */
    async publicMethod(params: ParamType): Promise<ReturnType> {
        return await this.sql.begin(async (tx) => {
            // Transaction logic
            const step1 = await this.privateHelper(tx, params);
            const step2 = await this.dependencyService.operation(step1);
            return step2;
        });
    }

    /**
     * Private helper methods
     */
    private async privateHelper(
        tx: postgres.TransactionSql,
        params: ParamType,
    ): Promise<IntermediateType> {
        // Implementation
    }
}
```

### Transaction Management

**Use transactions for:**

- Multi-table writes
- Race-safe inserts (`ON CONFLICT`)
- Operations requiring consistency guarantees
- Rollback on partial failure

**Example:**

```typescript
async upsertMedia(media: MediaInput): Promise<MediaItem> {
    return await this.sql.begin(async (tx) => {
        // Step 1: Insert/update media item
        const [mediaItem] = await tx`
            INSERT INTO media_items (...)
            VALUES (...)
            ON CONFLICT (tmdb_id, media_type) DO UPDATE ...
            RETURNING *
        `;

        // Step 2: Update related tables (uses mediaItem.id)
        await this.catalogService.upsertExternalId(mediaItem.id, ...);

        // If any step fails, entire transaction rolls back
        return mediaItem;
    });
}
```

## Data Flow Examples

### Simple Query Flow

```
User Request
    ↓
API Route (/api/search)
    ↓
Query Module (search.queries.ts)
    ↓
PostgreSQL
    ↓
Response
```

**Code:**

```typescript
// Route
export const GET: RequestHandler = async ({ url, locals }) => {
    const query = url.searchParams.get('q') || '';
    const results = await searchMedia(locals.sql, query);
    return ApiResponses.success({ results });
};
```

### Complex Service Flow

```
User Request
    ↓
API Route
    ↓
Service (EmbeddingOperationsService)
    ├─> CatalogService (external_ids management)
    ├─> Query Module (embeddings.queries.ts)
    ├─> External API (TMDB for metadata)
    └─> Transaction Coordination
    ↓
PostgreSQL (multi-table writes)
    ↓
Response
```

**Code:**

```typescript
// Route
export const POST: RequestHandler = async ({ request, locals }) => {
    const data = await extractBody(request);
    const service = new EmbeddingOperationsService(locals.sql);
    const result = await service.upsertMediaEmbedding(data, 'jellyfin');
    return ApiResponses.success({ result });
};
```

### Legacy Database Class Flow (Being Phased Out)

```
User Request
    ↓
API Route (/api/recommendations)
    ↓
Database Class (connection.ts)
    ├─> Delegates to Query Module (@deprecated wrapper)
    └─> OR Complex recommendation algorithm (stays until Phase 4)
    ↓
PostgreSQL
    ↓
Response
```

## Migration Examples

### Migrating from Database Class

**Before:**

```typescript
// Route using Database class
export const GET: RequestHandler = async ({ locals }) => {
    const db = locals.db;
    const results = await db.searchMedia('last signal', { limit: 20 });
    return ApiResponses.success({ results });
};
```

**After:**

```typescript
// Route using query module directly
import { searchMedia } from '$lib/server/database/queries/search.queries';

export const GET: RequestHandler = async ({ locals }) => {
    const results = await searchMedia(locals.sql, 'last signal', { limit: 20 });
    return ApiResponses.success({ results });
};
```

### Creating a New Query Module

**1. Create the file:**

```bash
touch src/lib/server/database/queries/my-feature.queries.ts
```

**2. Implement the queries:**

```typescript
// my-feature.queries.ts
import type postgres from 'postgres';

export interface MyOptions {
    limit?: number;
}

export async function getMyData(
    sql: postgres.Sql,
    userId: string,
    options: MyOptions = {},
): Promise<MyData[]> {
    const { limit = 50 } = options;

    return await sql<MyData[]>`
        SELECT * FROM my_table
        WHERE user_id = ${userId}
        LIMIT ${limit}
    `;
}
```

**3. Add integration tests:**

```typescript
// my-feature.queries.integration.test.ts
import { describe, it, expect } from 'vitest';
import { getTestSql } from '../../../test-helpers/test-database';
import { getMyData } from './my-feature.queries';

describe('my-feature.queries (Integration)', () => {
    const sql = getTestSql();

    it('should return user data', async () => {
        const results = await getMyData(sql, 'user123');
        expect(results).toBeInstanceOf(Array);
    });
});
```

**4. Use in route:**

```typescript
// +server.ts
import { getMyData } from '$lib/server/database/queries/my-feature.queries';

export const GET: RequestHandler = async ({ locals }) => {
    const results = await getMyData(locals.sql, locals.user.id);
    return ApiResponses.success({ results });
};
```

## Performance Considerations

### Query Module Performance

**Advantages:**

- Direct SQL execution (no ORM overhead)
- Explicit query control (can optimize as needed)
- Easy to add indexes based on query patterns
- Built-in connection pooling via postgres.js

**Best Practices:**

- Use scalar subqueries to avoid JOIN row multiplication
- Prefer CTEs for complex multi-stage queries
- Add appropriate indexes for WHERE/JOIN columns
- Use `LIMIT` and `OFFSET` for pagination
- Log slow queries with Logger

### Service Performance

**Transaction Overhead:**

- Transactions add ~2-5ms overhead
- Only use when atomicity is required
- Avoid long-running transactions (lock contention)

**Best Practices:**

- Keep transactions focused and fast
- Avoid external API calls inside transactions
- Use advisory locks for concurrent operations
- Batch operations when possible

## Testing Strategy

### Query Modules

**Integration tests required:**

- Test with real database (via `getTestSql()`)
- Verify query logic and SQL syntax
- Test edge cases (empty results, null values)
- Validate return types

**Example:**

```typescript
describe('search.queries (Integration)', () => {
    const sql = getTestSql();

    beforeAll(async () => {
        // Insert test data
        await sql`INSERT INTO media_items ...`;
    });

    it('should search by title', async () => {
        const results = await searchMedia(sql, 'last signal');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].title).toContain('Signal');
    });

    it('should handle empty query', async () => {
        const results = await searchMedia(sql, '');
        expect(results).toEqual([]);
    });
});
```

### Services

**Unit tests for logic:**

- Mock dependencies (query modules, external APIs)
- Test business logic and error handling
- Verify transaction rollback behavior

**Integration tests for transactions:**

- Test multi-table writes
- Verify race condition handling
- Test rollback scenarios

## ESLint Enforcement

See **AGENTS.md** for complete ESLint rules. Key patterns:

1. **No direct `external_ids` writes** - Use `CatalogService`
2. **No `throw error()` in API routes** - Use `ApiResponses`
3. **Prefer query modules over direct SQL in routes**

## Common Patterns

### UUID Resolution

**Use query modules for ID conversion:**

```typescript
import {
    resolveTmdbToUuid,
    resolveUuidToTmdb,
} from '$lib/server/database/queries/media-lookup.queries';

const uuid = await resolveTmdbToUuid(sql, tmdbId, 'movie');
const tmdbId = await resolveUuidToTmdb(sql, uuid);
```

### Batch Operations

**Batch queries for efficiency:**

```typescript
import { batchGetWatchStatus } from '$lib/server/database/queries/watch-status.queries';

const statuses = await batchGetWatchStatus(sql, userId, mediaIds);
```

### External ID Management

**Always use CatalogService:**

```typescript
import { CatalogService } from '$lib/server/services/catalog.service';

const catalogService = new CatalogService(sql);
await catalogService.upsertExternalId(mediaId, externalId);
```

## Summary

**For New Features:**

1. Start with query module for simple reads
2. Create service if orchestration is needed
3. Never add methods to Database class
4. Write integration tests
5. Follow ESLint rules

**For Refactoring:**

1. Extract simple queries to modules first
2. Extract complex operations to services
3. Mark Database class methods as `@deprecated`
4. Update callers gradually
5. Remove deprecated methods once migration complete

**Architecture Goals:**

- **Modularity:** Easy to find and reuse queries
- **Testability:** Integration tests for all modules
- **Performance:** Direct SQL with explicit control
- **Maintainability:** Clear separation of concerns
- **Type Safety:** Full TypeScript coverage

---

**See Also:**

- [AGENTS.md](../../AGENTS.md) - Complete architecture guidelines
- [ESLint Exceptions](../dev/eslint-exceptions.md) - Documented rule exceptions
