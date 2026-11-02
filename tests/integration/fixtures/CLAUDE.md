# fixtures/

Test data factories for integration tests — build and insert records into the test database.

## Files

| File                         | What                                                        | When to read                               |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `index.ts`                   | Barrel export for all fixture factories                     | Importing fixtures in integration tests    |
| `media.fixtures.ts`          | `createTestMediaItem` / `insertTestMediaItem` factories     | Creating movie or episode rows in tests    |
| `episode.fixtures.ts`        | Episode-specific test data factories                        | Creating episode rows with series linkage  |
| `session.fixtures.ts`        | Watch history entry test data factories                     | Creating watch history rows in tests       |
| `user.fixtures.ts`           | User profile and preference test data factories             | Creating user rows in tests                |
| `library-access.fixtures.ts` | Places an item in a library group the access filter can see | Writing differential access-boundary tests |

## Traps

- `createAndInsertTestSeries` takes its TMDB id from a small sample list. Pass an explicit, unique
  `tmdbId` when one test seeds more than one series, or the `external_ids` unique key fails now and
  then.
- A primary-provider external id must be numeric (the table has a CHECK); a made-up string id is
  rejected.
- Series, seasons, artists and albums never own file rows. Put them in a library group with
  `placeInLibraryGroup`; do not attach a file row to a container, or a broken access filter looks
  correct. More in `docs/dev/testing-traps.md`.
