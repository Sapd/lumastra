# Lumastra — repository documentation

> ## 📖 User, operator and integrator documentation lives at **[lumastra.org](https://lumastra.org)**
>
> Installing, configuring, deploying, running and integrating with Lumastra is documented
> on the website — not here. Start at
> **[lumastra.org/start/quick-start](https://lumastra.org/start/quick-start/)**.
>
> This `docs/` tree keeps only what is coupled to the code in this repository:
> contributor guides, internal architecture references, and the machine-readable API specs.

## Where things live

| You want to…                           | Go to                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Install, configure or deploy Lumastra  | [lumastra.org/start/quick-start](https://lumastra.org/start/quick-start/)                     |
| Configure environment variables        | [lumastra.org/guides/configuration](https://lumastra.org/guides/configuration/)               |
| Run and administer a server            | [lumastra.org/guides/administration](https://lumastra.org/guides/administration/)             |
| Set up authentication / SSO            | [lumastra.org/guides/authentication](https://lumastra.org/guides/authentication/)             |
| Back up, restore or rotate keys        | [lumastra.org/guides/backup-recovery](https://lumastra.org/guides/backup-recovery/)           |
| Troubleshoot the task system           | [lumastra.org/guides/task-troubleshooting](https://lumastra.org/guides/task-troubleshooting/) |
| Build a client, player or integration  | [lumastra.org/developers/api](https://lumastra.org/developers/api/)                           |
| Browse the interactive API reference   | [lumastra.org/reference](https://lumastra.org/reference/)                                     |
| **Contribute code to this repository** | the tables below                                                                              |

## Contributor guides

| Guide                                                   | What                                             |
| ------------------------------------------------------- | ------------------------------------------------ |
| [Quick Start](dev/QUICK-START.md)                       | Development commands, local setup, testing       |
| [Real Live TV E2E](dev/livetv-e2e.md) | Synthetic provider, playback sessions, proxy and runner runbook |
| [Developer Guide](dev/DEVELOPER-GUIDE.md)               | API reference, utilities, patterns               |
| [Interaction Model](dev/INTERACTION-MODEL.md)           | Media card interaction philosophy                |
| [Silent Default Hazards](dev/silent-default-hazards.md) | Defaults that hide bugs — read before adding one |
| [Media-Type Vocabulary](dev/media-type-vocabulary.md)   | Why the DB says `tv` and the API says `series`   |
| [ESLint Exceptions](dev/eslint-exceptions.md)           | Documented ESLint rule exceptions                |
| [Callback Type Rules](dev/lint-rules/callback-types.md) | Custom ESLint callback-safety rules              |

## Architecture references

Code-coupled design docs. Conceptual/architectural overviews for readers rather than
contributors are on the website under
[lumastra.org/architecture](https://lumastra.org/architecture/overview/).

| Document                                                                     | What                                   |
| ---------------------------------------------------------------------------- | -------------------------------------- |
| [Database Architecture](architecture/database-architecture.md)               | Three-tier DB design, migrations       |
| [Task System Schema](architecture/task-system-schema.md)                     | Raw DDL + Valkey key reference         |
| [Continue Watching](architecture/continue-watching.md)                       | Continue-watching data model           |
| [Social Sharing](architecture/social-sharing.md)                             | Circles, activity, playlist sharing    |
| [Music Crossfade](architecture/music-crossfade.md)                           | DJ crossfade architecture              |
| [Request Status State Machine](architecture/request-status-state-machine.md) | Media-request status logic             |
| [HLS Timeline Invariants](architecture/hls-timeline-invariants.md)           | What must stay aligned in HLS output   |
| [Jellyfin Compat Security](architecture/jellyfin-compat-security.md)         | Security posture of `/j` + `/subsonic` |

## Integrations

Read-only `/api/v1/integrations/*` endpoints for third-party tools, meant to be read with an admin
service token bound to its path.

| Guide                                          | What                                           |
| ---------------------------------------------- | ---------------------------------------------- |
| [Watch history](integrations/watch-history.md) | One user's watch history for a recommender bot |

## API specifications

| Document                                   | What                                             |
| ------------------------------------------ | ------------------------------------------------ |
| [API README](api/README.md)                | How the API definition layer is organised        |
| [API.md](api/API.md)                       | Long-form API notes — also served at `/llms.txt` |
| [api-v1.yaml](api/api-v1.yaml)             | OpenAPI spec for the public `/api/v1` surface    |
| [internal-api.yaml](api/internal-api.yaml) | OpenAPI spec for internal endpoints              |
| [openapi.yaml](api/openapi.yaml)           | Combined OpenAPI spec                            |

> `api/API.md` is **not** a duplicate of the website — it is read at runtime by
> `/api-docs?format=md` and `/llms.txt`. Keep it in the repository.

## Other

| Document                                                                       | What                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| [OIDC SSO example (Dex)](examples/oidc-sso-dex/README.md)                      | Runnable local OIDC test stack                     |
| [Chromaprint clean-room validation](specs/chromaprint-cleanroom-validation.md) | Clean-room rewrite provenance record               |
| [Master-key rotation runbook](security/master-key-rotation.md)                 | What rotation re-seals, the swap sequence, backups |

---

**Editing docs?** If the change is about _using_ Lumastra, it belongs on
[lumastra.org](https://lumastra.org). If it is about
_building_ Lumastra, it belongs here.
