// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Structural test — every exported `*ResponseSchema` in `src/lib/schemas/`
 * must be referenced by at least one other file under `src/`.
 *
 * Why: a Zod schema that documents a response contract but nothing
 * imports it leaves the contract unenforced anywhere. Routes drift away
 * from the declared shape silently — schema exists, no one parses it,
 * the response can carry any shape and no test fails.
 *
 * Stretch goal: every `*ResponseSchema` should be `.parse()`/`.safeParse()`
 * by its owning route handler at the response boundary. That gate is
 * encoded as a `.todo` placeholder below; pursue it via a follow-up sweep
 * once the existing 350+ schemas have been triaged (most are currently
 * used only via `z.infer<>` for type extraction). The reference check here
 * is the orphan gate — it catches "schema added, never imported" today and
 * will surface the same pattern for every future contributor.
 *
 * Implementation: plain `fs` + regex. The export idiom in this codebase is
 * uniform (`export const FooResponseSchema = z....`) so an AST walk would
 * be overkill. Reads happen once at top-level so all assertions share the
 * same scan; cost is ~150ms for the ~600-file repo today.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCHEMAS_DIR = join(REPO_ROOT, 'src', 'lib', 'schemas');
const SRC_DIR = join(REPO_ROOT, 'src');
// The OpenAPI generator's legacy admin route registry lives outside src/ and
// imports response schemas directly (e.g. api-admin-responses.ts's
// PersonResponseSchema) — a schema consumed only here would false-positive
// as orphaned if this directory weren't included in the reference scan.
const OPENAPI_ROUTES_DIR = join(REPO_ROOT, 'scripts', 'openapi', 'routes');

/**
 * Walk a directory recursively, yielding every `.ts` or `.svelte` file
 * (skipping `.d.ts`). Admin-UI consumers import schemas from `.svelte`
 * files too, so a schema referenced only by an admin component would
 * falsely look orphaned if we scanned `.ts` alone — the very class of
 * issue that hid 13 admin response schemas during the dynamicSchedule /
 * boot-audit sweep.
 *
 * Symlinks are NOT followed — a symlink loop under `src/` would otherwise
 * recurse until stack overflow.
 */
function* walkConsumable(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip generated / vendored trees.
            if (
                entry.name === 'node_modules' ||
                entry.name === '.svelte-kit' ||
                entry.name === 'dist'
            ) {
                continue;
            }
            yield* walkConsumable(full);
        } else if (entry.isFile()) {
            const isTs = entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts');
            const isSvelte = entry.name.endsWith('.svelte');
            if (isTs || isSvelte) yield full;
        }
    }
}

interface SchemaExport {
    name: string;
    file: string;
    /**
     * Type aliases declared in the same file via
     * `export type Foo = z.infer<typeof FooResponseSchema>`. A reference to
     * any of these counts as a consumer — the schema is still load-bearing
     * even if only the inferred type is imported externally.
     */
    aliasNames: string[];
}

/**
 * Collect every `export const <X>ResponseSchema = ...` from a file, plus any
 * `export type Y = z.infer<typeof X>` aliases pointing at it. The Zod
 * convention in this codebase is to export schemas as `const`; `export
 * function` or `export type` not derived from a schema are not enforcement
 * targets.
 */
function collectSchemaExports(file: string): SchemaExport[] {
    const text = readFileSync(file, 'utf8');
    const out: SchemaExport[] = [];
    const declRe = /\bexport\s+const\s+([A-Za-z_][A-Za-z0-9_]*ResponseSchema)\b/g;
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(text)) !== null) {
        const name = m[1]!;
        const aliasRe = new RegExp(
            `\\bexport\\s+type\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*z\\.infer<typeof\\s+${name}\\s*>`,
            'g',
        );
        const aliasNames: string[] = [];
        let am: RegExpExecArray | null;
        while ((am = aliasRe.exec(text)) !== null) {
            aliasNames.push(am[1]!);
        }
        out.push({ name, file, aliasNames });
    }
    return out;
}

/**
 * Schemas that are pending deletion after an API migration.
 *
 * These were left behind when their replacement schemas took over (e.g.
 * `SessionsResponseSchema` was superseded by `PagedSessionsResponseSchema`).
 * They are not imported by any file in `src/` and should be removed from
 * their declaring schema files. Until that cleanup sweep lands, they are
 * acknowledged here so the orphan gate does not block CI on known technical
 * debt while still catching genuinely new orphans from future contributors.
 *
 * HOW TO CLEAR THIS LIST: delete the corresponding `export const` (and its
 * accompanying `export type`) from the source file listed next to each entry.
 * Do NOT add new names here — fix the source instead.
 */
const PENDING_CLEANUP_ORPHANS = new Set<string>([
    // src/lib/schemas/api-admin-access.ts — superseded by v1 access-groups defs
    'AccessGroupResponseSchema',
    'AccessGroupMembersResponseSchema',
    // src/lib/schemas/api-admin-responses.ts — routes migrated to mount()/defineEndpoint()
    'FFmpegJobStopResponseSchema',
    'ServiceTokenDeleteResponseSchema',
    'SegmentsMutationResponseSchema',
    'JellyfinResyncResponseSchema',
    // src/lib/schemas/api-ai-responses.ts — routes migrated, old schemas not deleted
    'NewItemsScanResponseSchema',
    'EmbeddingPreviewResponseSchema',
    // src/lib/schemas/api-attention-responses.ts — pause endpoint migrated
    'TaskPauseResponseSchema',
    // src/lib/schemas/api-for-you-responses.ts — used only as base for SectionResponseSchema
    'PagedRecommendationResponseSchema',
    // src/lib/schemas/api-for-you-responses.ts — endpoint migrated, schema not deleted
    'UpcomingEpisodesResponseSchema',
    // src/lib/schemas/api-music-responses.ts — stations endpoint migrated
    'MusicTasteStationsResponseSchema',
    // src/lib/schemas/api-playback-responses.ts — superseded by PagedSessionsResponseSchema
    'SessionsResponseSchema',
    'StreamSessionCreateResponseSchema',
    'StreamSessionValidResponseSchema',
    'StreamSessionInvalidResponseSchema',
    'StreamSessionEndResponseSchema',
    'StreamSessionRefreshResponseSchema',
    // src/lib/schemas/api-sessions-responses.ts — sessions endpoint migrated
    'CurrentSessionsResponseSchema',
    // src/lib/schemas/api-user-responses.ts — device-action endpoints migrated
    // src/lib/schemas/livetv.ts — viewer-kicked endpoint migrated
    'ViewerKickedResponseSchema',
    // src/lib/schemas/pipeline-timeline.schema.ts — give-up endpoint migrated
    'PipelineGiveUpResponseSchema',
    // src/lib/schemas/playlists.ts — member-added endpoint migrated
    'memberAddedResponseSchema',
    // src/lib/schemas/task-definition.schema.ts — circuit-enable endpoint migrated
    'CircuitForceEnableResponseSchema',
]);

// Top-level scan — runs once per file load.
const allSchemas: SchemaExport[] = [];
for (const file of walkConsumable(SCHEMAS_DIR)) {
    if (file.endsWith('.test.ts')) continue;
    allSchemas.push(...collectSchemaExports(file));
}

// Sanity: an upper bound catches an accidental generator that emits names
// uncontrollably. A lower bound used to live here too but was removed — a
// future consolidation that legitimately drops the count below an arbitrary
// floor should not break the test file's load.
if (allSchemas.length > 10_000) {
    throw new Error(
        `Schema enumeration produced an unexpected count (${allSchemas.length}); ` +
            `the export-name regex is likely broken.`,
    );
}

// Build a single concatenated string of every src/ TS file, indexed by file
// path, so per-schema lookups are a fast `.includes` against each file blob.
// The orphan check is "schema referenced anywhere outside its declaring
// file" — not just `src/routes/api/`, because schemas are also consumed via
// `z.infer<>` re-exports under `src/lib/types/` and barrel files.
const fileBlobs: Array<{ path: string; text: string }> = [];
for (const file of walkConsumable(SRC_DIR)) {
    fileBlobs.push({ path: file, text: readFileSync(file, 'utf8') });
}
for (const file of walkConsumable(OPENAPI_ROUTES_DIR)) {
    fileBlobs.push({ path: file, text: readFileSync(file, 'utf8') });
}

describe('*ResponseSchema reference gate', () => {
    it('every exported *ResponseSchema is referenced by at least one other file in src/', () => {
        const orphans: Array<{ name: string; declaredIn: string }> = [];
        for (const schema of allSchemas) {
            // Skip schemas that are acknowledged pending-cleanup orphans from a
            // prior API migration (see PENDING_CLEANUP_ORPHANS above).
            if (PENDING_CLEANUP_ORPHANS.has(schema.name)) continue;

            // A schema is "consumed" if its export name OR any of its
            // `z.infer<>` type aliases is referenced from another file.
            // Word boundaries prevent `FooResponseSchema` from matching
            // `MyFooResponseSchema`.
            const needles = [schema.name, ...schema.aliasNames].map(
                (n) => new RegExp(`\\b${n}\\b`),
            );
            let found = false;
            for (const blob of fileBlobs) {
                if (blob.path === schema.file) continue;
                if (needles.some((re) => re.test(blob.text))) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                orphans.push({
                    name: schema.name,
                    declaredIn: schema.file.replace(REPO_ROOT + '/', ''),
                });
            }
        }

        // A failing run prints the full orphan list so the contributor can
        // immediately see which exports to delete (or import + use).
        expect(
            orphans,
            orphans.length > 0
                ? `Found ${orphans.length} unreferenced *ResponseSchema exports. ` +
                      `Either delete them or import + use them somewhere in src/.\n` +
                      orphans.map((o) => `  - ${o.name}  (${o.declaredIn})`).join('\n')
                : 'OK',
        ).toEqual([]);
    });

    // Stretch goal — every *ResponseSchema should be .parse()'d by at least
    // one route handler so the contract is runtime-enforced. Today most
    // schemas are consumed via z.infer<> for type extraction only; flipping
    // this to a hard assertion would surface ~350 grandfathered cases.
    // Track via .todo so the requirement stays visible without breaking CI.
    it.todo('every *ResponseSchema is .parse()/.safeParse()d by its owning route handler');
});
