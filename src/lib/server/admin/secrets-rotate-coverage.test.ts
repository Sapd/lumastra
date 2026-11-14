// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rotation coverage gate (security review 2026-09-12, C9).
 *
 * "Rotate Master Key" used to re-seal the two plugin tables and nothing else,
 * while the admin UI promised "all secrets". Five other stores had been added
 * over time — settings.json, Subsonic tokens, both webhook secret columns,
 * Jellyfin client passwords, Xtream credentials — and each was written by
 * someone who had no reason to look at a rotation endpoint in a different
 * directory. Nothing failed when they were missed; the damage only appeared
 * later, when an operator swapped LUMASTRA_MASTER_KEY and their secrets
 * quietly stopped opening.
 *
 * So this file inverts the question. It finds every module that SEALS
 * something with the master key (imports `sealSecret` or `encrypt` from
 * secret-box, directly or via the tasks/secrets re-export) and requires each
 * one to be listed below with the rotation that covers it. Add a new sealed
 * store and this test fails until the store is rotated too.
 *
 * ADDING A NEW SEALED STORE? Write its rotation next to its sealing code, wire
 * it into `handleSecretsRotate`, then add the row here.
 *
 * Since security review 2026-09-13 (C19) this file gates a second property of
 * the same list: every sealing call must pass a ROW CONTEXT (the third
 * argument, the AES-GCM AAD). Without it the value is sealed `enc:v1:` —
 * openable in any row it is copied into — and nothing else would notice.
 *
 * Run: npx vitest run src/lib/server/admin/secrets-rotate-coverage.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../../..');
const SRC = resolve(ROOT, 'src');

/**
 * Every module that seals a value with the master key, mapped to the rotation
 * function that moves that value to a new key. The VALUE is the exported
 * rotation symbol `handleSecretsRotate` ultimately calls.
 */
const SEALING_SITES: Record<string, string> = {
    // plugin_secrets + plugin_user_credentials — the original rotation scope.
    // secrets.ts also HOSTS rotateJellyfinClientPasswords (see the jellyfin row).
    'src/lib/server/tasks/secrets.ts': 'PluginSecrets.rotate',

    // settings.json sensitive values (uiHints.sensitive), sealed on save.
    'src/lib/server/config/config.service.ts': 'rotateConfigSecrets',

    // subsonic_client_passwords.token_sealed + the token_lookup blind index,
    // which is HMAC'd under the SAME key and must move with it.
    'src/lib/server/subsonic-compat/auth.ts': 'rotateSubsonicTokens',

    // task_webhook_hooks.secret_encrypted — sealed at create…
    'src/lib/server/api/defs/webhooks/index.ts': 'rotateWebhookSecrets',
    // …and at update.
    'src/lib/server/api/defs/webhooks/[id].ts': 'rotateWebhookSecrets',
    // user_notification_webhooks.secret_encrypted — the per-user twin.
    'src/lib/server/api/defs/user/notification-webhook.ts': 'rotateWebhookSecrets',
    // The delivery worker hosts the rotation for both of those columns,
    // alongside the decrypt it already did.
    'src/lib/server/tasks/webhook-outbox.ts': 'rotateWebhookSecrets',

    // jellyfin_client_passwords.password_sealed. The sweep itself lives in the
    // AGPL tree (the handler does not import this tree); this module
    // delegates to it.
    'src/lib/server/jellyfin-compat/auth.ts': 'rotateJellyfinClientPasswords',

    // livetv_sources.xtream_username / .xtream_password (security review C8).
    'src/lib/server/database/queries/livetv-sources.queries.ts': 'rotateLiveTvCredentials',
};

/**
 * Master-key-derived values that are NEVER stored, so there is no ciphertext a
 * rotation could move. They simply become different when the key changes —
 * which is a real operator consequence, documented in
 * docs/security/master-key-rotation.md, not a coverage gap.
 */
const DERIVED_NOT_STORED: Record<string, string> = {
    // JWT_SECRET, when the operator has not set one: HMAC(masterKey,
    // 'lumastra-jwt-secret-v1'). Rotating the key invalidates every issued
    // access/refresh token — all sessions must log in again. Setting an
    // explicit JWT_SECRET decouples it.
    'src/lib/server/config.ts': 'deriveSubSecret — JWT_SECRET fallback',
    // The master-key fingerprint shown in the admin UI / cluster heartbeat.
    // Non-secret by construction and recomputed on read.
    'src/lib/server/crypto/master-key.ts': 'deriveSubSecret — key fingerprint',
    // The Jellyfin server id: sha256('jellyfin-server-id:' + masterKey). Not a
    // secret and not stored; rotating the key changes the id, so already-paired
    // /j clients re-pair once.
    'src/lib/server/jellyfin-compat/constants.ts': 'JELLYFIN_SERVER_ID seed',
    // The HMAC key for the short tags that replace ids in a GitHub report draft. Not
    // stored; after rotation the same id gets a different tag, so tags in reports
    // drafted before and after the rotation no longer match.
    'src/lib/server/api/defs/admin/diagnostics/[id]/github-report.ts':
        'deriveSubSecret — report id tags',
};

/** Files that legitimately reference a rotation symbol without sealing. */
const IMPORT_RE = /(?:^|\s)import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gs;

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
            walk(abs, out);
        } else if (/\.(ts|svelte)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
            out.push(abs);
        }
    }
    return out;
}

/** Modules importing `sealSecret` or `encrypt` from the secret-box primitives. */
function findSealingSites(): string[] {
    const found: string[] = [];
    for (const abs of walk(SRC)) {
        const rel = relative(ROOT, abs).split('\\').join('/');
        // secret-box.ts DEFINES the primitives; it stores nothing itself.
        if (rel === 'src/lib/server/crypto/secret-box.ts') continue;
        const source = readFileSync(abs, 'utf-8');
        for (const match of source.matchAll(IMPORT_RE)) {
            const specifier = match[2];
            const fromSecretBox =
                specifier.includes('crypto/secret-box') ||
                specifier.includes('tasks/secrets') ||
                /(^|\/)\.?\.?\/?secrets\.js$/.test(specifier);
            if (!fromSecretBox) continue;
            const names = match[1]
                .split(',')
                .map((n) =>
                    n
                        .replace(/^\s*type\s+/, '')
                        .trim()
                        .split(/\s+as\s+/)[0]
                        .trim(),
                )
                .filter(Boolean);
            if (names.includes('sealSecret') || names.includes('encrypt')) {
                found.push(rel);
                break;
            }
        }
    }
    return [...new Set(found)].sort();
}

describe('every master-key sealing site is covered by the rotation endpoint', () => {
    it('the repo contains exactly the sealing sites listed in SEALING_SITES', () => {
        expect(
            findSealingSites(),
            'A module now seals a value with the master key but is not listed in ' +
                'SEALING_SITES. Write a rotation next to its sealing code, call it from ' +
                'handleSecretsRotate, and add the row — otherwise the store silently stays ' +
                'under the retired key when an operator rotates (security review ' +
                '2026-09-12, C9).',
        ).toEqual(Object.keys(SEALING_SITES).sort());
    });

    it('handleSecretsRotate invokes the rotation named for every sealing site', () => {
        const handler = readFileSync(
            resolve(ROOT, 'src/lib/server/admin/secrets-rotate.handler.ts'),
            'utf-8',
        );
        for (const [site, rotation] of Object.entries(SEALING_SITES)) {
            // `PluginSecrets.rotate` is called as `pluginSecrets.rotate(`.
            const needle = rotation === 'PluginSecrets.rotate' ? 'pluginSecrets.rotate(' : rotation;
            expect(handler, `${site} → ${rotation} is not called by the handler`).toContain(needle);
        }
    });

    it('the derived-not-stored values are exactly the documented three', () => {
        const found: string[] = [];
        for (const abs of walk(SRC)) {
            const rel = relative(ROOT, abs).split('\\').join('/');
            if (rel === 'src/lib/server/crypto/secret-box.ts') continue;
            // The handler's own doc comment names these exclusions; it is the
            // consumer of the list, not a member of it.
            if (rel === 'src/lib/server/admin/secrets-rotate.handler.ts') continue;
            const source = readFileSync(abs, 'utf-8');
            if (/deriveSubSecret\s*\(/.test(source) || /jellyfin-server-id:/.test(source)) {
                found.push(rel);
            }
        }
        expect(
            [...new Set(found)].sort(),
            'A new value is being DERIVED from the master key. It cannot be rotated (there ' +
                'is no ciphertext), so it CHANGES when the key changes — document that ' +
                'consequence in docs/security/master-key-rotation.md and list it here.',
        ).toEqual(Object.keys(DERIVED_NOT_STORED).sort());
    });
});

// ---------------------------------------------------------------------------
// Row binding (security review 2026-09-13, C19)
// ---------------------------------------------------------------------------

/**
 * Find every `sealSecret(...)` / `encrypt(...)` CALL in a source file and
 * return each one's top-level argument count.
 *
 * Hand-scanned rather than regex-matched on the whole call: an argument is
 * routinely itself a call with its own commas (`sealSecret(v, key,
 * ctx(id, col))`), which a regex would miscount. Strings, template literals and
 * comments are skipped so a comma inside one cannot be read as a separator.
 * `decrypt(` does not match — the `d` makes `\bencrypt` fail, which is what we
 * want: reads are allowed to pass a context for a value that may not have one.
 */
function sealingCallArity(source: string): Array<{ call: string; args: number }> {
    const results: Array<{ call: string; args: number }> = [];
    const callRe = /\b(sealSecret|encrypt)\s*\(/g;
    for (const match of source.matchAll(callRe)) {
        const open = match.index + match[0].length;
        let depth = 1;
        let args = 1;
        let i = open;
        let quote: string | null = null;
        for (; i < source.length && depth > 0; i++) {
            const c = source[i];
            const prev = source[i - 1];
            if (quote) {
                if (c === quote && prev !== '\\') quote = null;
                continue;
            }
            if (c === "'" || c === '"' || c === '`') {
                quote = c;
                continue;
            }
            if (c === '/' && source[i + 1] === '/') {
                i = source.indexOf('\n', i);
                if (i === -1) break;
                continue;
            }
            if (c === '/' && source[i + 1] === '*') {
                const end = source.indexOf('*/', i);
                if (end === -1) break;
                i = end + 1;
                continue;
            }
            if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') depth--;
            else if (c === ',' && depth === 1) args++;
        }
        // An empty call — `encrypt()` — has no arguments at all.
        if (source.slice(open, i - 1).trim() === '') args = 0;
        results.push({ call: match[1], args });
    }
    return results;
}

/**
 * Every `…Context()` helper in a sealing site whose body is a single returned
 * template literal, as `{ name, template }`.
 *
 * A helper that returns something else (`webhookSecretContext` picks between
 * the two owner tables) is skipped on purpose — it delegates to the ones this
 * does match.
 */
function contextHelpers(source: string): Array<{ name: string; template: string }> {
    const re = /function\s+(\w*Context)\s*\([^)]*\)\s*:\s*string\s*\{\s*return\s+`([^`]+)`/g;
    return [...source.matchAll(re)].map((m) => ({ name: m[1], template: m[2] }));
}

describe('every row context is prefixed with its own store', () => {
    it('each context helper returns `<store>:…`', () => {
        const helpers: Array<{ site: string; name: string; template: string }> = [];
        for (const site of Object.keys(SEALING_SITES)) {
            const source = readFileSync(resolve(ROOT, site), 'utf-8');
            for (const h of contextHelpers(source)) helpers.push({ site, ...h });
        }

        // A helper that stopped matching the shape would silently empty this
        // gate, so pin the number as well as the property.
        expect(
            helpers.map((h) => h.name).sort(),
            'A row-context helper is gone or no longer a single returned template literal. ' +
                'Keep the shape, or this gate stops checking anything.',
        ).toEqual([
            'cacheContext',
            'configSecretContext',
            'credentialContext',
            'jellyfinClientPasswordContext',
            'operatorWebhookSecretContext',
            'pluginSecretContext',
            'pluginUserCredentialContext',
            'tokenContext',
            'userWebhookSecretContext',
        ]);

        // `<store>:` — a literal store name, before any interpolation. Two
        // stores whose row identities are both free-form text otherwise produce
        // the same context for different rows (security review 2026-09-13,
        // C19): a plugin secret keyed `<uuid>/access_token` collided with that
        // user's credential for the same plugin.
        const unprefixed = helpers.filter((h) => !/^[a-z_][a-z0-9_.]*:/.test(h.template));
        expect(
            unprefixed.map((h) => `${h.site}: ${h.name} → \`${h.template}\``),
            'A row context does not start with a literal `<store>:` prefix. The prefix is ' +
                'part of the on-disk contract — and changing a context after values have ' +
                'been sealed under it orphans every one of them.',
        ).toEqual([]);
    });
});

describe('every sealing call binds the value to its row', () => {
    it('passes a row context (AAD) to sealSecret / encrypt at every sealing site', () => {
        const offenders: string[] = [];
        for (const site of Object.keys(SEALING_SITES)) {
            const source = readFileSync(resolve(ROOT, site), 'utf-8');
            for (const { call, args } of sealingCallArity(source)) {
                if (args < 3) offenders.push(`${site}: ${call}() with ${args} argument(s)`);
            }
        }
        expect(
            offenders,
            'A value is being sealed WITHOUT a row context, so it is written as an ' +
                'unbound enc:v1: envelope: copy it into another row and that row decrypts ' +
                'it (security review 2026-09-13, C19). Pass a stable identifier for the ' +
                'row as the third argument — see the context helpers next to each store.',
        ).toEqual([]);
    });

    it('the scanner it relies on actually counts arguments', () => {
        // A gate that cannot fail is not a gate. These are the shapes that
        // appear in the sealing sites, including the nested-call one a regex
        // would miscount.
        expect(sealingCallArity('sealSecret(v, key)')).toEqual([{ call: 'sealSecret', args: 2 }]);
        expect(sealingCallArity('encrypt(v, key, ctx(a, b))')).toEqual([
            { call: 'encrypt', args: 3 },
        ]);
        expect(sealingCallArity('encrypt(v, key, `a,b`)')).toEqual([{ call: 'encrypt', args: 3 }]);
        // decrypt() is a read, not a seal — it must not be picked up.
        expect(sealingCallArity('decrypt(blob, key)')).toEqual([]);
    });
});
