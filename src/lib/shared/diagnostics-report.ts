// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Config redaction and Markdown-cell helpers shared by the instance debug report
 * (`$lib/server/debug-report/*`) and its formatter (`$lib/shared/debug-report-format.ts`).
 *
 * The old diagnostics bundle and its formatter were removed on 2026-10-21; the
 * debug report replaces them (spec 2026-10-21-admin-debug-report-design).
 *
 * {@link redactConfigValues} is SCHEMA-DRIVEN, for structured config. It is driven by
 * `uiHints.sensitive` in `$lib/config/schema.ts`. The free-text regexes in
 * `transcode-failure-report.ts` cannot do this job: `stripSecrets`' `\b(api_key|token|…)=`
 * form never matches a bare `JELLYFIN_API_KEY` key name, and its header form never
 * matches the `"password": "x"` JSON shape. The schema flag is the authority for config.
 */

/** Placeholder for a sensitive config key that HAS a value. */
export const REDACTED = '<redacted>';
/** Placeholder for a sensitive config key that is empty/unset. */
export const UNSET = '<unset>';

/**
 * Config keys whose value is the OPERATOR'S IDENTITY or registered-app identity
 * rather than a credential.
 *
 * `uiHints.sensitive` deliberately does not flag these — it also drives
 * encryption-at-rest and the settings UI's masked input, and an operator must
 * be able to read back their own username or OAuth client id. But the report is
 * pasted into public issues, so they are masked here.
 *
 * URL-bearing config is handled by {@link PUBLIC_REDACTION_KEY_RE}.
 */
const IDENTITY_KEYS = new Set([
    'DEFAULT_USER',
    'AUTH_OIDC_CLIENT_ID',
    // OAuth client identifiers are not bearer credentials, but publishing them
    // identifies (and can enable abuse of) the operator's registered app.
    'TRAKT_CLIENT_ID',
    'MAL_CLIENT_ID',
    // Branding and assistant copy can identify the operator or organisation.
    'APP_NAME',
    'APP_DESCRIPTION',
    'APP_LOGO_SMALL',
    'APP_LOGO_FULL',
    'APP_LOGO_PLAY',
    'APP_BACKGROUND_IMAGE',
    'RATING_LOGO_IMDB',
    'RATING_LOGO_ROTTEN_TOMATOES',
    'ASSISTANT_NAME',
    'ASSISTANT_PERSONA',
]);

/**
 * Configuration that is useful to an operator but unnecessarily identifies an
 * instance or reveals its authorization and network layout in a public report.
 *
 * This deliberately applies to keys, not values: group/header names have no
 * reliable syntax which distinguishes an innocuous default from an internal
 * convention. Keeping the key in the report still tells maintainers whether
 * the relevant feature is configured.
 */
const PUBLIC_REDACTION_KEY_RE =
    /(?:GROUP|HEADER|URL$|URI$|ISSUER$|PATH$|DIR$|ROOT$|DEVICE$|ORIGIN|_IPS?$)/;

/** Custom navigation embeds labels, opaque IDs, URLs, and group ACLs together. */
const NAVIGATION_KEYS = new Set([
    'SIDEBAR_LINKS',
    'SIDEBAR_SECTIONS',
    'FOOTER_LINKS',
    'USER_MENU_LINKS',
    'HERO_BUTTONS',
]);

function isPublicSensitiveConfigKey(key: string): boolean {
    return (
        IDENTITY_KEYS.has(key) ||
        NAVIGATION_KEYS.has(key) ||
        PUBLIC_REDACTION_KEY_RE.test(key) ||
        key.endsWith('_CLIENT_ID')
    );
}

/**
 * Mask every config value whose key is flagged sensitive in the config schema,
 * plus public-report-only keys whose values reveal identity, authorization
 * structure, or instance topology.
 *
 * Empty/null/undefined/empty-array values become {@link UNSET} rather than
 * {@link REDACTED}: "is your API key even configured?" is one of the questions
 * the report exists to answer, and masking an unset key as `<redacted>` would
 * answer it wrongly. Neither placeholder can leak the value.
 *
 * `isSensitive` is injected (rather than importing the config service) so this
 * module stays client-safe and the tests can drive it with the REAL schema
 * predicate without pulling the server graph in.
 */
export function redactConfigValues(
    values: Record<string, unknown>,
    isSensitive: (key: string) => boolean,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
        if (!isSensitive(key) && !isPublicSensitiveConfigKey(key)) {
            out[key] = value;
            continue;
        }
        const empty =
            value === null ||
            value === undefined ||
            value === '' ||
            (Array.isArray(value) && value.length === 0);
        out[key] = empty ? UNSET : REDACTED;
    }
    return out;
}

/**
 * Whether the path-redaction pass can actually do anything.
 *
 * `redactPaths` iterates `libraryRoots`, so an EMPTY array silently turns the
 * whole path pass into a no-op. Still used by the transcode-failure page, which
 * gates its GitHub-mode copy button on it.
 */
export function isRedactionAvailable(roots: { readonly libraryRoots: readonly string[] }): boolean {
    return roots.libraryRoots.length > 0;
}

/** Flatten to a single line and neutralize the column separator so one noisy
 *  value cannot shred the table it lives in. */
export function cell(text: string): string {
    return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\|/g, '\\|');
}

/**
 * Fence a block, growing the delimiter past the longest backtick run inside it.
 *
 * A literal ``` in any rendered value (a config string, a failure summary)
 * would otherwise close the fence early and let the remainder of the block
 * render as Markdown/HTML in the issue thread. Growing the delimiter is
 * preferable to mangling the content, which is the thing being reported.
 */
export function fence(lang: string, body: string): string {
    const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
    const delimiter = '`'.repeat(Math.max(3, longestRun + 1));
    return `${delimiter}${lang}\n${body}\n${delimiter}`;
}
