// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { parseTrustedKeys, type TrustedKey } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const trustAnchorLogger = Logger.for('PluginTrustAnchors');

/**
 * BAKED OFFICIAL PUBLIC-KEY ANCHOR.
 *
 * A COMPILE-TIME CONSTANT — the official Ed25519 public key(s), each as one
 * `keyId:base64Spki` entry, exactly the PLUGIN_TRUSTED_KEYS wire format.
 *
 * NOT fetched at runtime. NOT read from ConfigService / settings.json. NOT
 * editable via any web surface. It travels with the verified application code,
 * so swapping it requires a code change + release (the same trust bar as
 * shipping any other line of server code).
 *
 * POPULATED as of the 2026 release: `lumastra-official-2026`. An empty set would
 * mean "no official trust" (behavior identical to the operator-as-root model);
 * a populated one means anything this key verifies runs with FULL HOST TRUST on
 * every install, so treat the private half as a production deploy credential.
 *
 * TO ADD OR ROTATE A KEY:
 *   1. node scripts/plugin-keygen.mjs --key-id lumastra-official-2026 \
 *          --out ~/.secrets/lumastra-official-2026.pem
 *      (it refuses to write inside this repo — a signing key in the working
 *      tree is one `git add -A` from being published)
 *   2. paste the printed `keyId:base64Spki` entry below
 *   3. mirror the same public value into lumastra-web's
 *      /.well-known/lumastra-signing-keys.json, so a third party can verify
 *      out of band what their build trusts
 *   4. keep the .pem offline — an HSM or hardware token, never CI
 *
 * ROTATION: add the new entry ALONGSIDE the old and keep both until every
 * published manifest is re-signed. Removing a key blocks future installs but
 * uninstalls nothing, so an early removal silently strands upgrades rather
 * than failing loudly.
 *
 * INVARIANT: entries here are PUBLIC keys only. A private key must NEVER appear
 * in this file, the repo, the server, or the website.
 */
export const OFFICIAL_TRUSTED_KEY_ENTRIES: readonly string[] = [
    // Public half only. Private key held offline, outside this repository.
    // Mirrored at https://lumastra.org/.well-known/lumastra-signing-keys.json so
    // a third party can verify out of band what their build trusts.
    'lumastra-official-2026:MCowBQYDK2VwAyEAAG6LEO8+OkxluHfOg9252TH/najiI9Ho1U5mJP8A0rY=',
];

/** Parse the baked anchor into TrustedKeys tagged `source: 'official'`. */
export function getOfficialTrustedKeys(
    entries: readonly string[] = OFFICIAL_TRUSTED_KEY_ENTRIES,
): TrustedKey[] {
    return parseTrustedKeys(entries.join('\n'), 'official');
}

/**
 * Hybrid resolution: effective trusted set = official anchor ∪ operator env.
 *
 * PRECEDENCE — OFFICIAL WINS official-vs-operator keyId collisions ONLY.
 * Official keys are parsed first and inserted first (deterministic verify order
 * → a matched keyId on collision reports `official`). An operator entry whose
 * keyId is already claimed by an *official* key is DROPPED with a WARN so an
 * operator env key can never shadow/impersonate an official keyId in audit
 * output.
 *
 * INTRA-OPERATOR DUPLICATES ARE PRESERVED. The collision set is OFFICIAL keyIds
 * ONLY — operator keyIds are never added to it — so two operator entries sharing
 * a keyId with different material (the `rot:OLD,rot:NEW` mid-rotation layout)
 * are BOTH kept, exactly as parseTrustedKeys + verify-every-key rely on today.
 * With the anchor empty (the shipped default) this is byte-for-byte identical to
 * `parseTrustedKeys(process.env.PLUGIN_TRUSTED_KEYS)`.
 *
 * Injection seam: both raw inputs are parameters (defaults = baked anchor +
 * process.env) so tests exercise the union with EPHEMERAL keys and never touch a
 * committed key. `operatorRaw` defaults to `process.env.PLUGIN_TRUSTED_KEYS` —
 * ENV-only, NEVER ConfigService (trust invariant #1).
 */
export function buildEffectiveTrustedKeys(
    officialEntries: readonly string[] = OFFICIAL_TRUSTED_KEY_ENTRIES,
    operatorRaw: string | undefined = process.env.PLUGIN_TRUSTED_KEYS,
): TrustedKey[] {
    const official = parseTrustedKeys(officialEntries.join('\n'), 'official');
    const operator = parseTrustedKeys(operatorRaw, 'operator');
    const officialIds = new Set(official.map((k) => k.keyId));
    const merged: TrustedKey[] = [...official];
    for (const k of operator) {
        if (officialIds.has(k.keyId)) {
            trustAnchorLogger.warn(
                'operator PLUGIN_TRUSTED_KEYS entry reuses an official keyId — dropping (official wins)',
                { keyId: k.keyId },
            );
            continue;
        }
        merged.push(k);
    }
    return merged;
}

/**
 * Resolve a persisted keyId to its LIVE source. Takes the already-built effective
 * set as a parameter so a list handler builds the set ONCE per request and
 * classifies every row against it (avoiding a rebuild + re-emitted WARN per row).
 * A NULL keyId (legacy/pre-migration row), a removed key (post-rotation), and a
 * registry-less drop-in all resolve to 'unknown'.
 */
export function classifyKeyId(
    keyId: string | null,
    effective: TrustedKey[] = buildEffectiveTrustedKeys(),
): 'official' | 'operator' | 'unknown' {
    if (!keyId) return 'unknown';
    return effective.find((k) => k.keyId === keyId)?.source ?? 'unknown';
}
