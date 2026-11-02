# integration/

Vitest integration tests that run against a real PostgreSQL test database.

## Subdirectories

| Directory   | What                                                        | When to read                               |
| ----------- | ----------------------------------------------------------- | ------------------------------------------ |
| `fixtures/` | Test data factories for media items, episodes, users        | Creating test data in integration tests    |
| `helpers/`  | Table truncation and cleanup utilities for test isolation   | Managing test database state between tests |
| `setup/`    | Database connection, migration runner, Vitest configuration | Configuring the integration test database  |
