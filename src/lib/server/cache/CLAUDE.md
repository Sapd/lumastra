# cache/

Unified caching layer with Valkey (Redis-compatible), LRU in-memory, and cache namespacing.

## Files

| File                               | What                                                                        | When to read                             |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| `index.ts`                         | Cache module exports                                                        | Importing cache functionality            |
| `invalidation.ts`                  | Cache invalidation strategies (patterns, wildcards)                         | Invalidating cached data                 |
| `lru-cache.ts`                     | In-memory LRU cache implementation                                          | Using local memory cache                 |
| `namespace-clear-bus.ts`           | Pub/sub that tells other processes to drop their L1 of a cleared namespace   | A clear in the worker must reach the web L1 |
| `namespaces.ts`                    | Cache key namespace definitions (versioning)                                | Creating cache keys                      |
| `standalone-registry.ts`           | Standalone cache registry (testing, isolation)                              | Testing cache without Valkey             |
| `unified-cache.ts`                 | Unified cache interface (Valkey + LRU fallback)                             | Reading or writing cached data           |
| `valkey.ts`                        | Valkey client connection and configuration                                  | Connecting to Valkey/Redis               |
| `subscription-close-grace.test.ts` | One shared pub/sub client; idle channels UNSUBSCRIBE after 30s, never close | Changing subscribe/unsubscribe lifecycle |
| `warming.ts`                       | Cache warming and preloading strategies                                     | Preloading frequently accessed data      |

## Cache traps

- **`scopedCacheKey` reserves `|`.** It joins the access suffix with `|` and throws when the prefix
  or an extra contains one. It also puts the request locale in front of the key, so a cache filled
  by one locale is never served to another. Any new access-filtered cache must use it.
- **A negative (miss) cache stores only the one status that is an answer.** Write
  `status !== 404 -> not available, do not cache`, not `status >= 500 -> not available`. A 401 or 403
  from a revoked token or a blocking proxy is a fault that affects everyone, and caching it as "this
  user has no avatar" keeps the app blank for the whole TTL after the fault is fixed.
- **Every key you write must be reachable by the invalidation path.** If a lookup accepts several
  handles for the same entity (name, UUID, external id) and invalidation is only called with one of
  them, an entry written under another handle can never be cleared. Reach it or decline to write it.
- **Fold live gates into the key.** A miss recorded while a source was switched off says nothing
  about a request made after an admin switches it on. Include the set of enabled sources in the key
  so a flip re-probes on the next request.
