// manifest.ts
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { ID_PATTERN } from '$lib/server/tasks/plugin-id.js';

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

const HTTPS_OR_HTTP_URL = z
    .string()
    .url()
    .refine(
        (u) => {
            // MUST NOT throw. Zod runs refinements even when an earlier check
            // (.url()) already failed, so a bare `new URL(u)` here turns a
            // malformed value into a TypeError thrown straight OUT of
            // `safeParse` — which the installer does not catch, so an operator
            // with a typo in `bundleUrl` got a 500 and a stack trace instead of
            // "invalid manifest". [Fable-5 kept: .url() alone accepts file:/ftp:]
            try {
                return /^https?:$/.test(new URL(u).protocol);
            } catch {
                return false;
            }
        },
        { message: 'only http/https URLs are allowed' },
    );

/**
 * Single path gate applied at THREE points (manifest entry, every tar entry,
 * every on-disk walked path). Rejecting all control bytes here is what makes the
 * newline-delimited tree listing unambiguous (no '\n'/'\r' can reach it), so
 * listing-line injection is structurally impossible. 256 = max ustar path
 * (155 prefix + '/' + 100 name).
 */
export function isSafeRelativePath(p: string): boolean {
    if (p.length === 0 || p.length > 256) return false;
    // eslint-disable-next-line no-control-regex -- intentional control-char reject
    if (/[\x00-\x1f\x7f]/.test(p)) return false;
    if (p.includes('\\')) return false;
    if (p.startsWith('/')) return false;
    if (/^[a-zA-Z]:/.test(p)) return false;
    const segs = p.split('/');
    return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

const RELATIVE_POSIX_PATH = z.string().refine(isSafeRelativePath, {
    message: 'must be a safe relative POSIX path (no .., absolute, control bytes)',
});

/** The eleven SDK contract families a bundle may register. */
const PLUGIN_KIND = z.enum([
    'task',
    'provider',
    'trickplay',
    'watch-sync',
    'feature',
    'integration',
    'media-source',
    'external-service',
    'subtitle-provider',
    'lyrics-provider',
    'auth-provider',
]);

export const ExternalPluginManifestSchema = z
    .object({
        name: z.string().regex(ID_PATTERN), // kills unicode/case/.. in the on-disk dir name [Fable-4c]
        version: z.string().regex(SEMVER_RE),
        /**
         * Single-contract plugins. Mutually exclusive with `kinds` — exactly
         * one of the two is required (refined below), so every manifest signed
         * before `kinds` existed keeps parsing byte-for-byte.
         */
        kind: PLUGIN_KIND.optional(),
        /**
         * Multi-contract plugins: every contract the bundle registers. Part of
         * the SIGNED bytes exactly as `kind` is, so a bundle cannot quietly
         * register a contract its manifest never declared. Order is not
         * meaningful (the loader compares as a set) but entries must be unique.
         */
        kinds: z.array(PLUGIN_KIND).min(1).optional(),
        bundleUrl: HTTPS_OR_HTTP_URL,
        checksum: z.string().regex(/^[a-f0-9]{64}$/), // = sha256(ARCHIVE) when format==='bundle'
        /**
         * Reproducible CONTENT identity of a bundle — sha256 over the canonical
         * `${sha256}  ${size}  ${path}` listing of its files (see
         * archive.ts#computeTreeDigestFromFiles). Distinct from `checksum`, and
         * both are covered by the manifest signature:
         *
         *   checksum    sha256 of the SHIPPED BYTES. Transport integrity — "what
         *               I downloaded is what was signed". NOT reproducible: with
         *               gzip those bytes come from zlib, whose output moves
         *               between versions, so rebuilding the same source
         *               elsewhere yields a different value.
         *   treeDigest  sha256 over file CONTENT. Identical on every machine and
         *               at every compression level, so a third party can rebuild
         *               from source and confirm they got the same plugin.
         *
         * OPTIONAL for back-compat: manifests signed before this field existed
         * carry only `checksum`, and must keep installing. When present it is
         * verified against the extracted tree — see installer.ts#stageFreshBundle.
         */
        treeDigest: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        /**
         * The plugin contract ABI this bundle was built against. Part of the
         * SIGNED bytes: the host refuses to install or load a mismatch, so it
         * must not be something a mirror can rewrite.
         *
         * OPTIONAL for back-compat — a manifest signed before the field existed
         * carries none and is read as ABI 1 (see `manifestSdkAbi`). That keeps
         * today's manifests installing and correctly fails them the moment the
         * host moves past ABI 1.
         */
        sdkAbi: z.number().int().positive().optional(),

        // ── Catalog metadata ────────────────────────────────────────────────
        // SIGNED, all of it, and the split is deliberate. The test for whether
        // a field belongs here: could a malicious catalog substituting this
        // value get an operator to install something they otherwise would not?
        // If yes, it must be covered by the signature. Presentation — pretty
        // title, icon, screenshots, download counts, long README — is not, and
        // lives only in a catalog index.
        //
        // All optional, so every manifest signed before these existed keeps
        // installing byte-for-byte.

        /**
         * The publisher's own name for themselves. A CLAIM bound to the
         * verifying key by the signature — not a verified identity, since two
         * different trusted keys can both claim "Trakt Team". Always shown
         * beside the key id, never alone.
         */
        publisher: z.string().max(120).optional(),
        /**
         * One-line summary, rendered in the install-confirm dialog. Signed
         * because "harmless theme" over a watch-sync-with-database bundle is
         * exactly the swap a malicious index would make.
         */
        description: z.string().max(500).optional(),
        /** SPDX id, advisory — not validated against the list, which churns. */
        license: z.string().max(64).optional(),
        /**
         * Where to read the code before deciding to trust the key. Signed
         * because a catalog that can point "source" at a lookalike repository
         * subverts the audit that trust is supposed to rest on. (A marketing
         * homepage is a different, unsigned, catalog-only field.)
         */
        sourceUrl: HTTPS_OR_HTTP_URL.optional(),
        /**
         * What the bundle says it needs. The most trust-relevant metadata
         * there is, and until now only knowable AFTER the bundle's top-level
         * code had already run with full host trust. Signed here so the
         * confirm dialog can show it, and enforced as an upper bound after
         * load — see `capabilitySubsetViolation`.
         */
        capabilities: z
            .object({
                http: z.boolean().optional(),
                database: z.boolean().optional(),
                cache: z.boolean().optional(),
                browserUi: z.boolean().optional(),
                webhook: z.boolean().optional(),
                allowedDomains: z.array(z.string()).optional(),
            })
            .optional(),
        /** Minimum app version. Advisory in v1; a catalog uses it to pick. */
        minAppVersion: z.string().regex(SEMVER_RE).optional(),
        /** Signed publication timestamp. The hook for future freshness checks. */
        releasedAt: z.string().datetime().optional(),
        keyId: z.string().optional(),
        format: z.enum(['single', 'bundle']).optional(), // absent ⇒ 'single' (back-compat)
        entry: RELATIVE_POSIX_PATH.optional(), // REQUIRED iff format==='bundle'
    })
    .refine((m) => m.format !== 'bundle' || !!m.entry, {
        message: "format:'bundle' requires an entry path",
    })
    .refine((m) => m.format === 'bundle' || m.entry === undefined, {
        message: "entry is only valid with format:'bundle'",
    })
    .refine((m) => m.format === 'bundle' || m.treeDigest === undefined, {
        // A single-file plugin has no tree to digest; accepting one here would
        // advertise a guarantee nothing checks.
        message: "treeDigest is only valid with format:'bundle'",
    })
    .refine((m) => (m.kind === undefined) !== (m.kinds === undefined), {
        // Exactly one. Accepting both would leave two signed answers to "what
        // may this bundle register", and the gate must have exactly one.
        message: "exactly one of 'kind' or 'kinds' is required",
    })
    .refine((m) => m.kinds === undefined || new Set(m.kinds).size === m.kinds.length, {
        message: "'kinds' must not repeat a contract kind",
    });
export type ExternalPluginManifest = z.infer<typeof ExternalPluginManifestSchema>;

/**
 * The contract kinds a manifest declares, normalised to a list.
 *
 * Single-contract (`kind: 'task'`) and multi-contract (`kinds: [...]`)
 * manifests both reduce to the same shape here, so callers never branch on
 * which field was signed. Never empty — the schema guarantees exactly one of
 * the two is present and that `kinds` is non-empty.
 */
export function manifestKinds(m: ExternalPluginManifest): string[] {
    return m.kinds ?? [m.kind as string];
}

/**
 * The contract ABI a manifest was built against.
 *
 * Absent ⇒ 1: manifests signed before `sdkAbi` existed were, by definition,
 * built against the only ABI there was.
 */
export function manifestSdkAbi(m: ExternalPluginManifest): number {
    return m.sdkAbi ?? 1;
}

/** The capability shape a manifest may declare, and a load may report. */
export type PluginCapabilitySummary = Record<string, unknown>;

const CAPABILITY_BOOLEANS = ['http', 'database', 'cache', 'browserUi', 'webhook'] as const;

/**
 * Refuse a bundle that uses more than its signed manifest declared, or null.
 *
 * The install-confirm dialog is where the operator makes the trust decision,
 * and it can only honestly show what was SIGNED. Without this check the
 * declaration would be decoration: a bundle could advertise "http only", get
 * approved on that basis, and then register database access — making the
 * dialog a lie in exactly the direction that matters.
 *
 * Upper bound, not equality. Declaring a capability you end up not using is
 * merely over-cautious; using one you never declared is the problem.
 *
 * An absent declaration means the manifest predates the field, and nothing is
 * enforced — the alternative would refuse every plugin signed before this
 * shipped.
 */
export function capabilitySubsetViolation(
    declared: PluginCapabilitySummary | undefined,
    loaded: PluginCapabilitySummary | null,
): string | null {
    if (!declared || !loaded) return null;

    const exceeded = CAPABILITY_BOOLEANS.filter(
        (key) => loaded[key] === true && declared[key] !== true,
    );
    if (exceeded.length > 0) {
        return (
            `bundle uses capabilities its manifest did not declare: ${exceeded.join(', ')}. ` +
            'The signed manifest is what the operator approved.'
        );
    }

    const declaredDomains = new Set(
        Array.isArray(declared.allowedDomains) ? declared.allowedDomains.map(String) : [],
    );
    const loadedDomains = Array.isArray(loaded.allowedDomains)
        ? loaded.allowedDomains.map(String)
        : [];
    const strayDomains = loadedDomains.filter((d) => !declaredDomains.has(d));
    if (strayDomains.length > 0) {
        return (
            `bundle allows outbound domains its manifest did not declare: ` +
            `${strayDomains.join(', ')}.`
        );
    }

    return null;
}

/** True when the manifest declares more than one contract. */
export function isMultiContract(m: ExternalPluginManifest): boolean {
    return m.kinds !== undefined;
}

/** Strict major.minor.patch compare (no dep). Returns >0, 0, <0. Throws on non-strict input. [review C10] */
export function compareSemver(a: string, b: string): number {
    const parse = (v: string): [number, number, number] => {
        if (!SEMVER_RE.test(v)) throw new Error(`not a strict semver: ${v}`);
        const [maj, min, pat] = v.split('.').map(Number);
        return [maj, min, pat];
    };
    const av = parse(a);
    const bv = parse(b);
    for (let i = 0; i < 3; i++) {
        if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
}
