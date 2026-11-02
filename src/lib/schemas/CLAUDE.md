# schemas/

Zod schemas — single source of truth for all TypeScript types and API validation.

## Files

| File                               | What                                         | When to read                                     |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| `common.ts`                        | Shared/common schemas                        | Using base types, creating new schemas           |
| `api-responses.ts`                 | Shared API response base schemas             | Creating new API response schemas                |
| `api-common-responses.ts`          | Common API response schemas (success, error) | Validating simple API responses                  |
| `api-media-responses.ts`           | Media item response schemas                  | Validating media API responses                   |
| `api-series-responses.ts`          | Series/episode response schemas              | Validating series/episode API responses          |
| `api-search-responses.ts`          | Search response schemas                      | Validating search API responses                  |
| `api-browse-responses.ts`          | Browse API response schemas                  | Validating browse/category responses             |
| `api-content-responses.ts`         | Content detail response schemas              | Validating content detail responses              |
| `api-for-you-responses.ts`         | For-You response schemas                     | Validating personalized recommendation responses |
| `api-playback-responses.ts`        | Playback API response schemas                | Validating playback/streaming responses          |
| `api-user-responses.ts`            | User API response schemas                    | Validating user settings/profile responses       |
| `api-admin-responses.ts`           | Admin API response schemas                   | Validating admin feature responses               |
| `api-admin-unmatched-responses.ts` | Unmatched files + media search schemas       | Validating unmatched files API responses         |
| `api-ai-responses.ts`              | AI API response schemas                      | Validating AI/recommendation responses           |
| `api-list-responses.ts`            | List/curated content response schemas        | Validating list/collection responses             |
| `api-person-responses.ts`          | Person/cast response schemas                 | Validating cast/crew responses                   |
| `admin-types.ts`                   | Admin metrics and settings schemas           | Implementing admin features                      |
| `admin.ts`                         | Admin task and action schemas                | Validating admin operations                      |
| `ai-tasks.ts`                      | AI task configuration schemas                | Implementing AI task management                  |
| `ai.ts`                            | AI/recommendation schemas                    | Implementing AI features                         |
| `browse.ts`                        | Browse category schemas                      | Implementing browse features                     |
| `assistant-types.ts`               | AI Assistant message schemas                 | Implementing AI assistant features               |
| `holidays.ts`                      | Holiday recommendation schemas               | Implementing holiday features                    |
| `media-detail.ts`                  | Media detail schemas                         | Implementing media detail views                  |
| `notifications-types.ts`           | Notification schemas                         | Implementing notification system                 |
| `oauth.ts`                         | OAuth flow schemas                           | Implementing OAuth authentication                |
| `personal-stats-types.ts`          | Personal statistics schemas                  | Implementing statistics features                 |
| `playback-types.ts`                | Playback state schemas                       | Implementing playback state management           |
| `playback.ts`                      | Playback API schemas                         | Implementing playback features                   |
| `playlist-utils-types.ts`          | Playlist utility schemas                     | Implementing playlist helpers                    |
| `playlists.ts`                     | Playlist CRUD schemas                        | Implementing playlist features                   |
| `plugin-types.ts`                  | Plugin system schemas                        | Implementing plugin features                     |
| `request.ts`                       | Media request schemas                        | Implementing media request features              |
| `user.ts`                          | User settings schemas                        | Implementing user settings                       |
| `watch-together-core-types.ts`     | Watch party core schemas                     | Implementing watch party core features           |
| `watch-together.ts`                | Watch party API schemas                      | Implementing watch party features                |
| `watched-types.ts`                 | Watch status schemas                         | Implementing watch status tracking               |
| `index.ts`                         | Schema module exports                        | Importing schemas                                |
