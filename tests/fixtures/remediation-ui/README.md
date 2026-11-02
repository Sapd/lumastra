# Controlled admin remediation fixture

This standalone Vite harness renders the real repair, retry and attention components with browser-local API fixtures. It does not connect to a database or a production service. The database behavior is covered separately by `src/lib/server/services/admin-remediation.integration.test.ts` and the existing manual-link/merge integration tests.

From the application directory, with the project's dependencies installed:

```sh
npm run paraglide:compile
npx vite --config tests/fixtures/remediation-ui/vite.config.ts --host 127.0.0.1 --port 5199
```

- `/`: select the canonical provider result, confirm the identity conflict, review episode links, choose and add the canonical episode, then Save links. Cancel before saving leaves the write counter at zero. Close after saving, then merge. The fixture rejects a merge while both entries have files or when the wrong keeper is supplied; the status strip exposes the preserved resume values.
- `/?view=series-fileless`: the canonical series starts fileless. Merge remains disabled until the source file is reassigned, preserving the selected provider identity.
- `/?view=movie`: the file-bearing movie is retained and the selected provider identity is reapplied after merge, without an episode editor.
- `/?view=movie-failure`: the merge succeeds but the identity update fails once. The error reports partial completion; Confirm retries only the identity update.
- `/?view=retry`: Retry all failed items, then confirm. The fixture returns the actual restored count (3), preserves history and the operator skip, and returns zero for a repeat. Check the toast and the status strip.
- `/?view=attention`: operational codec/encryption/physical-damage guidance points at the pipeline; the separate identity example points at Fix matches.

Reload to reset fixture state. The fixture uses real client schemas and rejects an invalid target episode/keeper. It is a UI inspection aid, not a replacement for the real database tests.
