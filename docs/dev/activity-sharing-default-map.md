<!--
SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
SPDX-License-Identifier: AGPL-3.0-only
-->

# Activity sharing: implementation map

## Stored choices and writers

`users.hide_streams` is the master visibility opt-out (true = private).
`share_audiobook_activity` controls audiobook activity; `share_listening_activity`
controls the reciprocal coarse listening tier. There is no separate ratings switch:
ratings, watching and authored community content use the master visibility flag,
with activity audience restrictions where the visibility builder is used.

Migration `16.350.0_sharing_off_by_default.ts` changed the database defaults to
true/false/false and backfilled only `privacy_prefs_updated_at IS NULL` users.
The self-service UI is `src/lib/components/settings/PrivacySection.svelte`, backed
by `src/lib/api/user.ts` and `api/defs/user/stream-privacy.ts` (GET/POST mounted on
internal and v1 surfaces). `api/defs/me/privacy.ts` also delegates public
`GET/PATCH /api/v1/me/privacy` to those same handlers. Every self-service write
marks the user's choice, even when reaffirming the current value.

The legacy admin UI (`routes/admin/users/+page.svelte` and
`components/admin/users/UserDetailDrawer.svelte`) uses
`api/defs/admin/settings/privacy-settings.ts` and
`queries/oauth-admin.queries.ts:setUserPrivacySetting` for the master flag.
Historically both this admin writer and self-service stamped
`privacy_prefs_updated_at`. Migration 16.415.0 therefore conservatively protects
all historical timestamped choices. Self-service and every admin per-user
override set `sharing_explicitly_set_by_user`, including edits of other accounts.
The existing column name is retained; it protects an explicit account-level
choice by either the user or an admin. Applying an instance default never sets it.

Writer sweep on the merged tree: the only production UPDATE writers are the
shared self-service handler, `setUserPrivacySetting` and
`applyActivitySharingDefault`. All six account INSERT paths below write defaults
without marking a choice. Migration 16.350.0 is historical and unchanged; the
base schema and task-runtime fixture INSERTs are not live preference writers.
No other sharing writers were found in `src/` or `scripts/` (including camelCase
API fields and snake_case SQL columns).

## Readers (production code, excluding tests and generated routes)

Paths below are relative to `src/lib/server/` unless specified otherwise.

| Reader | Use |
| --- | --- |
| `database/queries/builders/social-visibility.builder.ts` | Shared activity visibility, audience, reciprocal listening tier and per-item privacy |
| `database/queries/social.queries.ts` | Community progress, watching/listening and ratings via the builder |
| `database/queries/social-activity.queries.ts` | Activity feeds, annotations and reciprocal listening recency |
| `database/queries/media-annotations.queries.ts` | Authored chats, pins and reviews |
| `database/queries/users.queries.ts` | User rows, directory/invite searches; exact-name invite lookup can resolve hidden users |
| `database/queries/oauth-admin.queries.ts` | Hidden-user list for admin privacy editing |
| `services/active-sessions-view.service.ts` | Session visibility; own sessions and authorized admin views remain available |
| `services/audiobookshelf-direct-sessions.service.ts` | Resolves ABS identity before session privacy filtering |
| `api/defs/catalog/media-id-listening-sharing.ts` | Reports audiobook sharing blockers |
| `api/defs/stats/users-id.ts` | Other-user stats visibility; authorized admin bypass |
| `api/defs/integrations/social-watch-activity.ts` | Shared watch activity |
| `api/defs/admin/settings/social-audience.ts` | Current audience and sharing counts |
| `api/defs/user/stream-privacy.ts`, `api/defs/user/settings.ts` | Own settings reads |
| `database/queries/gdpr-export.queries.ts` | Account export |
| `mappers/user.mapper.ts`, `src/lib/schemas/user.ts` | Maps master flag into user responses |
| `src/routes/api/ai/users/+server.ts` | Admin user data |
| `src/routes/api/v1/stats/users/[id]/+server.ts` | Re-exported stats handler |
| `src/routes/(proprietary)/j/Users/[userId]/+server.ts` | Compatibility user data |
| `proprietary/assistant-service.ts`, `proprietary/assistant-tools/get-active-streams.tool.ts` | Assistant activity and visible-session consumers |

Client readers: `PrivacySection.svelte`, the two admin user components above,
`src/lib/api/{user,admin}.ts`, config settings sections/search index, and the
response schemas in `src/lib/schemas/{api-user-responses,api-admin-responses,
api-ai-responses,admin,admin-types,api-admin-library-responses,gdpr}.ts`.
These API contracts and existing visibility restrictions are unchanged.

## Account creation

Every production `INSERT INTO users` now snapshots `DEFAULT_ACTIVITY_SHARING`
through `config/activity-sharing.ts` and writes all three flags on INSERT only.
Conflict updates preserve existing sharing.

| Query | Call path |
| --- | --- |
| `users.queries.ts:createNativeAdmin` | Built-in first admin through `native-auth.service.ts` |
| `users.queries.ts:adminCreateUser` | Admin-created password accounts through `admin-user.service.ts` |
| `users.queries.ts:insertFederatedUser` | OIDC and auth-provider plugin provisioning through `user-identity.service.ts`, including SSO bootstrap |
| `users.queries.ts:upsertUser` | Forward-auth provisioning, bootstrap and development default user |
| `oauth-admin.queries.ts:upsertUserGroups` | Group-sync fallback provisioning |
| `user-ratings.queries.ts:ensureUserExists` | Rating-service fallback provisioning |

There is no account signup/invitation acceptance path in this checkout.
Playlist invitations (`api/defs/playlists/[id]/{invite,members/index}.ts`) require
an existing user and do not provision accounts. Task-runtime fixture INSERTs are
test harnesses, not production account creation.

## Configuration, setup and bulk action

`DEFAULT_ACTIVITY_SHARING` is an on-by-default boolean in the `social` (Sharing &
Privacy) section, rendered under `/admin/settings/access`. It sets all three
sharing dimensions together for new accounts: `hide_streams=false`,
`share_listening_activity=true`, `share_audiobook_activity=true`. An admin can
switch the default off. Explicit INSERT values override the unchanged database
defaults from 16.350.0. Audience settings are independent.
It is a UI setting and is intentionally absent from `.env.example`.

`src/lib/config/setup-preferences.ts` maps `defaultActivitySharing` to the same
setting. The `/setup` load hydrates it, the wizard presents it pre-selected ON
in Privacy (preserving a saved OFF choice when resumed), and
`POST /api/setup/preferences` validates and persists it through `saveConfig`.
After a successful save of this field, setup applies the effective saved default
to all never-set accounts, including the owner created before this step. Explicit
user choices and admin per-user overrides are preserved. Omitted fields and failed
saves do not apply defaults. Setup audits the application with `source: 'setup'`.
The separate admin bulk action remains available after setup.

`GET /api/admin/activity-sharing-default` previews the saved default.
`POST` requires confirmation and the previewed value, rejects a stale value with
409, and updates only users whose explicit-choice marker is false. It skips
soft-deleted and unchanged rows. Repeating it returns zero changed accounts.
A later change of default can be applied again to the same untouched accounts.
The atomic UPDATE rechecks the marker under row contention with self-service.
The action audits `users.apply_activity_sharing_default` with the default and
changed count. Both the endpoint auth and exact route policy require admin.

## Website pages to update (no website files edited)

Website sources are in the separate `lumastra-docs` checkout. They were consulted
read-only to identify these pages.

- https://lumastra.org/guides/sharing-privacy/ — default, personal choice, protected bulk application.
- https://lumastra.org/guides/administration/ — Access settings, confirmation and audit event.
- https://lumastra.org/guides/configuration/ — UI setting, default on, no restart.
- https://lumastra.org/start/quick-start/ — setup Privacy field and bootstrap-admin behavior.
