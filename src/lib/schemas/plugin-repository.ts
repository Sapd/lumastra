// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The plugin repository index format.
 *
 * A repository IS a URL serving one JSON document. No registration, no central
 * authority — anyone who can host a static file can run one, and the official
 * directory is just the URL that happens to be first-party. That decentralised
 * shape is the right one; what has to be got right is the integrity layer
 * around it.
 *
 * ── WHAT A REPOSITORY IS AND IS NOT TRUSTED FOR ──────────────────────────────
 *
 * A repository grants ZERO trust. Every entry carries the `(manifestUrl,
 * signature)` pair an operator would otherwise paste by hand, so installing
 * from a catalog calls exactly the same verified install path with exactly the
 * same inputs. The catalog is an AUTOFILL for that form. That is the single
 * most important property here: a trust bypass is not policy-enforced, it is
 * structurally impossible, and every hardening already shipped — SSRF guards,
 * size caps, signature verification, the ABI gate, anti-rollback, publisher
 * continuity — applies to a catalog install for free.
 *
 * Consequently everything an index says about a plugin is ADVISORY. `sdkAbi`,
 * `keyId` and the descriptive fields exist so the browse view can filter and
 * label without fetching every manifest; all of them are re-derived from the
 * signed manifest before anything is installed. A repository that lies produces
 * a clean install failure, never a bad install.
 *
 * ── WHY THE INDEX ITSELF IS NOT SIGNED (YET) ─────────────────────────────────
 *
 * Because per-manifest signatures already carry all the code-execution trust.
 * A malicious index can show false descriptions and suppress updates; it cannot
 * cause installation of anything not signed by a key the operator already
 * trusts.
 *
 * Signing the index would add authenticity for cosmetic metadata and some
 * protection against update SUPPRESSION — but suppression is a freshness
 * problem, and a bare signature does not solve freshness: a replayed signed
 * index is still valid. Solving it properly needs signed timestamps with expiry
 * (TUF's timestamp role), which is a deliberate, separately-reviewed increment.
 * Shipping half of that guarantee would be worse than shipping none, so the
 * slot is reserved (`index.json.sig`, same detached-Ed25519 convention as
 * manifests) and the cheap mitigation — showing the index's age — ships now.
 */

import { z } from 'zod';

/** Bumped only on a breaking change to this document's shape. */
export const PLUGIN_REPOSITORY_SCHEMA_VERSION = 1;

const PLUGIN_NAME = z.string().regex(/^[a-z][a-z0-9-]*$/);
const SEMVER = z.string().regex(/^\d+\.\d+\.\d+$/);

const HTTPS_OR_HTTP_URL = z
    .string()
    .url()
    .refine(
        (u) => {
            // Must not throw: zod runs refinements even after `.url()` fails,
            // and a throw here escapes `safeParse` entirely.
            try {
                return /^https?:$/.test(new URL(u).protocol);
            } catch {
                return false;
            }
        },
        { message: 'only http/https URLs are allowed' },
    );

/**
 * One installable version.
 *
 * `manifestUrl` is IMMUTABLE per version by convention, and the host treats it
 * so. The index is the mutable pointer; manifests are the immutable signed
 * leaves. A mutable "latest" manifest URL would break anti-rollback semantics,
 * provenance display and caching all at once.
 */
export const RepositoryVersionSchema = z.object({
    version: SEMVER,
    manifestUrl: HTTPS_OR_HTTP_URL,
    /** The detached Ed25519 signature for THAT manifest. */
    signature: z.string(),
    /** Advisory copies, for client-side filtering. Re-verified at install. */
    sdkAbi: z.number().int().positive().optional(),
    minAppVersion: SEMVER.optional(),
    keyId: z.string().optional(),
    /** Lets the admin UI surface a security release differently. */
    security: z.boolean().optional(),
});

export const RepositoryPluginSchema = z.object({
    /** MUST equal the signed manifest's `name`. Verified at install. */
    name: PLUGIN_NAME,
    // ── cosmetic, catalog-only ──
    title: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    publisher: z.string().max(120).optional(),
    iconUrl: HTTPS_OR_HTTP_URL.optional(),
    homepage: HTTPS_OR_HTTP_URL.optional(),
    changelogUrl: HTTPS_OR_HTTP_URL.optional(),
    tags: z.array(z.string().max(40)).max(10).optional(),
    /** Newest first. Capped by the consumer, not trusted from the producer. */
    versions: z.array(RepositoryVersionSchema).min(1),
});

export const PluginRepositoryIndexSchema = z.object({
    schemaVersion: z.number().int().positive(),
    name: z.string().max(120),
    description: z.string().max(1000).optional(),
    /** Shown as an age so an operator can notice a repository going stale. */
    updatedAt: z.string().datetime().optional(),
    plugins: z.array(RepositoryPluginSchema),
});

export type PluginRepositoryIndex = z.infer<typeof PluginRepositoryIndexSchema>;
export type RepositoryPlugin = z.infer<typeof RepositoryPluginSchema>;
export type RepositoryVersion = z.infer<typeof RepositoryVersionSchema>;

/**
 * Pick the newest version this host can actually install.
 *
 * Advisory values only — the real gate runs against the signed manifest. The
 * point is that an operator on an older Lumastra sees a version that WILL
 * install rather than the newest one, which would fail its ABI check. Entries
 * with no declared `sdkAbi` predate the field and are treated as ABI 1.
 */
export function pickInstallableVersion(
    plugin: RepositoryPlugin,
    hostAbi: number,
): RepositoryVersion | null {
    const compatible = plugin.versions.filter((v) => (v.sdkAbi ?? 1) === hostAbi);
    if (compatible.length === 0) return null;
    return compatible.reduce((best, v) =>
        compareVersions(v.version, best.version) > 0 ? v : best,
    );
}

/** Strict major.minor.patch compare. Returns >0, 0, <0. */
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}
