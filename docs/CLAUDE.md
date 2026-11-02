# Documentation

> **User-, operator- and integrator-facing documentation is NOT in this tree.** It lives on
> the website, https://lumastra.org. Anything about
> _using_ Lumastra — install, configuration, deployment, administration, auth/SSO, backup,
> building a client — is edited there. This tree holds only contributor and code-coupled docs.
>
> Do not re-create install/admin/player guides here; update the website instead.

## Files

| File        | What                                         | When to read              |
| ----------- | -------------------------------------------- | ------------------------- |
| `README.md` | Index of this tree + pointers to the website | Finding any documentation |

## Subdirectories

| Directory       | What                                                                                                                                        | When to read                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `api/`          | API definition-layer notes and OpenAPI specs. `api/API.md` is served at runtime by `/api-docs?format=md` and `/llms.txt` — do not delete it | Working on API endpoints                            |
| `architecture/` | Code-coupled design docs (database, task-system schema, crossfade, `/j` security)                                                           | Understanding a subsystem before changing it        |
| `dev/`          | Contributor guides (quick-start, developer guide, lint rules, hazards)                                                                      | Implementing features, setting up a dev environment |
| `integrations/` | Guides for the read-only `/api/v1/integrations/*` endpoints (watch history; Homepage to follow), coupled to their defs                      | Changing an integration endpoint's contract or auth |
| `examples/`     | Runnable example stacks (Dex OIDC SSO)                                                                                                      | Testing an integration locally                      |
| `specs/`        | Provenance records (chromaprint clean-room validation)                                                                                      | Licensing / clean-room questions                    |
| `security/`     | Operator runbooks that are coupled to code paths (master-key rotation: what `POST /api/admin/secrets/rotate` covers and the swap sequence)  | Rotating the master key; adding a sealed store      |
