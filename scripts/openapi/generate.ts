#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI 3.1 Spec Generator
 *
 * Generates three specs:
 * - docs/api/api-v1.yaml       - External consumers + native clients (/api/v1/*)
 * - docs/api/internal-api.yaml - Web frontend type generation (/api/* admin)
 * - docs/api/openapi.yaml      - Combined for TypeScript type generation
 *
 * The versioned public/native surface (/api/v1/*) is collected from colocated
 * _openapi.ts sibling files via the filesystem-walking generator. Internal
 * admin/misc routes still use hand-written definitions in routes/.
 * Each operation carries an `x-stability` tier (stable|beta|experimental|protocol|deprecated).
 *
 * Run: npm run openapi:generate
 */

// MUST BE FIRST: installs the ESM loader hooks ($app/$env/?raw stubs), the
// Svelte rune globals, and scrubs connection env vars — all BEFORE any import
// below can pull a def module transitively. ESM `import` statements hoist above
// executable code, so a first-position side-effect import is the ONLY way to
// guarantee this bootstrap runs before every other static import here.
import './register-loader.mjs';

import { createDocument, type ZodOpenApiPathsObject } from 'zod-openapi';
import { stringify } from 'yaml';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Public routes: collected from colocated _openapi.ts files
import { collectPublicRoutes } from './generate-public';
import { applyLocalizedParameters, applyPublicTaxonomy } from './public-taxonomy';
import { binaryStringViolations } from './helpers';
import { SSE_FRAME_SCHEMAS } from './sse-frames';
import { WATCH_TOGETHER_FRAME_SCHEMAS } from '../../src/lib/schemas/watch-together';

// OAuth routes (not under public-api/, hand-written)
import { oauthRoutes } from './routes/oauth';

// Internal-only route definitions (admin, misc internal endpoints)
import { adminRoutes } from './routes/admin';
import { miscRoutes } from './routes/misc';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Collect public routes from colocated _openapi.ts files
// ---------------------------------------------------------------------------
const {
    routes: colocatedRoutes,
    internalRoutes: colocatedInternalRoutes,
    warnings,
    importFailures,
    bodyOmissions,
    unlabelledPublic,
    queryOmissions,
    defDisagreements,
    acceptedDrift,
    pendingDrift,
    staleAllowlist,
    stats,
} = await collectPublicRoutes();


// Merge OAuth routes (hand-written, not under public-api/)
const publicRoutes: ZodOpenApiPathsObject = {
    ...oauthRoutes,
    ...colocatedRoutes,
};

// Tags, operationIds and the sidebar order of every public operation come from
// the registry (scripts/openapi/public-taxonomy.ts), not from the defs. Applied
// to the shared path items, so the combined spec gets the same ids.
const publicTaxonomy = applyPublicTaxonomy(
    publicRoutes as Record<string, Record<string, unknown> | undefined>,
);
for (const key of unlabelledPublic) {
    publicTaxonomy.problems.push(`${key}: no explicit \`stability\` in its docs (public operations need one)`);
}
if (publicTaxonomy.problems.length > 0) {
    console.error(`\nPublic API taxonomy FAILED (${publicTaxonomy.problems.length}):`);
    for (const problem of publicTaxonomy.problems) console.error(`  - ${problem}`);
    process.exit(1);
}

// Internal routes: hand-written admin/misc definitions PLUS any colocated
// /api/v1/* route whose _openapi.ts marks visibility:'internal'. The latter
// stay mounted on /api/v1/* and reachable as today — they are only diverted
// here so they don't appear in the published api-v1.yaml.
const internalRoutes: ZodOpenApiPathsObject = {};
const internalAllRoutes: ZodOpenApiPathsObject = {
    ...adminRoutes,
    ...miscRoutes,
    ...colocatedInternalRoutes,
};
for (const [path, pathItem] of Object.entries(internalAllRoutes)) {
    if (path.startsWith('/api/')) {
        internalRoutes[path] = pathItem;
    }
}

// ---------------------------------------------------------------------------
// Public API Document (for external consumers)
// ---------------------------------------------------------------------------
const publicDocument = createDocument({
    openapi: '3.1.0',
    info: {
        title: 'Lumastra API (v1)',
        description: `REST API for Lumastra — a self-hosted media server for movies, series, music, audiobooks and live TV.

This is the versioned public + native-client surface served under \`/api/v1/*\`.

## Authentication

Most \`/api/v1/*\` endpoints require authentication with a bearer token:

**Option 1: Bearer Token Header (Recommended)**
\`\`\`
Authorization: Bearer <access_token>
\`\`\`

Account credentials go only in \`Authorization: Bearer …\`. Media delivery URLs returned by \`POST /api/v1/play-sessions\` carry their own \`?grant=\` and can be opened without headers.

## Start here

The sidebar follows a client's path: **Getting started** (discover the server, sign in, read the user),
**Library** (find and show titles), **Playback** (start a playback session, then stream), then Music,
Audiobooks, Live TV, your data, social features, devices, integrations and administration. Every
operationId is hand-picked and stable; generated clients use it as the method name.

## Stability (\`x-stability\`)

- **\`stable\`** — no breaking change without deprecation. New optional fields and operations can appear.
- **\`beta\`** — supported, but the shape may change in a minor release (listed in the changelog).
- **\`experimental\`** — may change or disappear in any release.
- **\`protocol\`** — byte and streaming endpoints (files, HLS, images, OAuth); use the URLs JSON responses give you.
- **\`deprecated\`** — still works; \`deprecated: true\` and \`x-deprecation\` name the replacement and removal date,
  and responses carry \`Deprecation\`, \`Sunset\` and \`Link: rel="successor-version"\` headers.

Policy and what 0.1 promises: "Stability and deprecation" in the API guide (https://lumastra.org/developers/api/).

## Language

Translated titles and overviews follow \`Accept-Language\` unless the user stored a metadata language with
\`PATCH /api/v1/me/playback-preferences\`. Details: "Language negotiation" in the API guide.

## OAuth Flow (Device Authorization)

1. \`POST /oauth/device\` - Get device code and user code
2. User visits verification URL and authorizes the device
3. \`POST /oauth/token\` - Poll until authorized, then receive access token
4. Use access token for all \`/api/v1/*\` requests
5. \`POST /oauth/token\` with refresh_token - Get new access token when expired`,
        version: '1.0.0',
        contact: { name: 'Lumastra' },
        license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: 'https://lumastra.example.com', description: 'Your Lumastra instance' }],
    // Reading order from the registry; x-tagGroups is added below.
    tags: publicTaxonomy.tags,
    components: {
        securitySchemes: {
            grant: {
                type: 'apiKey',
                in: 'query',
                name: 'grant',
                description: 'Item/session-bound playback delivery grant from POST /api/v1/play-sessions; use the issued URL.',
            },
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'OAuth 2.0 access token obtained via Device Authorization Grant flow. Operations carry `x-required-grant`: the token grant (read, write, admin, integrations:read) a PAT or service token needs; sessions and OAuth device tokens follow the signed-in user\'s role.',
            },
        },
        // SSE frame payloads. Registered manually because no operation can
        // reference them: an SSE response body is `text/event-stream` and
        // types as a string, so without this the whole admin/maintenance wire
        // protocol would be undocumented. The registry covers direct and hub envelopes;
        // see scripts/openapi/sse-frames.ts.
        schemas: { ...SSE_FRAME_SCHEMAS, ...WATCH_TOGETHER_FRAME_SCHEMAS },
    },
    paths: publicRoutes,
});

// Scalar renders x-tagGroups as sidebar sections; Swagger UI ignores it and
// uses the tag order above.
(publicDocument as Record<string, unknown>)['x-tagGroups'] = publicTaxonomy.tagGroups;
const localizedProblems = applyLocalizedParameters(publicDocument as Parameters<typeof applyLocalizedParameters>[0]);
if (localizedProblems.length > 0) {
    console.error(`\nLocalized-operation list FAILED (${localizedProblems.length}):`);
    for (const problem of localizedProblems) console.error(`  - ${problem}`);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Internal API Document (for web frontend)
// ---------------------------------------------------------------------------
const internalDocument = createDocument({
    openapi: '3.1.0',
    info: {
        title: 'Lumastra Internal API',
        description: `Internal API for Lumastra web frontend.

## Authentication

All \`/api/*\` endpoints use session-based authentication via Authentik forward auth.
These endpoints are NOT intended for external consumption.

## Stability

This API may change without notice as the frontend evolves.
For external integrations, use the versioned API (\`/api/v1/*\`) instead.`,
        version: '1.0.0',
        contact: { name: 'Lumastra' },
        license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: 'https://lumastra.example.com', description: 'Your Lumastra instance' }],
    tags: [
        { name: 'Admin', description: 'Admin dashboard and system management' },
        { name: 'Admin Devices', description: 'Admin device management' },
        { name: 'Admin Debug', description: 'Admin debug endpoints' },
        {
            name: 'AI Admin',
            description: 'AI recommendation system administration',
        },
        {
            name: 'AI Assistant',
            description: 'AI-powered assistant recommendations',
        },
        { name: 'Holidays', description: 'Holiday theme management' },
        { name: 'Content', description: 'Content management' },
        { name: 'For You', description: 'Personalized content sections' },
        { name: 'User', description: 'User preferences and settings' },
        { name: 'Trending', description: 'Trending content management' },
    ],
    components: {
        securitySchemes: {
            sessionAuth: {
                type: 'apiKey',
                in: 'header',
                name: 'X-Forwarded-User',
                description: 'Authentik forward auth session header',
            },
        },
    },
    paths: internalRoutes,
});

// ---------------------------------------------------------------------------
// Post-process: auto-generate operationId for every operation
// ---------------------------------------------------------------------------
const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const;

function pathToOperationId(method: string, path: string): string {
    // camelCase the whole path into a stable, idiomatic operationId. This MUST stay
    // camelCase (no underscores): operationId is the client-codegen contract — Swift /
    // openapi-typescript derive method names from it, so getMediaId must never become
    // getMedia_id. The combined-doc library/paths vs library-paths collision is handled
    // by checking opId uniqueness per PUBLISHED doc (public + internal), not the merge.
    const cleaned = path
        .replace(/^\/(?:api\/v1|public-api|api|oauth)\//, '') // strip prefix
        .replace(/\{([^}]+)\}/g, (_, p: string) => p.replace(/_/g, '')) // {user_id} → userid
        .split('/')
        .filter(Boolean)
        .map((seg) =>
            seg
                .split(/[-_]/)
                .map((w, i) =>
                    i === 0
                        ? w.toLowerCase()
                        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
                )
                .join(''),
        )
        .map((seg, i) => (i === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
        .join('');

    return `${method}${cleaned.charAt(0).toUpperCase() + cleaned.slice(1)}`;
}

function addOperationIds(document: ReturnType<typeof createDocument>): number {
    const paths = document.paths ?? {};
    let count = 0;
    for (const [path, pathItem] of Object.entries(paths)) {
        if (!pathItem) continue;
        for (const method of HTTP_METHODS) {
            const operation = (pathItem as Record<string, unknown>)[method] as
                Record<string, unknown> | undefined;
            if (operation && !operation.operationId) {
                operation.operationId = pathToOperationId(method, path);
                count++;
            }
        }
    }
    return count;
}

// Add operation IDs to both documents
const publicOpCount = addOperationIds(publicDocument);
const internalOpCount = addOperationIds(internalDocument);

// ---------------------------------------------------------------------------
// Post-process: fix nullable format for Swift compatibility
// ---------------------------------------------------------------------------
// zod-to-openapi emits nullable as:  anyOf: [{type: "string"}, {type: "null"}]
// swift-openapi-generator can't parse that format and warns "Schema null not supported".
//
// But it DOES support the JSON Schema 2020-12 type-array format:
//   type: ["string", "null"]
// which correctly generates Swift.String? (optional).
//
// This post-processor converts all anyOf/oneOf nullable patterns to type arrays.
// See: https://swiftpackageindex.com/apple/swift-openapi-generator/documentation/swift-openapi-generator/handling-nullable-schemas
// ---------------------------------------------------------------------------
function fixNullableForSwift(obj: unknown): number {
    if (obj === null || obj === undefined || typeof obj !== 'object') return 0;

    if (Array.isArray(obj)) {
        let count = 0;
        for (const item of obj) {
            count += fixNullableForSwift(item);
        }
        return count;
    }

    const record = obj as Record<string, unknown>;
    let count = 0;

    // Check properties for anyOf/oneOf nullable patterns
    if (record.properties && typeof record.properties === 'object') {
        const properties = record.properties as Record<string, Record<string, unknown>>;

        for (const [propName, propValue] of Object.entries(properties)) {
            if (!propValue || typeof propValue !== 'object' || Array.isArray(propValue)) continue;

            const variants = (propValue.anyOf ?? propValue.oneOf) as
                Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(variants)) continue;

            const nullIdx = variants.findIndex((v) => v.type === 'null');
            if (nullIdx === -1 || variants.length !== 2) continue;

            // Get the non-null variant
            const nonNull = variants[1 - nullIdx];

            if (typeof nonNull.type === 'string') {
                // Simple type: anyOf:[{type:X},{type:null}] → type:[X, null]
                //
                // The non-null variant carries the CONSTRAINTS — enum, format,
                // minimum/maximum, pattern, minLength — and dropping the anyOf
                // used to drop them with it. That silently published every
                // nullable constrained field as a bare `type: [string, 'null']`:
                // `feedback` lost its ["liked","disliked"], date-times lost
                // `format`, bounded numbers lost their range. Carry those keys
                // up onto the merged property; keys already on the property
                // (e.g. a `.describe()` that landed outside the union) win.
                const { anyOf: _anyOf, oneOf: _oneOf, ...rest } = propValue;
                const { type: _nonNullType, ...nonNullConstraints } = nonNull;
                properties[propName] = {
                    ...nonNullConstraints,
                    ...rest,
                    type: [nonNull.type, 'null'],
                };
                count++;
            } else if (typeof nonNull.$ref === 'string') {
                // $ref type: anyOf:[{$ref:X},{type:null}] → $ref:X (+ remove from required)
                // Swift treats missing fields as nil, same as null
                const { anyOf: _anyOf2, oneOf: _oneOf2, ...rest2 } = propValue;
                properties[propName] = {
                    ...rest2,
                    $ref: nonNull.$ref,
                };
                // Remove from required array so Swift generates T? (optional)
                if (Array.isArray(record.required)) {
                    const reqIdx = record.required.indexOf(propName);
                    if (reqIdx !== -1) record.required.splice(reqIdx, 1);
                }
                count++;
            } else {
                continue;
            }
        }
    }

    // Recurse into all nested objects
    for (const value of Object.values(record)) {
        count += fixNullableForSwift(value);
    }

    return count;
}

const nullableFixed = fixNullableForSwift(publicDocument);

// ---------------------------------------------------------------------------
// Post-process: a genuine multi-type union must stay an `anyOf`
// ---------------------------------------------------------------------------
// zod 4.4+ renders `z.union([z.number(), z.string()])` as a JSON-Schema type
// ARRAY (`type: [number, string]`) where 4.3 rendered it as
// `anyOf: [{type: number}, {type: string}]`. Both are valid OpenAPI 3.1 and mean
// the same thing — but swift-openapi-generator does NOT implement type arrays:
// it takes the first member and silently drops the rest. `UniversalMediaItem`'s
// `rating` and `year` (number|string, because the values come straight off
// Postgres rows that can be numeric strings) generated as bare `Swift.Double?`,
// which fails to decode the entire response the first time the server sends a
// string.
//
// The zod bump that caused this (4.3.6 → 4.6.2) did not regenerate the spec, so
// the encoding change sat invisible in the published document until the next
// regeneration. It is reversed here rather than at 35 call sites.
//
// This is the exact COMPLEMENT of fixNullableForSwift above, which deliberately
// folds `anyOf: [{X}, {null}]` INTO `type: [X, "null"]` because the generator
// does understand that shape as "optional X". The two conditions are disjoint:
// that one produces arrays with a single non-null member, this one only touches
// arrays with two or more.
function splitMultiTypeUnions(obj: unknown): number {
    if (obj === null || obj === undefined || typeof obj !== 'object') return 0;
    if (Array.isArray(obj)) {
        let count = 0;
        for (const item of obj) count += splitMultiTypeUnions(item);
        return count;
    }

    const record = obj as Record<string, unknown>;
    let count = 0;

    const type = record.type;
    if (Array.isArray(type)) {
        const members = type.filter((t): t is string => typeof t === 'string');
        const nonNull = members.filter((t) => t !== 'null');
        if (members.length === type.length && nonNull.length >= 2) {
            delete record.type;
            record.anyOf = members.map((t) => ({ type: t }));
            count += 1;
        }
    }

    for (const value of Object.values(record)) count += splitMultiTypeUnions(value);
    return count;
}

const multiTypeUnionsSplit =
    splitMultiTypeUnions(publicDocument) + splitMultiTypeUnions(internalDocument);

// ---------------------------------------------------------------------------
// Post-process: strip the JS-safe-integer min/max noise from integer schemas
// ---------------------------------------------------------------------------
// Zod's `z.int()` / `z.number().int()` emits the JS safe-integer bounds
// (±9007199254740991 = Number.MAX_SAFE_INTEGER) as `minimum`/`maximum` on every
// integer schema. That's technically true but useless noise in the published
// contract — it clutters every pagination bound, count, and index, and some
// codegen tools surface it as a spurious constraint.
//
// This pass deletes ONLY a `minimum` equal to -9007199254740991 and a `maximum`
// equal to +9007199254740991 (the exact safe-integer sentinels), and only when
// they sit on an `integer`-typed schema. A real, author-supplied bound (e.g.
// `.min(0)`, `.max(100)`) has a different value and is left untouched. This is a
// spec-cleanup only — runtime Zod validation is unaffected (the generator does
// not feed the spec back into validation).
const SAFE_INT_MAX = 9007199254740991; // Number.MAX_SAFE_INTEGER
const SAFE_INT_MIN = -9007199254740991; // -Number.MAX_SAFE_INTEGER

function isIntegerSchema(record: Record<string, unknown>): boolean {
    const t = record.type;
    if (t === 'integer') return true;
    // JSON Schema 2020-12 nullable form: type: ['integer', 'null']
    if (Array.isArray(t) && t.includes('integer')) return true;
    return false;
}

function stripSafeIntBounds(obj: unknown): number {
    if (obj === null || obj === undefined || typeof obj !== 'object') return 0;

    if (Array.isArray(obj)) {
        let count = 0;
        for (const item of obj) count += stripSafeIntBounds(item);
        return count;
    }

    const record = obj as Record<string, unknown>;
    let count = 0;

    if (isIntegerSchema(record)) {
        if (record.minimum === SAFE_INT_MIN) {
            delete record.minimum;
            count++;
        }
        if (record.maximum === SAFE_INT_MAX) {
            delete record.maximum;
            count++;
        }
    }

    for (const value of Object.values(record)) {
        count += stripSafeIntBounds(value);
    }

    return count;
}

const safeIntBoundsStripped =
    stripSafeIntBounds(publicDocument) + stripSafeIntBounds(internalDocument);

// ---------------------------------------------------------------------------
// Write output files
// ---------------------------------------------------------------------------
const publicYaml = stringify(publicDocument, { lineWidth: 120 });
const internalYaml = stringify(internalDocument, { lineWidth: 120 });

const publicPath = resolve(__dirname, '../../docs/api/api-v1.yaml');
const internalPath = resolve(__dirname, '../../docs/api/internal-api.yaml');

writeFileSync(publicPath, publicYaml, 'utf-8');
writeFileSync(internalPath, internalYaml, 'utf-8');

// ---------------------------------------------------------------------------
// Combined spec for TypeScript type generation
// (Includes all operations from both public and internal APIs)
// ---------------------------------------------------------------------------
// A path can contain public reads and internal writes. Merge its methods so
// the internal path item does not replace the public operations.
const combinedRoutes: ZodOpenApiPathsObject = { ...publicRoutes };
for (const [path, pathItem] of Object.entries(internalRoutes)) {
    const duplicated = Object.keys(pathItem).filter((key) => key in (combinedRoutes[path] ?? {}));
    if (duplicated.length > 0) {
        throw new Error(
            `${path}: ${duplicated.join(', ')} listed in both the public and internal spec`,
        );
    }
    combinedRoutes[path] = { ...combinedRoutes[path], ...pathItem };
}
const combinedDocument = createDocument({
    openapi: '3.1.0',
    info: {
        title: 'Lumastra API (Combined)',
        description:
            'Combined API spec for TypeScript type generation. Do not use for documentation.',
        version: '1.0.0',
    },
    // Same manual registration as the public doc — this spec is what
    // `openapi-typescript` reads, so the frame types have to be in it too or
    // the web client cannot type an `event: admin` payload either.
    components: {
        securitySchemes: publicDocument.components?.securitySchemes,
        schemas: { ...SSE_FRAME_SCHEMAS, ...WATCH_TOGETHER_FRAME_SCHEMAS },
    },
    paths: combinedRoutes,
});

const combinedOpCount = addOperationIds(combinedDocument);
const combinedSafeIntStripped = stripSafeIntBounds(combinedDocument);
const combinedMultiTypeSplit = splitMultiTypeUnions(combinedDocument);
const combinedYaml = stringify(combinedDocument, { lineWidth: 120 });
const combinedPath = resolve(__dirname, '../../docs/api/openapi.yaml');
writeFileSync(combinedPath, combinedYaml, 'utf-8');

// Stats
const publicPathCount = Object.keys(publicDocument.paths ?? {}).length;
const internalPathCount = Object.keys(internalDocument.paths ?? {}).length;
const combinedPathCount = Object.keys(combinedDocument.paths ?? {}).length;

console.log('OpenAPI specs generated:');
console.log('');
console.log(`Public API (${publicPath}):`);
console.log(`  Paths: ${publicPathCount}`);
console.log(`  Operations: ${publicOpCount}`);
console.log(`  Nullable fixed: ${nullableFixed} fields (anyOf→type array)`);
console.log(
    `  Multi-type unions split: ${multiTypeUnionsSplit + combinedMultiTypeSplit} fields (type array→anyOf)`,
);
console.log(
    `  Colocated: ${stats.withMetadata}/${stats.total} routes (${stats.reExports} re-exports, ${stats.custom} custom)`,
);
console.log(
    `  Safe-int bounds stripped: ${safeIntBoundsStripped + combinedSafeIntStripped} (public+internal+combined)`,
);
if (stats.missing > 0) {
    console.log(`  Missing _openapi.ts: ${stats.missing}`);
}
console.log(`  For: External consumers (TV apps, mobile)`);
console.log('');
console.log(`Internal API (${internalPath}):`);
console.log(`  Paths: ${internalPathCount}`);
console.log(`  Operations: ${internalOpCount}`);
console.log(`  Diverted from /api/v1 via visibility:'internal': ${stats.internal} routes`);
console.log(`  For: Documentation only`);
console.log('');
console.log(`Combined (${combinedPath}):`);
console.log(`  Paths: ${combinedPathCount}`);
console.log(`  Operations: ${combinedOpCount}`);
console.log(`  For: TypeScript type generation`);

if (warnings.length > 0 && process.argv.includes('--verbose')) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) {
        console.log(`  - ${w}`);
    }
}

// ---------------------------------------------------------------------------
// Phase 1: report where the def-sourced request contract added or changed a
// route's query/body/params vs its hand-authored `_openapi.ts`. GAINED entries
// are previously-hidden request params the def now exposes (the whole point);
// DIFFERS entries are stale `_openapi.ts` values the def overrode. Informational
// only — never fails the build.
// ---------------------------------------------------------------------------
if (defDisagreements.length > 0) {
    console.log(
        `\nDef-sourced request contract (${defDisagreements.length} change(s) vs _openapi.ts):`,
    );
    for (const d of defDisagreements) {
        console.log(`  - ${d}`);
    }
} else {
    console.log('\nDef-sourced request contract: no differences vs _openapi.ts');
}

// ---------------------------------------------------------------------------
// KEPT-slot drift classification (report-only; does not affect generation).
//
// `chooseSlot` KEEPS the hand-authored `_openapi.ts` value for a slot whenever
// letting the def win would lose a documented contract detail. Those KEPT rows
// are split against the E1 ACCEPTED-DRIFT allowlist (`accepted-drift.ts`):
//   - ACCEPTED-DRIFT: 19 E1-adjudicated permanent false-alarms (def is an
//     intentional lenient/partial gate; handler re-validates). Printed for the
//     record but NOT part of the pending-reconcile tally.
//   - PENDING: any KEPT row NOT on the allowlist — genuinely-new drift, reported
//     loudly so it stands out instead of hiding among the permanent 19.
// A STALE allowlist entry (listed but no matching KEPT row this run) is flagged
// so the allowlist can be pruned. All informational — never fails the build.
// ---------------------------------------------------------------------------
if (acceptedDrift.length > 0) {
    console.log(
        `\nAccepted drift (${acceptedDrift.length} E1-adjudicated, excluded from the pending tally):`,
    );
    for (const a of acceptedDrift) {
        console.log(`  - ${a}`);
    }
}

if (pendingDrift.length > 0) {
    console.log(
        `\nPending drift to reconcile (${pendingDrift.length} KEPT row(s) NOT on the E1 allowlist):`,
    );
    for (const p of pendingDrift) {
        console.log(`  - ${p}`);
    }
} else {
    console.log('\nPending drift to reconcile: none (every KEPT row is E1-allowlisted)');
}

if (staleAllowlist.length > 0) {
    console.log(
        `\nStale ACCEPTED-DRIFT allowlist (${staleAllowlist.length} entr(y/ies) matched no KEPT row — prune accepted-drift.ts):`,
    );
    for (const s of staleAllowlist) {
        console.log(`  - ${s}`);
    }
}

// Always surface def/_openapi import failures (not just under --check), so a
// broken def is visible on every plain generate. --check still FAILS on them
// (GUARD B below); a plain generate only warns and drops that route's
// def-sourced contract.
if (importFailures.length > 0) {
    console.log(
        `\nImport failures (${importFailures.length}) — route(s) fell back to _openapi.ts or were dropped:`,
    );
    for (const f of importFailures) {
        console.log(`  - ${f}`);
    }
}

// ---------------------------------------------------------------------------
// Coverage check mode (for CI)
// ---------------------------------------------------------------------------
if (process.argv.includes('--check')) {
    // ------------------------------------------------------------------
    // GUARD (operationId uniqueness): within the public, internal, AND combined
    // documents, every operationId must map to exactly one `METHOD path`. A
    // collision means two DIFFERENT routes generate the same id (e.g.
    // /library/paths vs /library-paths if the id strategy regressed), which
    // silently overwrites one operation in client codegen / type generation.
    // addOperationIds() has already run on all three documents above. The same
    // (method, path) legitimately appears in multiple documents (combined =
    // public + internal), so we key collisions by the SET of distinct
    // `METHOD path` an id is attached to — only >1 distinct route is a real bug.
    // ------------------------------------------------------------------
    const opIdRoutes = new Map<string, Map<string, Set<string>>>(); // opId → (METHOD path → docLabels)
    const HTTP_METHODS_ALL = HTTP_METHODS;
    const collectOpIds = (document: ReturnType<typeof createDocument>, docLabel: string): void => {
        const paths = document.paths ?? {};
        for (const [path, pathItem] of Object.entries(paths)) {
            if (!pathItem) continue;
            for (const method of HTTP_METHODS_ALL) {
                const operation = (pathItem as Record<string, unknown>)[method] as
                    Record<string, unknown> | undefined;
                const opId = operation?.operationId;
                if (typeof opId !== 'string') continue;
                const route = `${method.toUpperCase()} ${path}`;
                let routes = opIdRoutes.get(opId);
                if (!routes) opIdRoutes.set(opId, (routes = new Map()));
                let docs = routes.get(route);
                if (!docs) routes.set(route, (docs = new Set()));
                docs.add(docLabel);
            }
        }
    };
    collectOpIds(publicDocument, 'public');
    collectOpIds(internalDocument, 'internal');
    collectOpIds(combinedDocument, 'combined');

    // Collision = a single operationId attached to >1 DISTINCT route.
    const opIdCollisions = [...opIdRoutes.entries()].filter(([, routes]) => routes.size > 1);
    if (opIdCollisions.length > 0) {
        console.log(
            `\nOpenAPI operationId check FAILED: ${opIdCollisions.length} operationId(s) collide across distinct routes:`,
        );
        for (const [opId, routes] of opIdCollisions) {
            console.log(`  - "${opId}" used by:`);
            for (const [route, docs] of routes) {
                console.log(`      ${route} (${[...docs].join(', ')})`);
            }
        }
        process.exit(1);
    }
    console.log('OpenAPI operationId check PASSED: all operationIds map to a single route');

    // ------------------------------------------------------------------
    // GUARD (operationId style): operationId is the client-codegen contract —
    // Swift / openapi-typescript derive method names from it, so it MUST be
    // camelCase. An underscore/hyphen means a slugger regression silently renamed
    // every client call site (getMediaId -> getMedia_id). Reuses the opId set
    // collected above.
    // ------------------------------------------------------------------
    const badStyleOpIds = [...opIdRoutes.keys()].filter((id) => /[_-]/.test(id));
    if (badStyleOpIds.length > 0) {
        console.error(
            `\nOpenAPI operationId STYLE check FAILED: ${badStyleOpIds.length} operationId(s) are not camelCase (contain _ or -):`,
        );
        for (const id of badStyleOpIds) console.error(`  - ${id}`);
        console.error(
            'operationId is the client-codegen contract; keep it camelCase (fix pathToOperationId or the explicit override).',
        );
        process.exit(1);
    }
    console.log('OpenAPI operationId style check PASSED: all operationIds are camelCase');

    // ------------------------------------------------------------------
    // GUARD (binary array): a route that declared a STRING `binary:` content
    // type instead of `string[]`. binaryResponse() coerces it so the emitted
    // spec stays valid, but a string binary is a typo that escaped tsc (the
    // _openapi.ts is typechecked, so this is belt-and-suspenders) — fail the
    // build instead of silently coercing. Populated during collectPublicRoutes().
    // ------------------------------------------------------------------
    if (binaryStringViolations.length > 0) {
        console.log(
            `\nOpenAPI binary-array check FAILED: ${binaryStringViolations.length} route(s) declared a string binary content type (must be string[]):`,
        );
        for (const v of binaryStringViolations) {
            console.log(`  - ${v}`);
        }
        process.exit(1);
    }
    console.log('OpenAPI binary-array check PASSED: all binary content types are arrays');

    // ------------------------------------------------------------------
    // GUARD B: _openapi.ts files that EXIST but threw on import. The route is
    // silently dropped from the spec even though metadata was written for it
    // (classic cause: the file transitively imports a def → server runtime →
    // throws under tsx). This is far more dangerous than a genuinely-absent
    // _openapi.ts because it's invisible in the page count, so fail loudly.
    // ------------------------------------------------------------------
    if (importFailures.length > 0) {
        console.log(
            `\nOpenAPI silent-drop check FAILED: ${importFailures.length} _openapi.ts file(s) exist but threw on import — their route(s) were SILENTLY DROPPED from the spec:`,
        );
        for (const f of importFailures) {
            console.log(`  - ${f}`);
        }
        console.log(
            '  Fix: keep _openapi.ts light. Import schemas from $lib/schemas, never a def (a def pulls cache/tasks/lua and throws under tsx).',
        );
        // FIRST, rule out a false positive. This check has fired on a perfectly
        // healthy tree: an unresolvable `$lib/paraglide/messages.js` cascades into
        // "Cannot find package '$lib'" on whatever module imported it, and every def
        // downstream then counts as an import failure. Paraglide's output is
        // generated + gitignored, so a concurrent `npm run dev` (dev-mode output) or
        // a not-yet-compiled tree reproduces it, and the reported filename points at
        // an innocent module several hops from the real cause. Cost a full debugging
        // detour on 2026-07-30 — the routes were in the spec the whole time.
        console.log(
            "  BEFORE refactoring anything: if a message mentions \"Cannot find package '$lib'\" or '$app', " +
                'run `npm run paraglide:compile` and re-run this check. Also stop any concurrent ' +
                '`npm run dev` — its dev-mode paraglide output breaks importing the graph under tsx.',
        );
        process.exit(1);
    }

    // ------------------------------------------------------------------
    // GUARD C: public write routes whose handler validates a request body but
    // whose _openapi.ts omits `body:` → the operation ships with no requestBody
    // and client codegen produces a body-less call (the PUT /watch-state/{id}
    // bug class).
    // ------------------------------------------------------------------
    if (bodyOmissions.length > 0) {
        console.log(
            `\nOpenAPI requestBody check FAILED: ${bodyOmissions.length} write route(s) validate a body but declare no \`body:\`:`,
        );
        for (const v of bodyOmissions) {
            console.log(`  - ${v}`);
        }
        process.exit(1);
    }

    // ------------------------------------------------------------------
    // GUARD D: public routes whose handler/def validates a query but whose
    // _openapi.ts omits `query:` → the operation ships with no query
    // parameters and client codegen has no way to know it can send them.
    // ------------------------------------------------------------------
    if (queryOmissions.length > 0) {
        console.log(
            `\nOpenAPI query-parameters check FAILED: ${queryOmissions.length} route(s) validate a query but its _openapi.ts declares no \`query:\` (parameters will be missing from the spec):`,
        );
        for (const v of queryOmissions) {
            console.log(`  - ${v}`);
        }
        process.exit(1);
    }

    if (stats.missing > 0) {
        console.log(
            `\nOpenAPI coverage check FAILED: ${stats.missing} routes missing both _openapi.ts and def.docs`,
        );
        for (const w of warnings.filter((w) => w.startsWith('No _openapi.ts'))) {
            console.log(`  - ${w}`);
        }
        process.exit(1);
    }
    console.log('\nOpenAPI coverage check PASSED: all routes have _openapi.ts or def.docs');

    // ------------------------------------------------------------------
    // Error-envelope check: every 4xx/5xx response on the public surface
    // MUST be modeled as application/problem+json (matching the runtime
    // contract in src/lib/server/api/problem.ts) — never the retired
    // {success:false,...} application/json envelope. The /oauth/* endpoints
    // are exempt: they emit RFC 8628 / OAuth2-shaped errors by design.
    // ------------------------------------------------------------------
    const HTTP_METHODS_PUBLIC = ['get', 'post', 'put', 'delete', 'patch'] as const;
    const problemViolations: string[] = [];
    const publicPaths = (publicDocument.paths ?? {}) as Record<
        string,
        Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>
    >;
    for (const [routePath, pathItem] of Object.entries(publicPaths)) {
        if (routePath.startsWith('/oauth/')) continue;
        for (const method of HTTP_METHODS_PUBLIC) {
            const op = pathItem[method];
            if (!op?.responses) continue;
            for (const [status, response] of Object.entries(op.responses)) {
                if (!/^[45]\d\d$/.test(status)) continue;
                const content = response?.content;
                if (!content) continue;
                if (content['application/json'] && !content['application/problem+json']) {
                    problemViolations.push(
                        `${method.toUpperCase()} ${routePath} → ${status} uses application/json (expected application/problem+json)`,
                    );
                }
            }
        }
    }

    if (problemViolations.length > 0) {
        console.log(
            `\nOpenAPI problem+json check FAILED: ${problemViolations.length} error response(s) use the retired envelope:`,
        );
        for (const v of problemViolations) {
            console.log(`  - ${v}`);
        }
        process.exit(1);
    }
    console.log(
        'OpenAPI problem+json check PASSED: all error responses use application/problem+json',
    );

    // ------------------------------------------------------------------
    // GUARD (response schema): every PUBLIC 2xx (non-204) response MUST carry a
    // content schema. A response def that matched none of the convertResponse()
    // shapes (schema/binary/text/sse) degrades to a bare
    // `{ description: 'Unknown response type' }` with no `content` — that ships a
    // body-less success type to client codegen. 204 No Content legitimately has
    // no body, so it is exempt. /oauth/* is hand-written and exempt (consistent
    // with the problem+json check above).
    // ------------------------------------------------------------------
    const responseSchemaViolations: string[] = [];
    for (const [routePath, pathItem] of Object.entries(publicPaths)) {
        if (routePath.startsWith('/oauth/')) continue;
        for (const method of HTTP_METHODS_PUBLIC) {
            const op = pathItem[method];
            if (!op?.responses) continue;
            for (const [status, response] of Object.entries(op.responses)) {
                if (!/^2\d\d$/.test(status) || status === '204') continue;
                const content = response?.content;
                const hasSchema =
                    !!content &&
                    Object.values(content).some(
                        (c) => c && typeof c === 'object' && 'schema' in (c as object),
                    );
                if (!hasSchema) {
                    responseSchemaViolations.push(
                        `${method.toUpperCase()} ${routePath} → ${status} has no response content/schema ("Unknown response type")`,
                    );
                }
            }
        }
    }

    if (responseSchemaViolations.length > 0) {
        console.log(
            `\nOpenAPI response-schema check FAILED: ${responseSchemaViolations.length} public 2xx response(s) have no schema:`,
        );
        for (const v of responseSchemaViolations) {
            console.log(`  - ${v}`);
        }
        process.exit(1);
    }
    console.log('OpenAPI response-schema check PASSED: all public 2xx responses carry a schema');
}

// ---------------------------------------------------------------------------
// Force a clean exit.
//
// Now that the generator imports real def modules to source their request
// contract, those defs transitively start background handles (cache pub/sub
// retries, CPU-budget timers, task-event pollers) that keep the event loop
// alive indefinitely — the process would otherwise hang after writing. All spec
// output above is written synchronously, so exiting here is safe.
//
// Reaching this line means success: every `--check` guard calls process.exit(1)
// on failure and short-circuits before here, so exit 0 is correct for both the
// plain generate and a fully-passing --check run.
process.exit(0);
