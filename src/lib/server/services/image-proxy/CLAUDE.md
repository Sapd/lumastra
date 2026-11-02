# image-proxy/

Centralized image proxy service — always use `getImageProxyService()` from `index.ts` instead of direct `fetch()` calls.

## Files

| File            | What                                                                                         | When to read                                                |
| --------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `index.ts`      | `getImageProxyService()` singleton factory — main entry point                                | Using image proxy anywhere in server code                   |
| `service.ts`    | `ImageProxyService` class with all proxy methods                                             | Understanding image proxy logic or adding new methods       |
| `cache.ts`      | Image response caching layer (Valkey-backed)                                                 | Debugging image cache misses or tuning TTLs                 |
| `box-resize.ts` | Catalog image sized to a client box (width/height, max*, fill*; Jellyfin rules), disk-cached | Serving client-chosen image sizes (e.g. the /j image route) |
| `response.ts`   | `ImageProxyResponse` type and response builders                                              | Working with image proxy return values                      |
| `types.ts`      | TypeScript types for image proxy parameters and options                                      | Adding new image source types                               |

## Subdirectories

| Directory    | What                                                          | When to read                                      |
| ------------ | ------------------------------------------------------------- | ------------------------------------------------- |
| `providers/` | Per-source image fetchers (Jellyfin, TMDB, fallback strategy) | Adding new image sources or debugging fetch logic |
