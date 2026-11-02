#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OpenAPI Spec Verification Script
 *
 * Compares the generated openapi.yaml response schemas against actual
 * SvelteKit handler json() return shapes, reporting mismatches.
 *
 * Run: npm run openapi:verify
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ============================================================================
// Types
// ============================================================================

interface SpecRoute {
    path: string;
    method: string;
    specFields: Set<string>;
    successStatus: number;
    isArray: boolean;
}

interface HandlerResult {
    filePath: string;
    resolvedPath: string;
    jsonCalls: JsonCallInfo[];
}

interface JsonCallInfo {
    line: number;
    fields: Set<string>;
    kind: 'object' | 'indirect' | 'no-content' | 'spread';
    raw: string;
}

type VerifyResult =
    | { status: 'match'; route: SpecRoute; handler: HandlerResult }
    | {
          status: 'mismatch';
          route: SpecRoute;
          handler: HandlerResult;
          extraInSpec: string[];
          missingFromSpec: string[];
      }
    | {
          status: 'indirect';
          route: SpecRoute;
          handler: HandlerResult;
          jsonCalls: JsonCallInfo[];
      }
    | { status: 'no-handler'; route: SpecRoute }
    | { status: 'binary'; route: SpecRoute; note: string }
    | { status: 'no-content'; route: SpecRoute; handler: HandlerResult };

// JS keywords/literals that should never be treated as field names
const JS_KEYWORDS = new Set([
    'true',
    'false',
    'null',
    'undefined',
    'new',
    'return',
    'const',
    'let',
    'var',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'function',
    'async',
    'await',
    'try',
    'catch',
    'finally',
    'throw',
    'typeof',
    'instanceof',
    'void',
    'delete',
    'in',
    'of',
    'this',
    'super',
    'class',
    'extends',
    'import',
    'export',
    'default',
    'from',
    'as',
    'yield',
    'satisfies',
    'type',
    'interface',
]);

// ============================================================================
// Step 1: Parse OpenAPI YAML
// ============================================================================

function loadSpecRoutes(yamlPath: string): SpecRoute[] {
    const content = readFileSync(yamlPath, 'utf-8');
    const doc = parseYaml(content, { maxAliasCount: 10000 }) as Record<string, unknown>;
    const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
    if (!paths) return [];

    const routes: SpecRoute[] = [];
    const methods = ['get', 'post', 'put', 'delete', 'patch'] as const;

    for (const [path, pathItem] of Object.entries(paths)) {
        for (const method of methods) {
            const operation = pathItem[method] as Record<string, unknown> | undefined;
            if (!operation) continue;

            const responses = operation.responses as Record<string, unknown> | undefined;
            if (!responses) continue;

            // Find success response (200, 201)
            let successStatus = 200;
            let successResponse: Record<string, unknown> | undefined;
            for (const code of ['200', '201']) {
                if (responses[code]) {
                    successStatus = parseInt(code, 10);
                    successResponse = responses[code] as Record<string, unknown>;
                    break;
                }
            }

            // 204 no-content
            if (!successResponse && responses['204']) {
                routes.push({
                    path,
                    method: method.toUpperCase(),
                    specFields: new Set(),
                    successStatus: 204,
                    isArray: false,
                });
                continue;
            }

            if (!successResponse) continue;

            const respContent = successResponse.content as Record<string, unknown> | undefined;
            if (!respContent) {
                routes.push({
                    path,
                    method: method.toUpperCase(),
                    specFields: new Set(),
                    successStatus,
                    isArray: false,
                });
                continue;
            }

            const jsonContent = respContent['application/json'] as
                Record<string, unknown> | undefined;
            if (!jsonContent) {
                routes.push({
                    path,
                    method: method.toUpperCase(),
                    specFields: new Set(),
                    successStatus,
                    isArray: false,
                });
                continue;
            }

            const schema = jsonContent.schema as Record<string, unknown> | undefined;
            if (!schema) continue;

            const { fields, isArray } = extractFieldsFromSchema(schema);

            routes.push({
                path,
                method: method.toUpperCase(),
                specFields: fields,
                successStatus,
                isArray,
            });
        }
    }

    return routes;
}

function extractFieldsFromSchema(schema: Record<string, unknown>): {
    fields: Set<string>;
    isArray: boolean;
} {
    const type = schema.type as string | undefined;

    if (type === 'array') {
        const items = schema.items as Record<string, unknown> | undefined;
        if (items?.properties) {
            return {
                fields: new Set(Object.keys(items.properties as Record<string, unknown>)),
                isArray: true,
            };
        }
        return { fields: new Set(), isArray: true };
    }

    if (schema.properties) {
        return {
            fields: new Set(Object.keys(schema.properties as Record<string, unknown>)),
            isArray: false,
        };
    }

    for (const combiner of ['allOf', 'oneOf', 'anyOf']) {
        const combined = schema[combiner] as Record<string, unknown>[] | undefined;
        if (combined) {
            const merged = new Set<string>();
            for (const sub of combined) {
                if (sub.properties) {
                    for (const key of Object.keys(sub.properties as Record<string, unknown>)) {
                        merged.add(key);
                    }
                }
            }
            if (merged.size > 0) return { fields: merged, isArray: false };
        }
    }

    return { fields: new Set(), isArray: false };
}

// ============================================================================
// Step 2: Map Paths to Handler Files
// ============================================================================

function specPathToHandlerFile(specPath: string, method: string): HandlerResult | null {
    const svelteKitPath = specPath.replace(/\{([^}]+)\}/g, '[$1]');

    const candidates: string[] = [];

    // Also try [...param] (SvelteKit catch-all) for routes like /jellyfin/{path}
    const catchAllPath = specPath.replace(/\{([^}]+)\}/g, '[...$1]');

    if (svelteKitPath.startsWith('/api/v1/')) {
        const subpath = svelteKitPath.slice('/api/v1/'.length);
        const catchAllSubpath = catchAllPath.slice('/api/v1/'.length);
        candidates.push(`src/routes/api/v1/${subpath}/+server.ts`);
        candidates.push(`src/routes/api/${subpath}/+server.ts`);
        // Try catch-all variants
        if (catchAllSubpath !== subpath) {
            candidates.push(`src/routes/api/v1/${catchAllSubpath}/+server.ts`);
            candidates.push(`src/routes/api/${catchAllSubpath}/+server.ts`);
        }
    } else if (svelteKitPath.startsWith('/oauth/')) {
        const subpath = svelteKitPath.slice('/oauth/'.length);
        candidates.push(`src/routes/oauth/${subpath}/+server.ts`);
    } else {
        candidates.push(`src/routes${svelteKitPath}/+server.ts`);
    }

    for (const candidate of candidates) {
        const fullPath = resolve(ROOT, candidate);
        if (!existsSync(fullPath)) continue;

        const content = readFileSync(fullPath, 'utf-8');

        // Check for re-export
        const resolved = resolveReExport(content, fullPath, method);
        if (resolved) {
            const resolvedContent = readFileSync(resolved, 'utf-8');
            return {
                filePath: candidate,
                resolvedPath: relative(ROOT, resolved),
                jsonCalls: extractJsonCallsForMethod(resolvedContent, method),
            };
        }

        // Check for delegation pattern (import { GET as internalGet })
        const delegated = resolveDelegation(content, fullPath, method);
        if (delegated) {
            const delegatedContent = readFileSync(delegated, 'utf-8');
            return {
                filePath: candidate,
                resolvedPath: relative(ROOT, delegated),
                jsonCalls: extractJsonCallsForMethod(delegatedContent, method),
            };
        }

        // This file IS the handler
        return {
            filePath: candidate,
            resolvedPath: candidate,
            jsonCalls: extractJsonCallsForMethod(content, method),
        };
    }

    return null;
}

function resolveReExport(content: string, filePath: string, method: string): string | null {
    const pattern = new RegExp(
        `export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
    );
    const match = content.match(pattern);
    if (match) return resolveImportPath(filePath, match[1]);
    return null;
}

function resolveDelegation(content: string, filePath: string, method: string): string | null {
    const importPattern = new RegExp(
        `import\\s*\\{[^}]*\\b${method}\\s+as\\s+\\w+[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
    );
    const match = content.match(importPattern);
    if (match) return resolveImportPath(filePath, match[1]);
    return null;
}

function resolveImportPath(fromFile: string, importSpecifier: string): string | null {
    const dir = dirname(fromFile);
    let resolved = importSpecifier;
    if (resolved.endsWith('.js')) {
        resolved = resolved.slice(0, -3) + '.ts';
    }
    const fullPath = resolve(dir, resolved);
    if (existsSync(fullPath)) return fullPath;

    const original = resolve(dir, importSpecifier);
    if (existsSync(original)) return original;

    return null;
}

// ============================================================================
// Step 3: Extract json() Fields from Handlers (Method-Scoped)
// ============================================================================

/**
 * Finds the range of lines belonging to a specific method handler
 * (e.g., `export const GET`) and extracts json() calls from that range only.
 */
function extractJsonCallsForMethod(content: string, method: string): JsonCallInfo[] {
    const lines = content.split('\n');

    // Find the handler declaration for this method
    const handlerRange = findMethodHandlerRange(lines, method);

    if (!handlerRange) {
        // Could not isolate the method — fall back to whole file
        return extractJsonCallsFromRange(content, lines, 0, lines.length - 1);
    }

    return extractJsonCallsFromRange(content, lines, handlerRange.start, handlerRange.end);
}

function findMethodHandlerRange(
    lines: string[],
    method: string,
): { start: number; end: number } | null {
    const declPattern = new RegExp(`export\\s+const\\s+${method}\\b`);
    const anyExportPattern = /^export\s+const\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\b/;

    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (declPattern.test(lines[i])) {
            startLine = i;
            break;
        }
    }

    if (startLine === -1) return null;

    // Find end boundary: next exported handler method or end of file
    let endLine = lines.length - 1;
    for (let i = startLine + 1; i < lines.length; i++) {
        if (anyExportPattern.test(lines[i])) {
            // Different method export found — this handler ends before it
            const matchedMethod = lines[i].match(anyExportPattern);
            if (matchedMethod && matchedMethod[1] !== method) {
                endLine = i - 1;
                break;
            }
        }
    }

    return { start: startLine, end: endLine };
}

function extractJsonCallsFromRange(
    content: string,
    lines: string[],
    startLine: number,
    endLine: number,
): JsonCallInfo[] {
    const results: JsonCallInfo[] = [];

    // Check for new Response(null, { status: 204 })
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
        const line = lines[i];
        if (/new\s+Response\s*\(\s*null/.test(line)) {
            // Check this line and next few lines for status: 204
            const window = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
            if (/status:\s*204/.test(window)) {
                results.push({
                    line: i + 1,
                    fields: new Set(),
                    kind: 'no-content',
                    raw: line.trim(),
                });
            }
        }
    }

    // Find all json( calls in range
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
        const line = lines[i];

        const jsonIdx = findJsonCallOnLine(line);
        if (jsonIdx === -1) continue;

        // Check if this is an error response
        if (isErrorJsonCall(lines, i, endLine)) continue;

        const afterJson = line.slice(jsonIdx + 5);
        const trimmed = afterJson.trimStart();

        if (trimmed.startsWith('{')) {
            // Object literal — find the { position in content
            const contentPos = lineCharToContentPos(
                lines,
                i,
                jsonIdx + 5 + (afterJson.length - trimmed.length),
            );
            const extracted = extractObjectFields(content, contentPos);
            if (extracted) {
                results.push({
                    line: i + 1,
                    fields: extracted.fields,
                    kind: extracted.hasSpread ? 'spread' : 'object',
                    raw: extracted.raw,
                });
            }
        } else if (trimmed === '' || trimmed === '\n') {
            // json( followed by newline — check next line
            if (i + 1 <= endLine && i + 1 < lines.length) {
                const nextLine = lines[i + 1].trimStart();
                if (nextLine.startsWith('{')) {
                    const contentPos = lineCharToContentPos(
                        lines,
                        i + 1,
                        lines[i + 1].indexOf('{'),
                    );
                    const extracted = extractObjectFields(content, contentPos);
                    if (extracted) {
                        results.push({
                            line: i + 1,
                            fields: extracted.fields,
                            kind: extracted.hasSpread ? 'spread' : 'object',
                            raw: extracted.raw,
                        });
                    }
                } else {
                    results.push({
                        line: i + 1,
                        fields: new Set(),
                        kind: 'indirect',
                        raw: `json(${nextLine.split(/[,)]/)[0]}...)`,
                    });
                }
            }
        } else {
            // json(variable) or json(expression)
            const expr = trimmed.split(/[,)]/)[0].trim();
            if (expr && !expr.startsWith('{')) {
                results.push({
                    line: i + 1,
                    fields: new Set(),
                    kind: 'indirect',
                    raw: `json(${expr})`,
                });
            }
        }
    }

    return results;
}

function findJsonCallOnLine(line: string): number {
    // Find `json(` that's a function call (not inside a string or comment)
    // Simple approach: find all occurrences of `json(`
    let idx = 0;
    while (true) {
        const pos = line.indexOf('json(', idx);
        if (pos === -1) return -1;

        // Make sure it's not part of a larger identifier (e.g., `fromJson(`)
        // or a method call (e.g., `request.json(`)
        if (pos > 0) {
            const prevChar = line[pos - 1];
            if (/[a-zA-Z0-9_$.]/.test(prevChar)) {
                idx = pos + 5;
                continue;
            }
        }

        // Make sure it's not in a comment
        const beforePos = line.slice(0, pos);
        if (beforePos.includes('//')) return -1;

        return pos;
    }
}

function isErrorJsonCall(lines: string[], lineIdx: number, endLine: number): boolean {
    // Look at this line and next ~25 lines for status: 4xx/5xx
    // (error json() calls can span many lines when they include headers)
    const windowEnd = Math.min(lineIdx + 25, endLine + 1, lines.length);
    const window = lines.slice(lineIdx, windowEnd).join('\n');

    // Quick check: does the window contain an error status?
    const statusMatch = window.match(/status:\s*([45]\d{2})/);
    if (!statusMatch) return false;

    // More careful: use bracket counting from the json( call
    // to see if the status is in the json() call's second argument
    const jsonCallStart = window.indexOf('json(');
    if (jsonCallStart === -1) return false;

    const afterJson = window.slice(jsonCallStart + 5);

    // Count through the first argument (the data)
    let depth = 0;
    for (let i = 0; i < afterJson.length; i++) {
        const ch = afterJson[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            i = skipString(afterJson, i) - 1;
            continue;
        }
        if (ch === '{' || ch === '(' || ch === '[') depth++;
        if (ch === '}' || ch === ')' || ch === ']') {
            depth--;
            if (depth < 0) break; // closing paren of json()
        }
        if (ch === ',' && depth === 0) {
            // Now in second argument — check for status
            const rest = afterJson.slice(i + 1);
            if (/status:\s*[45]\d{2}/.test(rest)) return true;
            break;
        }
    }

    return false;
}

function lineCharToContentPos(lines: string[], lineIdx: number, charIdx: number): number {
    let pos = 0;
    for (let i = 0; i < lineIdx; i++) {
        pos += lines[i].length + 1;
    }
    return pos + charIdx;
}

// ============================================================================
// Object Field Extraction (bracket-counting parser)
// ============================================================================

function extractObjectFields(
    content: string,
    startPos: number,
): { fields: Set<string>; hasSpread: boolean; raw: string } | null {
    // Advance to opening {
    let pos = startPos;
    while (pos < content.length && content[pos] !== '{') pos++;
    if (pos >= content.length) return null;

    // Find matching }
    const objectStart = pos;
    let depth = 0;
    let i = objectStart;

    while (i < content.length) {
        const ch = content[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            i = skipString(content, i);
            continue;
        }
        if (ch === '/' && i + 1 < content.length) {
            if (content[i + 1] === '/') {
                const nl = content.indexOf('\n', i);
                i = nl === -1 ? content.length : nl + 1;
                continue;
            }
            if (content[i + 1] === '*') {
                const end = content.indexOf('*/', i);
                i = end === -1 ? content.length : end + 2;
                continue;
            }
        }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                i++;
                break;
            }
        }
        i++;
    }

    if (depth !== 0) return null;

    const objectStr = content.slice(objectStart, i);
    const { fields, hasSpread } = parseTopLevelKeys(objectStr);

    return {
        fields,
        hasSpread,
        raw: objectStr.slice(0, 80) + (objectStr.length > 80 ? '...' : ''),
    };
}

/**
 * Parse top-level keys from an object literal string like `{ foo, bar: 1, ...x }`
 * Uses a state machine approach rather than regex.
 */
function parseTopLevelKeys(objectStr: string): {
    fields: Set<string>;
    hasSpread: boolean;
} {
    const fields = new Set<string>();
    let hasSpread = false;
    let depth = 0; // 0 = inside top-level { }
    let i = 1; // skip opening {

    while (i < objectStr.length - 1) {
        const ch = objectStr[i];

        // Skip whitespace
        if (/\s/.test(ch)) {
            i++;
            continue;
        }

        // Skip strings
        if (ch === "'" || ch === '"' || ch === '`') {
            if (depth === 0) {
                // Could be a quoted key like 'Content-Type':
                const quoteEnd = skipString(objectStr, i);
                const afterQuote = objectStr.slice(quoteEnd).trimStart();
                if (afterQuote.startsWith(':')) {
                    // Quoted key
                    const key = objectStr.slice(i + 1, quoteEnd - 1);
                    fields.add(key);
                    i = quoteEnd;
                    // Skip past : and value
                    i = skipValue(objectStr, i);
                    continue;
                }
            }
            i = skipString(objectStr, i);
            continue;
        }

        // Skip comments
        if (ch === '/' && i + 1 < objectStr.length) {
            if (objectStr[i + 1] === '/') {
                const nl = objectStr.indexOf('\n', i);
                i = nl === -1 ? objectStr.length : nl + 1;
                continue;
            }
            if (objectStr[i + 1] === '*') {
                const end = objectStr.indexOf('*/', i);
                i = end === -1 ? objectStr.length : end + 2;
                continue;
            }
        }

        // Depth tracking for nested structures
        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
            i++;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            depth--;
            i++;
            continue;
        }

        // Only process at top level
        if (depth !== 0) {
            i++;
            continue;
        }

        // Comma separator
        if (ch === ',') {
            i++;
            continue;
        }

        // Spread: ...
        if (objectStr.slice(i, i + 3) === '...') {
            hasSpread = true;
            i += 3;
            // Skip the spread expression
            i = skipExpression(objectStr, i);
            continue;
        }

        // Try to match identifier
        const identMatch = objectStr.slice(i).match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)/);
        if (identMatch) {
            const ident = identMatch[1];
            const afterIdent = objectStr.slice(i + ident.length).trimStart();

            if (afterIdent.startsWith(':')) {
                // key: value
                if (!JS_KEYWORDS.has(ident)) {
                    fields.add(ident);
                }
                // Skip past : and value
                i = i + ident.length;
                i = skipValue(objectStr, i);
            } else if (
                afterIdent.startsWith(',') ||
                afterIdent.startsWith('}') ||
                afterIdent.trimStart() === ''
            ) {
                // Shorthand property: { foo, bar }
                if (!JS_KEYWORDS.has(ident)) {
                    fields.add(ident);
                }
                i += ident.length;
            } else {
                // Some other context — skip
                i += ident.length;
            }
            continue;
        }

        // Computed property: [expr]:
        if (ch === '[') {
            // Skip computed key — can't extract
            depth++;
            i++;
            continue;
        }

        i++;
    }

    return { fields, hasSpread };
}

/**
 * Skip past a `:` and the subsequent value expression.
 * Handles nested objects, arrays, function calls, template literals, etc.
 */
function skipValue(str: string, pos: number): number {
    // Skip whitespace to find ':'
    let i = pos;
    while (i < str.length && /\s/.test(str[i])) i++;
    if (str[i] !== ':') return i;
    i++; // skip ':'

    return skipExpression(str, i);
}

/**
 * Skip an expression (value after : or after ...).
 * Returns position after the expression (at the next , or } at depth 0).
 */
function skipExpression(str: string, pos: number): number {
    let i = pos;
    let depth = 0;

    while (i < str.length) {
        const ch = str[i];

        if (ch === "'" || ch === '"' || ch === '`') {
            i = skipString(str, i);
            continue;
        }
        if (ch === '/' && i + 1 < str.length) {
            if (str[i + 1] === '/') {
                const nl = str.indexOf('\n', i);
                i = nl === -1 ? str.length : nl + 1;
                continue;
            }
            if (str[i + 1] === '*') {
                const end = str.indexOf('*/', i);
                i = end === -1 ? str.length : end + 2;
                continue;
            }
        }

        if (ch === '{' || ch === '[' || ch === '(') {
            depth++;
        } else if (ch === '}' || ch === ']' || ch === ')') {
            if (depth === 0) return i; // end of object or parent
            depth--;
        } else if (ch === ',' && depth === 0) {
            return i; // end of this value
        }
        i++;
    }
    return i;
}

function skipString(content: string, start: number): number {
    const quote = content[start];
    let i = start + 1;
    if (quote === '`') {
        while (i < content.length) {
            if (content[i] === '\\') {
                i += 2;
                continue;
            }
            if (content[i] === '`') return i + 1;
            if (content[i] === '$' && content[i + 1] === '{') {
                let depth = 1;
                i += 2;
                while (i < content.length && depth > 0) {
                    if (content[i] === '{') depth++;
                    else if (content[i] === '}') depth--;
                    else if (content[i] === '\\') i++;
                    i++;
                }
                continue;
            }
            i++;
        }
    } else {
        while (i < content.length) {
            if (content[i] === '\\') {
                i += 2;
                continue;
            }
            if (content[i] === quote) return i + 1;
            i++;
        }
    }
    return i;
}

// ============================================================================
// Step 4: Compare and Report
// ============================================================================

function verifyRoute(route: SpecRoute): VerifyResult {
    // Skip non-JSON responses
    const nonJsonPaths = ['/image/', '/hls', '/stream', '/subtitles/', '/trickplay/'];
    if (nonJsonPaths.some((p) => route.path.includes(p)) && route.specFields.size === 0) {
        return { status: 'binary', route, note: 'Binary/streaming response' };
    }

    const handler = specPathToHandlerFile(route.path, route.method);
    if (!handler) {
        return { status: 'no-handler', route };
    }

    if (route.successStatus === 204) {
        return { status: 'no-content', route, handler };
    }

    if (route.specFields.size === 0) {
        return { status: 'binary', route, note: 'No JSON schema in spec' };
    }

    const successCalls = handler.jsonCalls.filter((c) => c.kind !== 'no-content');

    if (successCalls.length === 0) {
        // Check if this method is actually exported from the handler file
        const resolvedPath = resolve(ROOT, handler.resolvedPath);
        const handlerContent = readFileSync(resolvedPath, 'utf-8');
        const methodExported =
            new RegExp(`export\\s+const\\s+${route.method}\\b`).test(handlerContent) ||
            new RegExp(`export\\s*\\{[^}]*\\b${route.method}\\b`).test(handlerContent);

        if (!methodExported) {
            // Method isn't exported — genuine no-handler
            return { status: 'no-handler', route };
        }

        // Handler file exists and exports this method but no json() calls found.
        // Usually means json() is in a helper function — treat as indirect.
        return {
            status: 'indirect',
            route,
            handler,
            jsonCalls: [
                {
                    line: 0,
                    fields: new Set(),
                    kind: 'indirect',
                    raw: '(no direct json() call — likely delegates to helper function)',
                },
            ],
        };
    }

    const hasIndirect = successCalls.some((c) => c.kind === 'indirect');
    const hasSpread = successCalls.some((c) => c.kind === 'spread');

    const allHandlerFields = new Set<string>();
    for (const call of successCalls) {
        for (const field of call.fields) {
            allHandlerFields.add(field);
        }
    }

    if (hasIndirect && allHandlerFields.size === 0) {
        return { status: 'indirect', route, handler, jsonCalls: successCalls };
    }

    const extraInSpec = [...route.specFields].filter((f) => !allHandlerFields.has(f));
    const missingFromSpec = [...allHandlerFields].filter((f) => !route.specFields.has(f));

    if (hasSpread || hasIndirect) {
        if (extraInSpec.length === 0) {
            return { status: 'match', route, handler };
        }
        return { status: 'indirect', route, handler, jsonCalls: successCalls };
    }

    if (extraInSpec.length === 0 && missingFromSpec.length === 0) {
        return { status: 'match', route, handler };
    }

    return { status: 'mismatch', route, handler, extraInSpec, missingFromSpec };
}

// ============================================================================
// Report
// ============================================================================

function printReport(results: VerifyResult[]): void {
    const matches = results.filter((r) => r.status === 'match');
    const mismatches = results.filter((r) => r.status === 'mismatch');
    const indirect = results.filter((r) => r.status === 'indirect');
    const noHandler = results.filter((r) => r.status === 'no-handler');
    const binary = results.filter((r) => r.status === 'binary');
    const noContent = results.filter((r) => r.status === 'no-content');

    console.log('');
    console.log('=== OpenAPI Spec Verification Report ===');
    console.log('');
    console.log(`CHECKED:     ${results.length} route-methods`);
    console.log(`MATCHED:     ${matches.length}`);
    console.log(`MISMATCHED:  ${mismatches.length}`);
    console.log(`INDIRECT:    ${indirect.length} (json(variable) — manual check needed)`);
    console.log(`NO HANDLER:  ${noHandler.length}`);
    console.log(`BINARY/SSE:  ${binary.length} (non-JSON responses, skipped)`);
    console.log(`NO CONTENT:  ${noContent.length} (204 responses)`);

    if (mismatches.length > 0) {
        console.log('');
        console.log('--- MISMATCHES ---');
        console.log('');

        for (let i = 0; i < mismatches.length; i++) {
            const r = mismatches[i];
            if (r.status !== 'mismatch') continue;
            console.log(`[${i + 1}] ${r.route.method} ${r.route.path}`);
            console.log(`    Handler: ${r.handler.resolvedPath}`);
            console.log(`    Spec fields:    {${[...r.route.specFields].sort().join(', ')}}`);

            const handlerFields = new Set<string>();
            for (const call of r.handler.jsonCalls) {
                for (const f of call.fields) handlerFields.add(f);
            }
            console.log(`    Handler fields: {${[...handlerFields].sort().join(', ')}}`);

            if (r.extraInSpec.length > 0) {
                console.log(`    Extra in spec:     [${r.extraInSpec.sort().join(', ')}]`);
            }
            if (r.missingFromSpec.length > 0) {
                console.log(`    Missing from spec: [${r.missingFromSpec.sort().join(', ')}]`);
            }
            console.log('');
        }
    }

    if (indirect.length > 0) {
        console.log('');
        console.log('--- INDIRECT (json(variable) — verify manually) ---');
        console.log('');

        for (let i = 0; i < indirect.length; i++) {
            const r = indirect[i];
            if (r.status !== 'indirect') continue;
            console.log(`[${i + 1}] ${r.route.method} ${r.route.path}`);
            console.log(`    Handler: ${r.handler.resolvedPath}`);
            for (const call of r.jsonCalls) {
                console.log(`    Line ${call.line}: ${call.raw}`);
            }
            if (r.route.specFields.size > 0) {
                console.log(`    Spec expects: {${[...r.route.specFields].sort().join(', ')}}`);
            }
            console.log('');
        }
    }

    if (noHandler.length > 0) {
        console.log('');
        console.log('--- NO HANDLER FOUND ---');
        console.log('');

        for (const r of noHandler) {
            console.log(`  ${r.route.method} ${r.route.path}`);
        }
        console.log('');
    }

    const exitCode = mismatches.length > 0 ? 1 : 0;
    if (exitCode === 0) {
        console.log('All verified routes match their spec definitions.');
    } else {
        console.log(`Found ${mismatches.length} mismatch(es). Review above.`);
    }
    console.log('');
    console.log('--- Limitations ---');
    console.log('- Cannot extract fields from json(variable) — reported as "indirect"');
    console.log('- Cannot extract fields from ApiResponses.success(data) — reported as "indirect"');
    console.log('- Cannot verify nested object shapes — only top-level field names');
    console.log('- Spread operators (...obj) mean partial extraction only');
    console.log('- Does NOT verify request params/body — only response schemas');

    process.exit(exitCode);
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    const yamlPath = resolve(ROOT, 'docs/api/openapi.yaml');
    if (!existsSync(yamlPath)) {
        console.error(`OpenAPI spec not found at: ${yamlPath}`);
        console.error('Run: npm run openapi:generate');
        process.exit(1);
    }

    console.log('Loading OpenAPI spec...');
    const specRoutes = loadSpecRoutes(yamlPath);
    console.log(`Found ${specRoutes.length} route-methods in spec.`);

    console.log('Verifying handlers...');
    const results = specRoutes.map(verifyRoute);

    printReport(results);
}

main();
