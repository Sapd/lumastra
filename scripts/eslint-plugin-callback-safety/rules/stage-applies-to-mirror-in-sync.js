// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ESLint Rule: stage-applies-to-mirror-in-sync
 *
 * The metro-line UI in `src/lib/components/admin/coverage/ingest-map.constants.ts`
 * keeps a `STAGE_APPLIES_TO` map mirroring every task's `coversStages[].appliesTo`
 * because the metro renders in the browser and can't import server-only
 * registry code. This rule enforces that the mirror stays in sync with the
 * source-of-truth task declarations.
 *
 * What it checks:
 *   For every `coversStages: [...]` literal in
 *   `src/lib/server/tasks/builtin/native/*.ts`, extract each `{ id, appliesTo }`
 *   pair and verify the mirror at `ingest-map.constants.ts:STAGE_APPLIES_TO`
 *   contains the same `id → appliesTo[]` mapping.
 *
 * When it runs:
 *   On every lint of `ingest-map.constants.ts`. (The rule loads the task
 *   files on demand inside the lint pass — cheap because `coversStages`
 *   blocks are tiny and `glob` of the builtin/native dir is ~50 files.)
 *
 * To fix a lint failure:
 *   - Update `STAGE_APPLIES_TO` entry to match the task file, OR
 *   - Update the task file's `coversStages.appliesTo` to match the mirror
 *     (whichever is the source of truth for the change you're making).
 *
 * Drift class this prevents:
 *   2026-05-23 — library-embeddings.coversStages.appliesTo was narrowed
 *   from ['movie','series','episode'] → ['movie','series'] but the
 *   mirror still said ['movie','series','episode'], so episodes kept
 *   parking visually at the library-embeddings station even though
 *   the runtime correctly skipped them.
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse a TypeScript source file looking for `coversStages: [ { ... } ]`
 * literals and return a flat array of `{ stageId, appliesTo[] }`.
 *
 * Regex-based on purpose: this rule needs to run in the ESLint host process
 * which already has the parsed Program node for the file under lint; pulling
 * in a TS AST parser for the auxiliary files would be a meaningful perf
 * hit and bring transitive deps into the lint pipeline.
 *
 * The pattern is robust against the common shapes used in builtin/native:
 *   coversStages: [{ id: 'X', appliesTo: ['movie', 'episode'] as const, ... }],
 *   coversStages: [
 *       { id: 'X', appliesTo: ['movie'] as const, ... },
 *       { id: 'Y', appliesTo: ['episode'] as const },
 *   ],
 */
function extractCoversStagesFromSource(src) {
    const results = [];
    // Match each `{ id: '...', ..., appliesTo: [...] ... }` object.
    // The body matcher uses a lazy match plus the constraint that the
    // appliesTo array doesn't contain `]` itself.
    const objRe = /\{\s*id:\s*['"]([a-z0-9-]+)['"][^}]*?appliesTo:\s*\[([^\]]*)\]/g;
    let m;
    while ((m = objRe.exec(src)) !== null) {
        const stageId = m[1];
        const arrayBody = m[2];
        const appliesTo = [...arrayBody.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((im) => im[1]);
        results.push({ stageId, appliesTo });
    }
    return results;
}

/**
 * Extract `(stageId, resourceClass)` pairs from the source. A task
 * declaration looks like
 *   defineTask({
 *       id: 'chapter-sync',
 *       ...
 *       resourceClass: 'ingest',
 *       coversStages: [{ id: 'chapter-sync', appliesTo: [...] }],
 *   })
 * The resourceClass field is at task-level; every coversStages entry
 * inside that task inherits it for the purpose of the mirror map.
 *
 * Implementation: scan the source for `resourceClass: '<X>'` and the
 * nearest preceding coversStages-id literal. Regex-based to stay
 * dependency-free and consistent with the appliesTo extractor above.
 */
function extractResourceClassesFromSource(src) {
    const results = [];
    // For each task, the natural anchor is `resourceClass: '<cls>'`.
    // Within the same defineTask({...}) block, every coversStages id
    // shares that class. We grab the resourceClass once, then find
    // every `id: '<stageId>'` inside the corresponding coversStages
    // array (which is itself an array of objects with their own `id`).
    //
    // Heuristic: take each task's resourceClass + look forward at the
    // SAME task's coversStages array. Builtin tasks all keep these
    // adjacent; the regex below matches that shape and would miss any
    // exotic layout that interleaves them, which is fine — the lint
    // would just fail to suggest a fix for that file and the developer
    // would fix the mirror manually.
    const taskRe =
        /resourceClass:\s*['"]([a-z]+)['"][\s\S]{0,4000}?coversStages:\s*\[([\s\S]*?)\]\s*,/g;
    let m;
    while ((m = taskRe.exec(src)) !== null) {
        const resourceClass = m[1];
        const coversStagesBody = m[2];
        // Each `{ id: '...', ... }` inside coversStagesBody is one stage.
        const stageIds = [...coversStagesBody.matchAll(/\bid:\s*['"]([a-z0-9-]+)['"]/g)].map(
            (sm) => sm[1],
        );
        for (const stageId of stageIds) {
            results.push({ stageId, resourceClass });
        }
    }
    return results;
}

function listTaskFiles(constantsFilePath) {
    const tasksDir = path.resolve(
        path.dirname(constantsFilePath),
        '../../../server/tasks/builtin/native',
    );
    if (!fs.existsSync(tasksDir)) return [];
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (
                entry.isFile() &&
                /\.ts$/.test(entry.name) &&
                !/\.test\.ts$/.test(entry.name)
            ) {
                out.push(full);
            }
        }
    };
    walk(tasksDir);
    return out;
}

function loadTaskSourceApplicability(constantsFilePath) {
    const files = listTaskFiles(constantsFilePath);
    const map = new Map();
    for (const f of files) {
        let src;
        try {
            src = fs.readFileSync(f, 'utf8');
        } catch {
            continue;
        }
        for (const { stageId, appliesTo } of extractCoversStagesFromSource(src)) {
            // If two task files define the same stageId, the registry would
            // reject at runtime. Keep the first occurrence here; if the second
            // disagrees, the registry's own boot-time check is the canonical
            // error path.
            if (!map.has(stageId)) {
                map.set(stageId, { appliesTo, sourceFile: f });
            }
        }
    }
    return map;
}

function loadTaskSourceResourceClasses(constantsFilePath) {
    const files = listTaskFiles(constantsFilePath);
    const map = new Map();
    for (const f of files) {
        let src;
        try {
            src = fs.readFileSync(f, 'utf8');
        } catch {
            continue;
        }
        for (const { stageId, resourceClass } of extractResourceClassesFromSource(src)) {
            if (!map.has(stageId)) {
                map.set(stageId, { resourceClass, sourceFile: f });
            }
        }
    }
    return map;
}

function extractMirrorFromNode(stageAppliesProperty, _sourceCode) {
    const map = new Map();
    if (stageAppliesProperty.value.type !== 'ObjectExpression') return map;
    for (const prop of stageAppliesProperty.value.properties) {
        if (prop.type !== 'Property') continue;
        const key =
            prop.key.type === 'Literal'
                ? prop.key.value
                : prop.key.type === 'Identifier'
                  ? prop.key.name
                  : null;
        if (typeof key !== 'string') continue;
        if (prop.value.type !== 'ArrayExpression') continue;
        const types = prop.value.elements
            .map((el) =>
                el && el.type === 'Literal' && typeof el.value === 'string' ? el.value : null,
            )
            .filter((v) => v !== null);
        map.set(key, { types, node: prop });
    }
    return map;
}

/**
 * Extract a Record<string, string> mirror from a `VariableDeclarator` whose
 * init is an `ObjectExpression` of `key: 'literal'` pairs. Used for the
 * STAGE_RESOURCE_CLASS map (string-valued) — STAGE_APPLIES_TO uses arrays
 * and has its own extractor above.
 */
function extractStringMapFromNode(node) {
    const map = new Map();
    if (!node.init || node.init.type !== 'ObjectExpression') return map;
    for (const prop of node.init.properties) {
        if (prop.type !== 'Property') continue;
        const key =
            prop.key.type === 'Literal'
                ? prop.key.value
                : prop.key.type === 'Identifier'
                  ? prop.key.name
                  : null;
        if (typeof key !== 'string') continue;
        if (prop.value.type !== 'Literal' || typeof prop.value.value !== 'string') continue;
        map.set(key, { value: prop.value.value, node: prop });
    }
    return map;
}

module.exports = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require STAGE_APPLIES_TO and STAGE_RESOURCE_CLASS mirrors in ingest-map.constants.ts to match the task declarations in src/lib/server/tasks/builtin/native/*.ts',
            category: 'Best Practices',
            recommended: true,
        },
        schema: [],
        messages: {
            missingEntry:
                "Stage '{{stageId}}' is declared in task file '{{sourceFile}}' with appliesTo {{taskAppliesTo}} but has no entry in STAGE_APPLIES_TO. Add it to ingest-map.constants.ts.",
            mismatch:
                "STAGE_APPLIES_TO['{{stageId}}'] = {{mirrorAppliesTo}} but the task file '{{sourceFile}}' declares appliesTo = {{taskAppliesTo}}. Pick one and update the other.",
            missingResourceClass:
                "Stage '{{stageId}}' is declared in task file '{{sourceFile}}' with resourceClass '{{taskClass}}' but has no entry in STAGE_RESOURCE_CLASS. Add it to ingest-map.constants.ts.",
            mismatchResourceClass:
                "STAGE_RESOURCE_CLASS['{{stageId}}'] = '{{mirrorClass}}' but the task file '{{sourceFile}}' declares resourceClass = '{{taskClass}}'. Pick one and update the other.",
        },
    },
    create(context) {
        const filename = context.filename ?? context.getFilename?.() ?? '';
        if (!filename.endsWith('ingest-map.constants.ts')) return {};

        const taskApplicability = loadTaskSourceApplicability(filename);
        const taskResourceClasses = loadTaskSourceResourceClasses(filename);
        if (taskApplicability.size === 0 && taskResourceClasses.size === 0) return {};

        return {
            VariableDeclarator(node) {
                if (!node.id || node.id.type !== 'Identifier') return;

                if (node.id.name === 'STAGE_APPLIES_TO') {
                    if (!node.init || node.init.type !== 'ObjectExpression') return;

                    const wrap = { value: node.init };
                    const mirror = extractMirrorFromNode(wrap, context.sourceCode);

                    for (const [stageId, { appliesTo, sourceFile }] of taskApplicability) {
                        const mirrorEntry = mirror.get(stageId);
                        if (!mirrorEntry) {
                            context.report({
                                node: node.init,
                                messageId: 'missingEntry',
                                data: {
                                    stageId,
                                    sourceFile: path.relative(path.dirname(filename), sourceFile),
                                    taskAppliesTo: JSON.stringify(appliesTo),
                                },
                            });
                            continue;
                        }
                        const same =
                            mirrorEntry.types.length === appliesTo.length &&
                            mirrorEntry.types.every((t) => appliesTo.includes(t)) &&
                            appliesTo.every((t) => mirrorEntry.types.includes(t));
                        if (!same) {
                            context.report({
                                node: mirrorEntry.node,
                                messageId: 'mismatch',
                                data: {
                                    stageId,
                                    mirrorAppliesTo: JSON.stringify(mirrorEntry.types),
                                    sourceFile: path.relative(path.dirname(filename), sourceFile),
                                    taskAppliesTo: JSON.stringify(appliesTo),
                                },
                            });
                        }
                    }
                    return;
                }

                if (node.id.name === 'STAGE_RESOURCE_CLASS') {
                    const mirror = extractStringMapFromNode(node);

                    for (const [stageId, { resourceClass, sourceFile }] of taskResourceClasses) {
                        const mirrorEntry = mirror.get(stageId);
                        if (!mirrorEntry) {
                            context.report({
                                node: node.init,
                                messageId: 'missingResourceClass',
                                data: {
                                    stageId,
                                    sourceFile: path.relative(path.dirname(filename), sourceFile),
                                    taskClass: resourceClass,
                                },
                            });
                            continue;
                        }
                        if (mirrorEntry.value !== resourceClass) {
                            context.report({
                                node: mirrorEntry.node,
                                messageId: 'mismatchResourceClass',
                                data: {
                                    stageId,
                                    mirrorClass: mirrorEntry.value,
                                    sourceFile: path.relative(path.dirname(filename), sourceFile),
                                    taskClass: resourceClass,
                                },
                            });
                        }
                    }
                }
            },
        };
    },
};
