# api/

Frontend API client with Zod schema validation for all backend calls.

## Files

| File                   | What                                                                      | When to read                                       |
| ---------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| `contract-reporter.ts` | Browser contract diagnostic batching, deduplication and reporting         | Investigating response schema drift                |
| `client.ts`            | Core HTTP client (apiGet, apiPost, apiPut, apiDelete) with Zod validation | Reading any API module, implementing new API calls |
| `types.ts`             | ApiResult<T> type with validationError field                              | Handling API responses, error states               |
| `admin.ts`             | Admin API calls (cache, tasks, sync, plugins)                             | Implementing admin features, cache management      |
| `ai.ts`                | AI/recommendation API calls                                               | Implementing AI features, recommendations          |
| `browse.ts`            | Browse/category API calls                                                 | Implementing browse pages, category navigation     |
| `content.ts`           | Content detail API calls                                                  | Displaying media details, content pages            |
| `for-you.ts`           | For-You section API calls                                                 | Implementing personalized recommendations          |
| `playback.ts`          | Playback/streaming API calls                                              | Implementing video player, playback features       |
| `playlists.ts`         | Playlist CRUD API calls                                                   | Implementing playlist features                     |
| `user.ts`              | User settings/profile API calls                                           | Implementing user settings, profile pages          |
| `watch-together.ts`    | Watch party API calls                                                     | Implementing watch party features                  |
| `schema.d.ts`          | Schema type declarations                                                  | TypeScript type definitions                        |
