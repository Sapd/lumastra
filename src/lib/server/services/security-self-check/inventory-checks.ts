// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security Self-Check — Tier 4 inventory checks.
 *
 * Read-only COUNT queries over PAT and service-token tables to surface
 * risky token postures. Emits counts and non-secret identifiers
 * (token_prefix, name) only — never hashes or plaintext secrets.
 */

import type postgres from 'postgres';
import type { SecuritySelfCheckFinding } from '$lib/schemas/security-self-check';
import { finding } from './finding';
import {
    getLegacyConfigEnvelopeKeys,
    getUndecryptableConfigKeys,
} from '$lib/server/config/config.service.js';
import { openSecret, decrypt, deriveMasterKey } from '$lib/server/crypto/secret-box.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import { forwardAuthTrustPosture, clientIpProxiesPinned } from '$lib/server/utils/client-ip.js';
import { tokenContext } from '$lib/server/subsonic-compat/auth.js';
import { credentialContext } from '$lib/server/database/queries/livetv-sources.queries.js';
import {
    pluginSecretContext,
    pluginUserCredentialContext,
    jellyfinClientPasswordContext,
} from '$lib/server/tasks/secrets.js';
import {
    operatorWebhookSecretContext,
    userWebhookSecretContext,
} from '$lib/server/tasks/webhook-outbox.js';

// ---------------------------------------------------------------------------
// Row types (private — only what the COUNT queries return)
// ---------------------------------------------------------------------------

interface PatNonExpiringCountRow {
    total: string;
    admin_scoped: string;
}

interface ServiceTokenRiskyCountRow {
    count: string;
}

/** One row of COUNT(*)::text values, one per sealed store. */
interface LegacyEnvelopeCountRow {
    subsonic_plaintext: string;
    subsonic_unbound: string;
    jellyfin_unbound: string;
    livetv_unbound: string;
    webhook_unbound: string;
    plugin_unbound: string;
}

/** Parse a COUNT(*)::text value to a non-negative integer; never NaN. */
function toCount(value: string | undefined): number {
    const n = Number.parseInt(value ?? '0', 10);
    return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Individual check helpers — exported for unit-testability
// ---------------------------------------------------------------------------

/**
 * Determine the PAT non-expiring finding from raw count row.
 * Pure function — safe to unit test without a real DB.
 */
export function evaluateNonExpiringPats(row: {
    total: number;
    adminScoped: number;
}): SecuritySelfCheckFinding {
    const { total, adminScoped } = row;

    if (total === 0) {
        return finding({
            id: 'inventory.nonexpiring-admin-pats',
            method: 'token',
            type: 'inventory',
            status: 'pass',
            title: 'No non-expiring PATs',
            detail: 'All active personal access tokens have an expiry date set.',
            evidence: 'personal_access_tokens.expires_at',
        });
    }

    const adminNote = adminScoped > 0 ? ` (${adminScoped} with admin scope)` : '';
    return finding({
        id: 'inventory.nonexpiring-admin-pats',
        method: 'token',
        type: 'inventory',
        status: 'warn',
        title: 'Non-expiring PATs detected',
        detail: `${total} active personal access token(s) have no expiry date${adminNote}. Non-expiring tokens remain valid indefinitely and increase exposure if compromised.`,
        remediation:
            'Revoke non-expiring PATs and re-issue them with an expiry date, or set expires_at via the admin token management panel.',
        evidence: 'personal_access_tokens.expires_at',
    });
}

/**
 * Determine the admin service-token finding from a raw count.
 * Pure function — safe to unit test without a real DB.
 */
export function evaluateRiskyServiceTokens(count: number): SecuritySelfCheckFinding {
    if (count === 0) {
        return finding({
            id: 'inventory.admin-service-tokens',
            method: 'token',
            type: 'inventory',
            status: 'pass',
            title: 'No unrestricted admin service tokens',
            detail: 'No active service tokens combine admin scope, no expiry, and no IP allowlist.',
            evidence:
                'service_tokens.scopes, service_tokens.expires_at, service_tokens.allowed_ips',
        });
    }

    return finding({
        id: 'inventory.admin-service-tokens',
        method: 'token',
        type: 'inventory',
        status: 'warn',
        title: 'Unrestricted admin service tokens detected',
        detail: `${count} active service token(s) have admin scope, no expiry, and no IP allowlist. These tokens provide permanent, unrestricted admin access if leaked.`,
        remediation:
            'Add an expiry date or IP allowlist to each flagged service token, or revoke unused tokens via /admin/settings/service-tokens.',
        evidence: 'service_token.service.ts:243,409; service_tokens.scopes',
    });
}

/**
 * Live TV sources whose Xtream credentials are still plaintext at rest.
 *
 * `livetv_sources.xtream_username` / `xtream_password` are sealed with the
 * master key since security review 2026-09-12 (C8), and an xtream source's
 * playlist/EPG URLs are stored without the `username=`/`password=` query. Rows
 * written before that keep their plaintext until the next save re-seals them,
 * so this rule counts them. Pure function — safe to unit test without a DB.
 */
export function evaluateUnsealedLiveTvCredentials(count: number): SecuritySelfCheckFinding {
    if (count === 0) {
        return finding({
            id: 'inventory.livetv-plaintext-credentials',
            method: 'secrets',
            type: 'inventory',
            status: 'pass',
            title: 'Live TV provider credentials are sealed',
            detail: 'Every Live TV source stores its Xtream username and password sealed with the master key, and no playlist or EPG URL carries them in the clear.',
            evidence:
                'livetv_sources.xtream_username, livetv_sources.xtream_password, livetv_sources.m3u_url, livetv_sources.xmltv_url',
        });
    }

    return finding({
        id: 'inventory.livetv-plaintext-credentials',
        method: 'secrets',
        type: 'inventory',
        status: 'warn',
        title: 'Live TV provider credentials are stored unencrypted',
        detail: `${count} Live TV source(s) still hold their Xtream username/password — or a playlist/EPG URL containing them — in plaintext. These rows were written before encryption at rest was added. Anyone with a database dump, replica or backup can read a working IPTV subscription out of them.`,
        remediation:
            'Open each source in Live TV → Sources and re-save it: the next write seals the credentials with the master key and stores the URLs without them. Requires a resolvable LUMASTRA_MASTER_KEY (or a writable config dir for the generated master.key).',
        evidence:
            'livetv-sources.queries.ts createSource/updateSource; livetv_sources.xtream_password',
    });
}

/**
 * Sealed values that are not (yet) bound to the row they live in.
 *
 * Every count is "values in this store that an attacker with database write
 * access could still transplant into another row" — a legacy `enc:v1:`
 * envelope, an unbound BYTEA blob, or, for Subsonic, a pre-encryption plaintext
 * token. See {@link evaluateLegacySecretEnvelopes}.
 */
export interface LegacyEnvelopeCounts {
    /** `subsonic_client_passwords` rows still holding the plaintext column. */
    subsonicPlaintext: number;
    subsonicUnbound: number;
    jellyfinUnbound: number;
    livetvUnbound: number;
    webhookUnbound: number;
    pluginUnbound: number;
    /**
     * `settings.json` values still sealed `enc:v1:`. NOT a COUNT query — that
     * store is a file on the config volume, so the config service reports it
     * (`getLegacyConfigEnvelopeKeys`). Leaving it out made this check answer
     * "everything is bound" for an install whose config secrets were not.
     */
    configUnbound: number;
}

/**
 * Sealed values that carry no row binding (security review 2026-09-13, C19).
 *
 * AES-GCM envelopes written before C19 authenticate the ciphertext but say
 * nothing about WHICH row they belong to, so anyone who can write to the
 * database can copy one row's value into another and have a reveal endpoint
 * decrypt it in the wrong context. Values written since are bound to their row
 * (`enc:v2:`), and existing ones are upgraded by a master-key rotation — which
 * is why the remediation is "Rotate Master Key" and not "re-enter everything".
 *
 * The read paths still accept unbound values on purpose: refusing them would
 * lock every pre-upgrade install out of its own credentials. That is exactly
 * why the residue needs counting rather than assuming.
 *
 * Pure function — safe to unit test without a DB.
 */
export function evaluateLegacySecretEnvelopes(
    counts: LegacyEnvelopeCounts,
): SecuritySelfCheckFinding {
    const stores: Array<[number, string]> = [
        [counts.subsonicUnbound, `subsonic_client_passwords (${counts.subsonicUnbound})`],
        [counts.jellyfinUnbound, `jellyfin_client_passwords (${counts.jellyfinUnbound})`],
        [counts.livetvUnbound, `livetv_sources (${counts.livetvUnbound})`],
        [
            counts.webhookUnbound,
            `task_webhook_hooks + user_notification_webhooks (${counts.webhookUnbound})`,
        ],
        [
            counts.pluginUnbound,
            `plugin_secrets + plugin_user_credentials (${counts.pluginUnbound})`,
        ],
        [counts.configUnbound, `settings.json (${counts.configUnbound})`],
    ];
    const affected = stores.filter(([n]) => n > 0).map(([, label]) => label);
    const total = stores.reduce((sum, [n]) => sum + n, 0);

    if (total === 0 && counts.subsonicPlaintext === 0) {
        return finding({
            id: 'inventory.legacy-secret-envelopes',
            method: 'secrets',
            type: 'inventory',
            status: 'pass',
            title: 'Every stored secret is bound to its own row',
            detail: 'All sealed credentials — every database store and settings.json — use the row-bound envelope, so a value copied from one row into another no longer decrypts.',
            evidence: 'crypto/secret-box.ts enc:v2 envelope; subsonic_client_passwords.token',
        });
    }

    const plaintextNote =
        counts.subsonicPlaintext > 0
            ? ` ${counts.subsonicPlaintext} Subsonic token(s) are also still stored as PLAINTEXT in subsonic_client_passwords.token (pre-encryption rows); those are sealed on the owner's next login or by the same rotation.`
            : '';

    return finding({
        id: 'inventory.legacy-secret-envelopes',
        method: 'secrets',
        type: 'inventory',
        status: 'warn',
        title: 'Stored secrets are not bound to their row',
        detail:
            `${total} sealed value(s) were written before secrets were bound to the row they live in, in: ${
                affected.join(', ') || 'none'
            }. They still decrypt correctly, but anyone who can WRITE to the database can copy one into another row — another user's Subsonic token into their own, say — and have the reveal endpoint hand back the plaintext.` +
            plaintextNote,
        remediation:
            'Run Admin → Secrets → Rotate Master Key: it re-seals every store bound to its own row. (Rotation needs the current key as both old and new if you do not want to change the key itself.)',
        evidence: 'crypto/secret-box.ts enc:v1 vs enc:v2; admin/secrets-rotate.handler.ts',
    });
}

/**
 * Per-store count of "bound-but-unopenable" values: rows whose envelope IS
 * the row-bound `enc:v2:` format, but that FAIL to open under the current
 * master key with the row's OWN AAD context (the same context builder its
 * real read path uses).
 *
 * This is a different, stronger signal than
 * {@link evaluateLegacySecretEnvelopes} (which counts `enc:v1:` — never
 * opened, so its openability is unknown either way): a `v2` envelope that
 * won't open under ITS OWN row's context means the AAD contract has drifted
 * since the value was sealed — e.g. a context builder changed shape (a
 * differently-cased id, a reordered/renamed segment), or a v1 value was
 * "transplanted" into a v2-looking column by hand. Both leave the value
 * permanently unreadable by its legitimate row, which is exactly the
 * failure mode security review 2026-09-13 (C19)'s row-binding was meant to
 * make LOUD instead of silently wrong.
 */
export interface UnopenableSecretCounts {
    subsonicUnopenable: number;
    jellyfinUnopenable: number;
    livetvUnopenable: number;
    webhookUnopenable: number;
    pluginUnopenable: number;
    /** `settings.json` values that failed to decrypt on load — see `config.service.ts`'s `getUndecryptableConfigKeys()`. */
    configUnopenable: number;
}

/**
 * Determine the bound-but-unopenable finding from raw per-store counts.
 * Pure function — safe to unit test without a real DB.
 */
export function evaluateUnopenableSecrets(
    counts: UnopenableSecretCounts,
): SecuritySelfCheckFinding {
    const stores: Array<[number, string]> = [
        [counts.subsonicUnopenable, `subsonic_client_passwords (${counts.subsonicUnopenable})`],
        [counts.jellyfinUnopenable, `jellyfin_client_passwords (${counts.jellyfinUnopenable})`],
        [counts.livetvUnopenable, `livetv_sources (${counts.livetvUnopenable})`],
        [
            counts.webhookUnopenable,
            `task_webhook_hooks + user_notification_webhooks (${counts.webhookUnopenable})`,
        ],
        [
            counts.pluginUnopenable,
            `plugin_secrets + plugin_user_credentials (${counts.pluginUnopenable})`,
        ],
        [counts.configUnopenable, `settings.json (${counts.configUnopenable})`],
    ];
    const affected = stores.filter(([n]) => n > 0).map(([, label]) => label);
    const total = stores.reduce((sum, [n]) => sum + n, 0);

    if (total === 0) {
        return finding({
            id: 'inventory.bound-unopenable-secrets',
            method: 'secrets',
            type: 'inventory',
            status: 'pass',
            title: 'Every row-bound secret opens under its own context',
            detail: 'Every enc:v2 (row-bound) value across every sealed store decrypts successfully under the current master key and its own row context.',
            evidence: 'crypto/secret-box.ts decrypt/openSecret; per-store AAD context builders',
        });
    }

    return finding({
        id: 'inventory.bound-unopenable-secrets',
        method: 'secrets',
        type: 'inventory',
        status: 'warn',
        title: 'Row-bound secrets that fail to open under their own context',
        detail:
            `${total} value(s) carry the row-bound enc:v2 envelope but FAIL to decrypt under ` +
            `the current master key with their own row's context, in: ${affected.join(', ')}. ` +
            'This usually means the AAD context contract drifted after the value was sealed (a ' +
            'context builder changed shape) or a value was copied between rows by hand. These ' +
            'values are effectively lost to their owning feature until re-saved.',
        remediation:
            'Investigate before rotating — a master-key rotation only re-seals values it can ' +
            'already OPEN, so an unopenable value stays unopenable across a rotation too. Check ' +
            'server logs for the specific row (self-check evidence names the store) and have the ' +
            'owner re-save the credential/secret from the relevant admin UI.',
        evidence: 'crypto/secret-box.ts enc:v2 envelope; per-store AAD context builders',
    });
}

/**
 * Determine the `require_single_ip` posture finding from a raw row count and
 * the current forward-auth trust posture. Pure function — safe to unit test
 * without a real DB (security fix C15, 2026-09-16).
 *
 * `require_single_ip` compares each new session's resolved client IP against
 * an existing active session's stored one. `getClientIpStrictFromRequest`
 * (the mint's resolver as of this fix) only reads a distinct value per client
 * from `X-Forwarded-For` when `TRUSTED_PROXY_IPS` is pinned (posture =
 * `allowlist`) — when it is not, the strict resolver falls back to the raw
 * TCP peer, so every client behind the SAME reverse proxy collapses to that
 * one address and the comparison can never see two different IPs. The
 * control does not fail OPEN (no bypass is granted), it simply never trips —
 * an operator who turned it on believing it enforces one-IP-per-account
 * would not otherwise learn that it is a no-op in their deployment.
 */
export function evaluateSingleIpPolicyPosture(
    rowsWithSingleIp: number,
    posture: ReturnType<typeof forwardAuthTrustPosture>,
): SecuritySelfCheckFinding {
    if (rowsWithSingleIp === 0 || posture === 'allowlist') {
        return finding({
            id: 'inventory.single-ip-policy-posture',
            method: 'forward-auth',
            type: 'inventory',
            status: 'pass',
            title: 'require_single_ip posture is enforceable where configured',
            detail:
                rowsWithSingleIp === 0
                    ? 'No user_stream_policies row sets require_single_ip=true.'
                    : `${rowsWithSingleIp} user_stream_policies row(s) set require_single_ip=true, and TRUSTED_PROXY_IPS is pinned (allowlist posture) — the strict client-IP resolver reads a distinct value per client, so the control can actually enforce.`,
            evidence:
                'user_stream_policies.require_single_ip; client-ip.ts:getClientIpStrictFromRequest',
        });
    }

    return finding({
        id: 'inventory.single-ip-policy-posture',
        method: 'forward-auth',
        type: 'inventory',
        status: 'warn',
        title: 'require_single_ip is enabled but cannot enforce per-client without a pinned proxy',
        detail: `${rowsWithSingleIp} user_stream_policies row(s) set require_single_ip=true, but the forward-auth proxy posture is "${posture}" (TRUSTED_PROXY_IPS unset). The strict client-IP resolver behind this check falls back to the raw TCP peer when unpinned, so every client behind the same reverse proxy resolves to ONE address and the "different IP" comparison this control depends on can never trip — it silently never enforces in this state.`,
        remediation:
            'Set TRUSTED_PROXY_IPS to your reverse-proxy IP(s) so the strict resolver reads a distinct client IP per request, or disable require_single_ip for the affected user(s)/default policy if per-IP enforcement is not actually needed.',
        evidence:
            'user_stream_policies.require_single_ip; client-ip.ts:getClientIpStrictFromRequest',
    });
}

/**
 * Count `user_stream_policies` rows with `require_single_ip = true` and pair
 * it with the current forward-auth trust posture.
 *
 * Table: user_stream_policies
 */
async function checkSingleIpPolicyPosture(sql: postgres.Sql): Promise<SecuritySelfCheckFinding> {
    const rows = await sql<ServiceTokenRiskyCountRow[]>`
        SELECT COUNT(*)::text AS count
        FROM user_stream_policies
        WHERE require_single_ip = true
    `;
    const count = toCount(rows[0]?.count);
    // `allowlist` here only means "the strict resolver reads a distinct client IP": a
    // CLIENT_IP_PROXY_IPS list (Helm router) achieves that without any identity trust.
    return evaluateSingleIpPolicyPosture(
        count,
        clientIpProxiesPinned() ? 'allowlist' : forwardAuthTrustPosture(),
    );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run all Tier 4 inventory checks against the live database.
 *
 * Each check is isolated — a failure in one does NOT abort the others.
 * On query error, an `error`-status finding is emitted for the affected check.
 *
 * @param sql - postgres.Sql connection (query-module convention: first param)
 */
export async function runInventoryChecks(sql: postgres.Sql): Promise<SecuritySelfCheckFinding[]> {
    const results = await Promise.allSettled([
        checkNonExpiringPats(sql),
        checkRiskyServiceTokens(sql),
        checkUnsealedLiveTvCredentials(sql),
        checkLegacySecretEnvelopes(sql),
        // Runs BEFORE checkUnopenableSecrets (which issues 7 sequential
        // queries of its own) so this single-query check's mock-queue slot
        // in tests lands right after the four checks above it, rather than
        // interleaving mid-way through checkUnopenableSecrets's chain.
        checkSingleIpPolicyPosture(sql),
        checkUnopenableSecrets(sql),
    ]);

    const findings: SecuritySelfCheckFinding[] = [];

    for (const result of results) {
        if (result.status === 'fulfilled') {
            findings.push(result.value);
        } else {
            // result.reason is unknown — extract a safe message
            const reason =
                result.reason instanceof Error ? result.reason.message : String(result.reason);
            findings.push(
                finding({
                    id: 'inventory.error',
                    method: 'token',
                    type: 'inventory',
                    status: 'error',
                    title: 'Inventory check failed',
                    detail: `A token inventory query could not complete: ${reason}`,
                }),
            );
        }
    }

    return findings;
}

// ---------------------------------------------------------------------------
// Private check implementations
// ---------------------------------------------------------------------------

/**
 * Count active PATs with no expiry date.
 * Flags admin-scoped ones separately in the detail message.
 *
 * Table: personal_access_tokens
 * Active = revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
 * Non-expiring = expires_at IS NULL
 * Admin-scoped = 'admin' = ANY(scopes)
 */
async function checkNonExpiringPats(sql: postgres.Sql): Promise<SecuritySelfCheckFinding> {
    const rows = await sql<PatNonExpiringCountRow[]>`
        SELECT
            COUNT(*)::text                                                        AS total,
            COUNT(*) FILTER (WHERE 'admin' = ANY(scopes))::text                  AS admin_scoped
        FROM personal_access_tokens
        WHERE revoked_at IS NULL
          AND expires_at IS NULL
    `;

    const row = rows[0];
    const total = toCount(row?.total);
    const adminScoped = toCount(row?.admin_scoped);

    return evaluateNonExpiringPats({ total, adminScoped });
}

/**
 * Count active service tokens that are simultaneously:
 *   - admin-scoped ('admin' = ANY(scopes))
 *   - have no expiry (expires_at IS NULL)
 *   - have no IP allowlist (allowed_ips IS NULL or empty array)
 *
 * This is the "triple-open" posture that provides permanent unrestricted access.
 * Default scope for service tokens is ['admin'] (service-token.service.ts:243).
 *
 * Table: service_tokens
 */
async function checkRiskyServiceTokens(sql: postgres.Sql): Promise<SecuritySelfCheckFinding> {
    const rows = await sql<ServiceTokenRiskyCountRow[]>`
        SELECT COUNT(*)::text AS count
        FROM service_tokens
        WHERE revoked_at IS NULL
          AND expires_at IS NULL
          AND 'admin' = ANY(scopes)
          AND (
              allowed_ips IS NULL
              OR array_length(allowed_ips, 1) IS NULL
              OR array_length(allowed_ips, 1) = 0
          )
    `;

    const count = toCount(rows[0]?.count);
    return evaluateRiskyServiceTokens(count);
}

/**
 * Count Live TV sources with plaintext Xtream credentials or credentialed URLs.
 * A sealed value starts with an `enc:v<N>:` envelope prefix (see
 * crypto/secret-box). BOTH versions count as sealed here — `enc:v2:` is the
 * row-bound form, and a v1 value is not plaintext, it is merely un-upgraded,
 * which `inventory.legacy-secret-envelopes` reports instead.
 */
async function checkUnsealedLiveTvCredentials(
    sql: postgres.Sql,
): Promise<SecuritySelfCheckFinding> {
    const rows = await sql<ServiceTokenRiskyCountRow[]>`
        SELECT COUNT(*)::text AS count
        FROM livetv_sources
        WHERE (xtream_password IS NOT NULL AND xtream_password <> ''
               AND xtream_password NOT LIKE 'enc:v1:%' AND xtream_password NOT LIKE 'enc:v2:%')
           OR (xtream_username IS NOT NULL AND xtream_username <> ''
               AND xtream_username NOT LIKE 'enc:v1:%' AND xtream_username NOT LIKE 'enc:v2:%')
           OR (source_type = 'xtream' AND (m3u_url LIKE '%password=%' OR xmltv_url LIKE '%password=%'))
    `;

    const count = toCount(rows[0]?.count);
    return evaluateUnsealedLiveTvCredentials(count);
}

/**
 * Count sealed values that carry no row binding, per store.
 *
 * String columns are matched on the `enc:v1:` prefix. The BYTEA columns have no
 * textual prefix, so they are matched the other way round — a bound blob STARTS
 * with the 7 ASCII bytes `enc:v2:` (see crypto/secret-box.ts), and anything
 * else is a legacy blob. `convert_to` spells those bytes without a hex literal
 * a reader would have to decode by hand.
 */
async function checkLegacySecretEnvelopes(sql: postgres.Sql): Promise<SecuritySelfCheckFinding> {
    // `enc:v2:` as the 7 raw bytes a row-bound blob starts with. All four BYTEA
    // columns are NOT NULL, so a row that does not start with them is a legacy
    // blob rather than an empty one.
    const rows = await sql<LegacyEnvelopeCountRow[]>`
        SELECT
            (SELECT COUNT(*) FROM subsonic_client_passwords
              WHERE token IS NOT NULL AND token_sealed IS NULL)::text        AS subsonic_plaintext,
            (SELECT COUNT(*) FROM subsonic_client_passwords
              WHERE token_sealed LIKE 'enc:v1:%')::text                      AS subsonic_unbound,
            (SELECT COUNT(*) FROM jellyfin_client_passwords
              WHERE password_sealed LIKE 'enc:v1:%')::text                   AS jellyfin_unbound,
            (SELECT COUNT(*) FROM livetv_sources
              WHERE xtream_username LIKE 'enc:v1:%'
                 OR xtream_password LIKE 'enc:v1:%')::text                   AS livetv_unbound,
            ((SELECT COUNT(*) FROM task_webhook_hooks
               WHERE substring(secret_encrypted FROM 1 FOR 7) <> convert_to('enc:v2:', 'UTF8'))
           + (SELECT COUNT(*) FROM user_notification_webhooks
               WHERE substring(secret_encrypted FROM 1 FOR 7) <> convert_to('enc:v2:', 'UTF8'))
            )::text                                                          AS webhook_unbound,
            ((SELECT COUNT(*) FROM plugin_secrets
               WHERE substring(value_encrypted FROM 1 FOR 7) <> convert_to('enc:v2:', 'UTF8'))
           + (SELECT COUNT(*) FROM plugin_user_credentials
               WHERE substring(value_encrypted FROM 1 FOR 7) <> convert_to('enc:v2:', 'UTF8'))
            )::text                                                          AS plugin_unbound
    `;

    const row = rows[0];
    return evaluateLegacySecretEnvelopes({
        subsonicPlaintext: toCount(row?.subsonic_plaintext),
        subsonicUnbound: toCount(row?.subsonic_unbound),
        jellyfinUnbound: toCount(row?.jellyfin_unbound),
        livetvUnbound: toCount(row?.livetv_unbound),
        webhookUnbound: toCount(row?.webhook_unbound),
        pluginUnbound: toCount(row?.plugin_unbound),
        // settings.json is a file, not a table — the config service is the only
        // thing that has read it.
        configUnbound: getLegacyConfigEnvelopeKeys().length,
    });
}

/**
 * For each sealed store, select the `enc:v2:` (row-bound) values and try to
 * open every one under the current master key with its OWN row's AAD
 * context — the SAME context builder each store's real read path uses, so
 * this check can never drift from what "opens correctly" actually means for
 * that store. Counts how many fail.
 *
 * Deliberately NOT limited to a sample: these tables hold operator/user
 * credentials, not media rows, so even a large self-hosted install has at
 * most a few thousand of them combined — cheap to check exhaustively, and a
 * sampled check would miss the exact row an operator needs to know about.
 */
async function checkUnopenableSecrets(sql: postgres.Sql): Promise<SecuritySelfCheckFinding> {
    const masterKey = deriveMasterKey(resolveMasterKey());

    const subsonicUnopenable = await countUnopenableStringEnvelopes(
        sql<{ user_id: string; token_sealed: string }[]>`
            SELECT user_id, token_sealed FROM subsonic_client_passwords
            WHERE token_sealed LIKE 'enc:v2:%'
        `,
        masterKey,
        (row) => tokenContext(row.user_id),
        (row) => row.token_sealed,
    );

    const jellyfinUnopenable = await countUnopenableStringEnvelopes(
        sql<{ user_id: string; password_sealed: string }[]>`
            SELECT user_id, password_sealed FROM jellyfin_client_passwords
            WHERE password_sealed LIKE 'enc:v2:%'
        `,
        masterKey,
        (row) => jellyfinClientPasswordContext(row.user_id),
        (row) => row.password_sealed,
    );

    const livetvRows = await sql<
        { id: string; xtream_username: string | null; xtream_password: string | null }[]
    >`
        SELECT id, xtream_username, xtream_password FROM livetv_sources
        WHERE xtream_username LIKE 'enc:v2:%' OR xtream_password LIKE 'enc:v2:%'
    `;
    let livetvUnopenable = 0;
    for (const row of livetvRows) {
        for (const column of ['xtream_username', 'xtream_password'] as const) {
            const value = row[column];
            if (!value || !value.startsWith('enc:v2:')) continue;
            if (!tryOpenSecret(value, masterKey, credentialContext(row.id, column))) {
                livetvUnopenable++;
            }
        }
    }

    const webhookUnopenable =
        (await countUnopenableBlobEnvelopes(
            sql<{ id: string; secret_encrypted: Buffer }[]>`
                SELECT id, secret_encrypted FROM task_webhook_hooks
                WHERE substring(secret_encrypted FROM 1 FOR 7) = convert_to('enc:v2:', 'UTF8')
            `,
            masterKey,
            (row) => operatorWebhookSecretContext(row.id),
            (row) => row.secret_encrypted,
        )) +
        (await countUnopenableBlobEnvelopes(
            sql<{ user_id: string; secret_encrypted: Buffer }[]>`
                SELECT user_id, secret_encrypted FROM user_notification_webhooks
                WHERE substring(secret_encrypted FROM 1 FOR 7) = convert_to('enc:v2:', 'UTF8')
            `,
            masterKey,
            (row) => userWebhookSecretContext(row.user_id),
            (row) => row.secret_encrypted,
        ));

    const pluginUnopenable =
        (await countUnopenableBlobEnvelopes(
            sql<{ plugin_id: string; key: string; value_encrypted: Buffer }[]>`
                SELECT plugin_id, key, value_encrypted FROM plugin_secrets
                WHERE substring(value_encrypted FROM 1 FOR 7) = convert_to('enc:v2:', 'UTF8')
            `,
            masterKey,
            (row) => pluginSecretContext(row.plugin_id, row.key),
            (row) => row.value_encrypted,
        )) +
        (await countUnopenableBlobEnvelopes(
            sql<{ plugin_id: string; user_id: string; key: string; value_encrypted: Buffer }[]>`
                SELECT plugin_id, user_id, key, value_encrypted FROM plugin_user_credentials
                WHERE substring(value_encrypted FROM 1 FOR 7) = convert_to('enc:v2:', 'UTF8')
            `,
            masterKey,
            (row) => pluginUserCredentialContext(row.plugin_id, row.user_id, row.key),
            (row) => row.value_encrypted,
        ));

    return evaluateUnopenableSecrets({
        subsonicUnopenable,
        jellyfinUnopenable,
        livetvUnopenable,
        webhookUnopenable,
        pluginUnopenable,
        configUnopenable: getUndecryptableConfigKeys().length,
    });
}

/** Try to open a string envelope; returns whether it succeeded (never throws). */
function tryOpenSecret(envelope: string, masterKey: Buffer, aad: string): boolean {
    try {
        openSecret(envelope, masterKey, aad);
        return true;
    } catch {
        return false;
    }
}

/** Try to decrypt a BYTEA envelope; returns whether it succeeded (never throws). */
function tryDecryptBlob(blob: Buffer, masterKey: Buffer, aad: string): boolean {
    try {
        decrypt(blob, masterKey, aad);
        return true;
    } catch {
        return false;
    }
}

/** Count rows whose string envelope fails to open under `aadOf(row)`. */
async function countUnopenableStringEnvelopes<T>(
    rowsPromise: Promise<T[]>,
    masterKey: Buffer,
    aadOf: (row: T) => string,
    envelopeOf: (row: T) => string,
): Promise<number> {
    const rows = await rowsPromise;
    let count = 0;
    for (const row of rows) {
        if (!tryOpenSecret(envelopeOf(row), masterKey, aadOf(row))) count++;
    }
    return count;
}

/** Count rows whose BYTEA envelope fails to decrypt under `aadOf(row)`. */
async function countUnopenableBlobEnvelopes<T>(
    rowsPromise: Promise<T[]>,
    masterKey: Buffer,
    aadOf: (row: T) => string,
    blobOf: (row: T) => Buffer,
): Promise<number> {
    const rows = await rowsPromise;
    let count = 0;
    for (const row of rows) {
        if (!tryDecryptBlob(blobOf(row), masterKey, aadOf(row))) count++;
    }
    return count;
}
