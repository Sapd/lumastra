# queries/

Pure SQL query modules — each file handles one domain, takes `sql: postgres.Sql` as first param.

## Files

| File                                               | What                                                            | When to read                          |
| -------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| `ai-admin.queries.ts`                              | AI admin dashboard queries                                      | Building AI admin features            |
| `ai-sync.queries.ts`                               | AI sync status queries                                          | Implementing AI sync features         |
| `ai-sync.queries.integration.test.ts`              | AI sync query integration tests                                 | Testing AI sync queries               |
| `binge-worthy.queries.ts`                          | Binge-worthy series queries                                     | Building binge-worthy recommendations |
| `browse.queries.ts`                                | Browse/category queries                                         | Implementing browse pages             |
| `catalog-operations.queries.ts`                    | Catalog CRUD operations                                         | Creating or updating catalog items    |
| `catalog-operations.queries.integration.test.ts`   | Catalog operation integration tests                             | Testing catalog operations            |
| `chat.queries.ts`                                  | Playlist chat message queries                                   | Building playlist chat features       |
| `cluster-nodes.queries.ts`                         | Cluster node event queries                                      | Monitoring node transitions           |
| `device-sessions.queries.ts`                       | Device session management                                       | Managing device sessions              |
| `device-sessions.queries.integration.test.ts`      | Device session integration tests                                | Testing device session logic          |
| `embeddings.queries.ts`                            | Embedding vector queries                                        | Working with AI embeddings            |
| `episode-orderings.queries.ts`                     | Episode ordering queries                                        | Implementing episode ordering         |
| `episode-search.queries.ts`                        | Episode search queries                                          | Building episode search               |
| `external-ids.queries.ts`                          | External ID lookups                                             | Resolving external provider IDs       |
| `external-ids.queries.integration.test.ts`         | External ID integration tests                                   | Testing external ID resolution        |
| `featured-pick.queries.ts`                         | Featured pick selection queries                                 | Building featured content             |
| `for-you-helpers.queries.ts`                       | For-You section helper queries                                  | Building For-You page sections        |
| `for-you-helpers.queries.integration.test.ts`      | For-You helper integration tests                                | Testing For-You logic                 |
| `index.ts`                                         | Query module exports                                            | Importing query functions             |
| `provider-device-tokens.queries.ts`                | Provider device token queries (used by JellyfinTokenService)    | Managing Jellyfin tokens              |
| `library-permissions.queries.ts`                   | Library permission queries (used by JellyfinPermissionsService) | Implementing permission checks        |
| `media-lookup.queries.ts`                          | Media item lookup queries                                       | Finding media items                   |
| `media-lookup.queries.integration.test.ts`         | Media lookup integration tests                                  | Testing media lookup logic            |
| `media-queries.ts`                                 | General media queries                                           | Querying media data                   |
| `media-queries.test.ts`                            | Media query tests                                               | Testing media query logic             |
| `media-upsert.ts`                                  | Media item upsert operations                                    | Inserting or updating media items     |
| `media-upsert.integration.test.ts`                 | Media upsert integration tests                                  | Testing media upsert logic            |
| `metadata-aggregation.queries.ts`                  | Metadata aggregation queries                                    | Aggregating metadata                  |
| `oauth-admin.queries.ts`                           | OAuth admin queries                                             | Building OAuth admin features         |
| `oauth-device-codes.queries.ts`                    | OAuth device code queries                                       | Implementing device code flow         |
| `oauth-refresh-tokens.queries.ts`                  | OAuth refresh token queries                                     | Managing refresh tokens               |
| `oauth-refresh-tokens.queries.integration.test.ts` | OAuth refresh token integration tests                           | Testing refresh token logic           |
| `playback-analytics.queries.ts`                    | Playback analytics queries                                      | Building analytics features           |
| `search.queries.ts`                                | Search queries                                                  | Implementing search features          |
| `social.queries.ts`                                | Social/activity feed queries                                    | Building social features              |
| `suggestion-management.queries.ts`                 | AI suggestion CRUD operations                                   | Managing user suggestions             |
| `suggestion-search.queries.ts`                     | AI similarity search queries                                    | Building AI-powered recommendations   |
| `transcode-jobs.queries.ts`                        | Transcoding job queries                                         | Managing transcode jobs               |
| `user-excluded-series.queries.ts`                  | User excluded series queries                                    | Managing excluded series              |
| `user-excluded-series.queries.integration.test.ts` | User excluded series integration tests                          | Testing excluded series logic         |
| `user-preferences.queries.ts`                      | User preference queries                                         | Managing user preferences             |
| `user-preferences.queries.integration.test.ts`     | User preference integration tests                               | Testing preference logic              |
| `user-ratings.queries.ts`                          | User rating queries                                             | Managing user ratings                 |
| `user-ratings.queries.integration.test.ts`         | User rating integration tests                                   | Testing rating logic                  |
| `user-watch-history.queries.ts`                    | User watch history queries                                      | Querying watch history                |
| `user-watch-history.queries.integration.test.ts`   | User watch history integration tests                            | Testing watch history logic           |
| `watch-history.queries.ts`                         | Watch history queries                                           | Managing watch history                |
| `watch-history.queries.integration.test.ts`        | Watch history integration tests                                 | Testing watch history logic           |
| `watch-status.queries.ts`                          | Watch status queries                                            | Checking watch status                 |
| `watch-status.queries.integration.test.ts`         | Watch status integration tests                                  | Testing watch status logic            |

## Subdirectories

| Directory    | What                                                                 | When to read             |
| ------------ | -------------------------------------------------------------------- | ------------------------ |
| `builders/`  | SQL query builder utilities (4 builders)                             | Building complex queries |
| `filters/`   | Query filter helpers (watch history filters)                         | Filtering query results  |
| `fragments/` | Reusable SQL fragments (base media, JSONB extractors, watch history) | Reusing SQL patterns     |
| `resolvers/` | ID resolution queries (media ID resolver)                            | Resolving media IDs      |
