# setup/

Integration test database setup — connection management, migration runner, and Vitest configuration.

## Files

| File                             | What                                                                                                       | When to read                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `global-setup.ts`                | Vitest `globalSetup`: waits for the DB and applies migrations once per run                                 | Changing how the test schema is prepared              |
| `mock-reach.integration.test.ts` | Guard: a test file's `vi.mock` must reach server modules (fails if `vitest.setup.ts` preloads server code) | It fails, or you add imports to `vitest.setup.ts`     |
| `create-test-db.ts`              | Script to create the integration test database if it does not exist                                        | Setting up the test database for the first time       |
| `run-migrations.ts`              | Applies all schema migrations against the test DB; CLI supports `reset` subcommand                         | Adding new migrations to the test runner              |
| `test-database.ts`               | `getTestDb()` / `closeTestDb()` — singleton postgres connection for tests                                  | Accessing the shared test DB connection in test files |
| `vitest.setup.ts`                | Per-file setup; must not import server code (mocks would stop applying)                                    | Configuring per-file test lifecycle                   |
