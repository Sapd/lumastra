# helpers/

Test isolation utilities — table truncation and targeted data cleanup.

## Files

| File         | What                                                                                               | When to read                                         |
| ------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `cleanup.ts` | `TEST_TABLES` constants, `truncateTables()`, `truncateAllTestTables()`, per-entity cleanup helpers | Setting up `beforeEach` cleanup in integration tests |
