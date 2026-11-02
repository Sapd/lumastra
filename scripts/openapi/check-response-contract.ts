// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// MUST be first: installs the ESM hooks that neutralise `?raw` asset imports
// (the task system's `.lua` Valkey scripts) and the `$app/*` + `$env/*` virtual
// modules, plus the Svelte rune globals. Without it, importing a def to read its
// `docs` fails for ~80% of routes — which is how this checker silently decayed
// to 4/306 while still reporting success. Same bootstrap generate.ts uses.
import './register-loader.mjs';

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, relative, dirname, join } from 'node:path';
import * as ts from 'typescript';
import { z } from 'zod';
import type { RouteMetadata } from '../../src/lib/server/openapi';

const ROOT = resolve(import.meta.dirname, '../..');
const PUBLIC_API_DIR = resolve(ROOT, 'src/routes/api/v1');

interface JsonCallSite {
    line: number;
    keys: Set<string>;
    hasSpread: boolean;
    isLiteral: boolean;
}

interface EndpointAnalysis {
    filePath: string;
    openApiPath: string;
    method: string;
    status: number;
    schemaKeys: Set<string>;
    callSites: JsonCallSite[];
    issues: string[];
}

// ---------------------------------------------------------------------------
// Response media-type vocabulary
// ---------------------------------------------------------------------------

/**
 * Tokens that must never appear in a RESPONSE schema's media-type enum.
 *
 * The DB stores `tv` — it mirrors TMDB's namespace and the external_ids
 * composite key — but every public surface emits `series`. REQUESTS may still
 * accept `tv`; that leniency is deliberate, which is why this only ever looks
 * at 2xx response schemas and never at bodies or parameters.
 */
const FORBIDDEN_RESPONSE_TOKENS = new Set(['tv', 'show']);

/**
 * An enum containing `tv` is only a media-type discriminator if it also carries
 * one of these. Without the marker test the device form-factor enums
 * (`tv | mobile | web | unknown`) would trip — there `tv` is a television
 * client, not a media type.
 */
const MEDIA_ENUM_MARKERS = new Set(['movie', 'episode', 'season', 'series']);

/**
 * Adjudicated exceptions — enums that legitimately carry `tv` in a response.
 *
 * Keep this SHORT and each entry reasoned. An exemption is a DOCUMENTED gap
 * rather than a silent one, which is the whole distinction this file exists to
 * maintain.
 */
const VOCABULARY_EXEMPTIONS: { match: string; reason: string }[] = [
    {
        match: 'LibraryPath',
        reason:
            'library content-KIND vocabulary (anime, home_video, training, educational) — ' +
            'describes what a library folder holds, not a per-item media discriminator',
    },
];

/** Collect every enum in a JSON-Schema tree, tagged with its property path. */
function collectEnums(
    node: unknown,
    path: string,
    out: { path: string; values: string[] }[],
    seen = new Set<unknown>(),
): void {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
        node.forEach((n, i) => collectEnums(n, `${path}[${i}]`, out, seen));
        return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.enum)) {
        out.push({
            path: path || '(root)',
            values: obj.enum.filter((v): v is string => typeof v === 'string'),
        });
    }
    for (const [k, v] of Object.entries(obj)) {
        if (k === 'enum') continue;
        collectEnums(v, path ? `${path}.${k}` : k, out, seen);
    }
}

/**
 * Scan a documented 2xx response schema for internal media-type tokens.
 *
 * Operates on the JSON-Schema projection rather than the handler source, so —
 * unlike the `json()` call-site key check — it sees bodies built via `.map(...)`,
 * spreads, helper functions and transitive refs. That blindness is exactly how
 * `tv` reached four separate v1 responses without any gate noticing.
 */
function findVocabularyViolations(schema: z.ZodType): string[] {
    let jsonSchema: unknown;
    try {
        jsonSchema = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
    } catch {
        return []; // unrepresentable — the key check below still applies
    }

    const enums: { path: string; values: string[] }[] = [];
    collectEnums(jsonSchema, '', enums);

    const violations: string[] = [];
    for (const { path, values } of enums) {
        const bad = values.filter((v) => FORBIDDEN_RESPONSE_TOKENS.has(v));
        if (bad.length === 0) continue;
        if (!values.some((v) => MEDIA_ENUM_MARKERS.has(v))) continue; // device enum
        if (VOCABULARY_EXEMPTIONS.some((e) => path.includes(e.match))) continue;

        violations.push(
            `Response schema admits internal token(s) ${bad.map((b) => `\`${b}\``).join(', ')} at ` +
                `${path} — enum [${values.join(', ')}]. Public responses emit \`series\`; ` +
                `keep \`tv\` on the request schema only.`,
        );
    }
    return violations;
}

function filePathToOpenApiPath(filePath: string): string {
    const rel = relative(resolve(ROOT, 'src/routes'), filePath);
    const dir = dirname(rel);
    const segments = dir.split('/').map((seg) => {
        if (seg.startsWith('[...') && seg.endsWith(']')) {
            return `{${seg.slice(4, -1)}}`;
        }
        if (seg.startsWith('[') && seg.endsWith(']')) {
            return `{${seg.slice(1, -1)}}`;
        }
        return seg;
    });
    return '/' + segments.join('/');
}

function resolveAliasPath(importPath: string, fromDir: string): string {
    if (importPath.startsWith('$lib/')) {
        return resolve(ROOT, 'src/lib', importPath.slice(5));
    }
    return resolve(fromDir, importPath);
}

function extractSchemaKeys(schema: z.ZodType | undefined): Set<string> | null {
    if (!schema) return null;

    let current = schema;

    while (current) {
        if (current instanceof z.ZodObject) {
            return new Set(Object.keys(current.shape));
        }
        if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
            current = current._def.innerType;
            continue;
        }
        if (current instanceof z.ZodDefault) {
            current = current._def.innerType;
            continue;
        }
        break;
    }

    return null;
}

const HTTP_METHOD_NAMES = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

function collectJsonCallSitesInNode(node: ts.Node, sourceFile: ts.SourceFile): JsonCallSite[] {
    const callSites: JsonCallSite[] = [];

    function visit(n: ts.Node) {
        if (
            ts.isCallExpression(n) &&
            ts.isIdentifier(n.expression) &&
            n.expression.text === 'json' &&
            n.arguments.length > 0
        ) {
            const firstArg = n.arguments[0];
            const line = sourceFile.getLineAndCharacterOfPosition(firstArg.getStart()).line + 1;
            const callSite: JsonCallSite = {
                line,
                keys: new Set(),
                hasSpread: false,
                isLiteral: false,
            };

            if (ts.isObjectLiteralExpression(firstArg)) {
                callSite.isLiteral = true;
                for (const prop of firstArg.properties) {
                    if (ts.isSpreadAssignment(prop)) {
                        callSite.hasSpread = true;
                    } else if (
                        ts.isPropertyAssignment(prop) &&
                        (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
                    ) {
                        callSite.keys.add(prop.name.text);
                    } else if (
                        ts.isShorthandPropertyAssignment(prop) &&
                        ts.isIdentifier(prop.name)
                    ) {
                        callSite.keys.add(prop.name.text);
                    }
                }
            }

            callSites.push(callSite);
        }
        ts.forEachChild(n, visit);
    }

    visit(node);
    return callSites;
}

/**
 * A def file's `handlers: { GET: async (...) => {...}, POST: ... }` object
 * holds one function per HTTP method with an unrelated response shape each —
 * scanning the whole file for `json()` calls (as opposed to just the node for
 * the method under test) cross-contaminates results between methods. Worse,
 * a handful of def files declare MULTIPLE `defineEndpoint()`s (e.g.
 * `notifications/index.ts` exports `def`, `unreadCountDef`, `readAllDef` —
 * three unrelated endpoints in one file), so this must further scope to the
 * specific `export const <exportName> = defineEndpoint({...})` the route
 * under test actually imports, not just any `handlers:` block in the file.
 */
function findJsonCallSitesByMethod(
    fileSource: string,
    exportName: string,
): Map<string, JsonCallSite[]> {
    const sourceFile = ts.createSourceFile('handler.ts', fileSource, ts.ScriptTarget.Latest, true);
    const byMethod = new Map<string, JsonCallSite[]>();

    let target: ts.Node | undefined;
    function findTarget(node: ts.Node) {
        if (target) return;
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === exportName &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === 'defineEndpoint'
        ) {
            target = node.initializer;
            return;
        }
        ts.forEachChild(node, findTarget);
    }
    findTarget(sourceFile);
    if (!target) return byMethod;

    function visit(node: ts.Node) {
        if (
            ts.isPropertyAssignment(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'handlers' &&
            ts.isObjectLiteralExpression(node.initializer)
        ) {
            for (const prop of node.initializer.properties) {
                if (
                    ts.isPropertyAssignment(prop) &&
                    ts.isIdentifier(prop.name) &&
                    HTTP_METHOD_NAMES.has(prop.name.text)
                ) {
                    const existing = byMethod.get(prop.name.text) ?? [];
                    byMethod.set(
                        prop.name.text,
                        existing.concat(collectJsonCallSitesInNode(prop.initializer, sourceFile)),
                    );
                }
            }
            return; // don't descend further — handlers object fully consumed
        }
        ts.forEachChild(node, visit);
    }

    visit(target);
    return byMethod;
}

function resolveModulePath(importPath: string, fromDir: string): string {
    let path = resolveAliasPath(importPath, fromDir);
    if (path.endsWith('.js')) path = path.slice(0, -3) + '.ts';
    if (!path.endsWith('.ts')) {
        if (existsSync(path + '.ts')) path += '.ts';
        else path = resolve(path, '+server.ts');
    }
    return path;
}

interface ResolvedDef {
    file: string;
    exportName: string;
}

/**
 * `+server.ts` under v1 is (almost) always a thin `mount(def, {...})` wrapper —
 * the real `json()` calls live in the imported def file, never in `+server.ts`
 * itself. Some v1 routes are themselves just `export * from '<legacy +server.ts>'`
 * aliases one or more hops away from the file that actually imports a def
 * (e.g. `browse/libraries` → legacy `api/browse/libraries/+server.ts` →
 * `defs/browse/libraries.ts`), so this resolves recursively. The imported
 * binding isn't always literally named `def` (e.g. `notifications/unread-count`
 * imports `unreadCountDef`) — capture the actual export name so the caller can
 * scope to that one `defineEndpoint()` and not sibling ones in the same file.
 */
function resolveDefFiles(serverFilePath: string, visited = new Set<string>()): ResolvedDef[] {
    if (visited.has(serverFilePath) || !existsSync(serverFilePath)) return [];
    visited.add(serverFilePath);

    const source = readFileSync(serverFilePath, 'utf-8');
    const fromDir = dirname(serverFilePath);

    // Only imports from a defs/ module count as "the def" — this also matches
    // `import { mount } from '$lib/server/api/mount.js'` style lines, which the
    // `/defs/` path check below filters back out.
    const IMPORT_PATTERN =
        /import\s*\{\s*([A-Za-z0-9_]+)(?:\s+as\s+[A-Za-z0-9_]+)?\s*\}\s*from\s*['"]([^'"]+)['"]/g;
    const direct: ResolvedDef[] = [];
    for (const match of source.matchAll(IMPORT_PATTERN)) {
        const [, exportName, importPath] = match;
        if (!importPath.includes('/defs/')) continue;
        const path = resolveModulePath(importPath, fromDir);
        if (existsSync(path)) direct.push({ file: path, exportName });
    }
    if (direct.length > 0) return direct;

    // No local defs/ import — this file only re-exports another module
    // (`export * from '...'` or `export { GET, ... } from '...'`). Recurse
    // into every distinct re-export target until a defs/-importing file
    // (or a dead end) is found.
    const REEXPORT_PATTERNS = [
        /export\s*\*\s*from\s*['"]([^'"]+)['"]/g,
        /export\s*\{[^}]*\}\s*from\s*['"]([^'"]+)['"]/g,
    ];
    const targets = new Set<string>();
    for (const pattern of REEXPORT_PATTERNS) {
        for (const match of source.matchAll(pattern)) targets.add(match[1]);
    }

    const resolved: ResolvedDef[] = [];
    for (const importPath of targets) {
        const path = resolveModulePath(importPath, fromDir);
        if (!existsSync(path)) continue;
        resolved.push(...resolveDefFiles(path, visited));
    }
    return resolved;
}

async function analyzeEndpoint(
    serverFilePath: string,
    openapiFilePath: string | null,
    skipReasons: Map<string, number>,
): Promise<EndpointAnalysis[]> {
    const results: EndpointAnalysis[] = [];

    const defFiles = resolveDefFiles(serverFilePath);

    if (defFiles.length === 0) {
        skipReasons.set(
            'no `def` import found (legacy hand-written RequestHandler route, out of scope)',
            (skipReasons.get(
                'no `def` import found (legacy hand-written RequestHandler route, out of scope)',
            ) || 0) + 1,
        );
        return results;
    }

    // Docs source: a colocated `_openapi.ts` when one exists, otherwise the def's
    // own `docs` block. `_openapi.ts` was retired for def-mounted routes
    // (e9cae8c77) and its contents moved into `def.docs`, but this checker still
    // demanded the old file — so its coverage silently collapsed to 4 of 306
    // routes while it kept printing "No contract violations found". Reading
    // `def.docs` is what restores the reach.
    let routeMeta: RouteMetadata | undefined;

    if (openapiFilePath) {
        try {
            const mod = await import(openapiFilePath);
            routeMeta = mod.route as RouteMetadata | undefined;
        } catch {
            skipReasons.set(
                '_openapi.ts import failed',
                (skipReasons.get('_openapi.ts import failed') || 0) + 1,
            );
            return results;
        }
    } else {
        for (const { file, exportName } of defFiles) {
            try {
                const mod = (await import(file)) as Record<string, { docs?: RouteMetadata }>;
                const docs = mod[exportName]?.docs;
                if (docs) routeMeta = { ...(routeMeta ?? {}), ...docs };
            } catch (err) {
                if (process.env.DEBUG_CONTRACT) {
                    console.error('[def import failed]', file, String(err).slice(0, 160));
                }
                skipReasons.set(
                    'def import failed',
                    (skipReasons.get('def import failed') || 0) + 1,
                );
                return results;
            }
        }
    }

    if (!routeMeta) {
        skipReasons.set(
            'no documented responses (no _openapi.ts `route`, no def.docs)',
            (skipReasons.get('no documented responses (no _openapi.ts `route`, no def.docs)') ||
                0) + 1,
        );
        return results;
    }

    // Merge per-method call sites across all resolved defs (only the rare
    // 2-def files produce more than one), then keep literal/non-spread only.
    const callSitesByMethod = new Map<string, JsonCallSite[]>();
    for (const { file, exportName } of defFiles) {
        const fileMap = findJsonCallSitesByMethod(readFileSync(file, 'utf-8'), exportName);
        for (const [method, sites] of fileMap) {
            callSitesByMethod.set(method, (callSitesByMethod.get(method) ?? []).concat(sites));
        }
    }

    // No early-return on "endpoint has no literal json() call site" any more:
    // that gate skipped the whole endpoint and took the schema-level vocabulary
    // check down with it — and a `.map()`-built body (no literal call site) is
    // precisely the shape that leaked `tv`. The KEY check still needs literal
    // call sites; the VOCABULARY check does not.
    const openApiPath = filePathToOpenApiPath(serverFilePath);
    const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
    let anyMethodChecked = false;

    for (const httpMethod of HTTP_METHODS) {
        const methodMeta = routeMeta[httpMethod];
        if (!methodMeta) continue;

        const literalCallSites = (callSitesByMethod.get(httpMethod) ?? []).filter(
            (cs) => cs.isLiteral && !cs.hasSpread,
        );

        for (const [statusStr, responseDef] of Object.entries(methodMeta.responses)) {
            const status = Number(statusStr);
            if (!Number.isInteger(status) || status < 200 || status >= 300) continue;

            const schema =
                typeof responseDef === 'string' ? undefined : responseDef.schema || undefined;

            if (!schema) continue;
            const schemaKeys = extractSchemaKeys(schema);

            anyMethodChecked = true;
            const analysis: EndpointAnalysis = {
                filePath: relative(ROOT, serverFilePath),
                openApiPath,
                method: httpMethod,
                status,
                schemaKeys: schemaKeys ?? new Set<string>(),
                callSites: literalCallSites,
                issues: [],
            };

            // (a) KEY check — object schemas built at a literal, non-spread
            //     json() call site.
            if (schemaKeys) {
                for (const callSite of analysis.callSites) {
                    const extraKeys = Array.from(callSite.keys).filter((k) => !schemaKeys.has(k));
                    if (extraKeys.length > 0) {
                        analysis.issues.push(
                            `Line ${callSite.line}: extra key(s) not in schema: ${extraKeys.join(', ')}`,
                        );
                    }
                }
            }

            // (b) VOCABULARY check — schema-level, so it covers every method and
            //     every body shape however the handler builds it.
            analysis.issues.push(...findVocabularyViolations(schema));

            results.push(analysis);
        }
    }

    if (!anyMethodChecked) {
        skipReasons.set(
            'no 2xx object-schema response declared',
            (skipReasons.get('no 2xx object-schema response declared') || 0) + 1,
        );
    }

    return results;
}

async function main() {
    const entries = readdirSync(PUBLIC_API_DIR, {
        withFileTypes: true,
        recursive: true,
    });

    const serverFiles = entries
        .filter((e) => e.name === '+server.ts')
        .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))
        .sort();

    const skipReasons = new Map<string, number>();
    const allAnalyses: EndpointAnalysis[] = [];

    for (const serverFilePath of serverFiles) {
        const handlerDir = dirname(serverFilePath);
        // A missing `_openapi.ts` is the NORM now, not a skip reason — those docs
        // live in `def.docs`. null tells analyzeEndpoint to read them there.
        const colocated = join(handlerDir, '_openapi.ts');
        const openapiFilePath = existsSync(colocated) ? colocated : null;

        try {
            const analyses = await analyzeEndpoint(serverFilePath, openapiFilePath, skipReasons);
            allAnalyses.push(...analyses);
        } catch {
            skipReasons.set('import/parse error', (skipReasons.get('import/parse error') || 0) + 1);
        }
    }

    const checkedFiles = new Set<string>();
    let confirmedCount = 0;

    for (const analysis of allAnalyses) {
        checkedFiles.add(analysis.filePath);

        for (const issue of analysis.issues) {
            console.error(
                `\n❌ ${analysis.filePath}`,
                `\n   ${analysis.method} ${analysis.openApiPath} [${analysis.status}]`,
                `\n   ${issue}`,
            );
            confirmedCount++;
        }
    }

    const skippedTotal = Array.from(skipReasons.values()).reduce((a, b) => a + b, 0);

    console.log(`\n${'-'.repeat(80)}`);
    console.log(
        `Checked ${checkedFiles.size}/${serverFiles.length} route files against their response schemas (${skippedTotal} skipped)`,
    );

    if (skipReasons.size > 0) {
        console.log('\nSkipped breakdown:');
        for (const [reason, count] of skipReasons) {
            console.log(`  ${count} — ${reason}`);
        }
    }

    if (confirmedCount === 0) {
        console.log(`\n✓ No contract violations found`);
        process.exit(0);
    } else {
        console.log(
            `\n❌ Found ${confirmedCount} contract violation(s) across ${allAnalyses.filter((a) => a.issues.length > 0).length} endpoint(s)`,
        );
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
