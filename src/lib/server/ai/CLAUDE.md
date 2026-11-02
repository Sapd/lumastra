# ai/

AI recommendation system using OpenAI embeddings, metadata sync, and batch generation.

## Files

| File                          | What                                                                                                                                                                                                                                                                               | When to read                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `batch-embeddings.ts`         | Batch embedding generation coordinator                                                                                                                                                                                                                                             | Running bulk embedding generation           |
| `dual-embedding-generator.ts` | Legacy generator. NOTE: "dual"/"both" = the two embedding SOURCES (library vs discovery), NOT metadata-vs-cast/crew (no cast/crew vector exists). An item holds exactly ONE source at a time (mutually exclusive by `has_files`); the active path is `embedding-only-generator.ts` | Understanding embedding architecture        |
| `embedding-only-generator.ts` | Single embedding generator                                                                                                                                                                                                                                                         | Generating embeddings without metadata sync |
| `embedding-text-formatter.ts` | Embedding text formatting (title, overview, cast)                                                                                                                                                                                                                                  | Debugging embedding content or format       |
| `embedding-utils.ts`          | Embedding utility functions (normalization, scoring)                                                                                                                                                                                                                               | Working with embedding vectors              |
| `list-sync.ts`                | Curated list synchronization                                                                                                                                                                                                                                                       | Syncing curated recommendation lists        |
| `mdblist-sync-generator.ts`   | MDBList sync generator                                                                                                                                                                                                                                                             | Syncing MDBList metadata                    |
| `mdblist-sync.ts`             | MDBList data synchronization                                                                                                                                                                                                                                                       | Importing data from MDBList                 |
| `openai.ts`                   | OpenAI API client (`text-embedding-3-small`)                                                                                                                                                                                                                                       | Generating embeddings via OpenAI            |
| `sync-missing-metadata.ts`    | Missing metadata backfill script                                                                                                                                                                                                                                                   | Backfilling incomplete metadata             |
| `tmdb-metadata-sync.ts`       | TMDB metadata synchronization                                                                                                                                                                                                                                                      | Syncing TMDB data to database               |
| `voyage.ts`                   | Voyage AI client (alternative to OpenAI)                                                                                                                                                                                                                                           | Using Voyage AI embeddings                  |

## Tests

| File                                  | What                             | When to read                      |
| ------------------------------------- | -------------------------------- | --------------------------------- |
| `database.test.ts`                    | AI database operation tests      | Debugging embedding queries       |
| `dual-embedding-generator.test.ts`    | Dual embedding generator tests   | Testing embedding generation      |
| `embedding.integration.test.ts`       | Embedding integration tests      | Testing end-to-end embedding flow |
| `recommendations.integration.test.ts` | Recommendation integration tests | Testing recommendation algorithms |
| `valkey.integration.test.ts`          | Valkey integration tests         | Testing cache integration         |
| `valkey.test.ts`                      | Valkey unit tests                | Testing cache operations          |
