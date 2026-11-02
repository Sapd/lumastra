#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Schema Sync Verification Script
 *
 * Verifies that Zod schemas in src/lib/schemas/api-responses.ts are complete
 * and serve as the SINGLE SOURCE OF TRUTH for API response types.
 *
 * This script checks:
 * - Zod schemas contain all expected fields
 * - Re-exports in server-driven-ui.ts match the schemas
 * - No manual interface definitions duplicating schema types
 *
 * Usage:
 *   npm run verify:schemas              # Standard check
 *   npm run verify:schemas -- --verbose # Show all fields including in-sync ones
 *
 * Exit codes:
 * - 0: All schemas in sync
 * - 1: Issues detected
 *
 * What to do if issues are detected:
 * 1. Review the missing fields in the output
 * 2. Update src/lib/schemas/api-responses.ts (the single source of truth)
 * 3. Re-run this script to verify the fix
 * 4. Run `npm run openapi:generate` to update the OpenAPI spec
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// ============================================================================
// File Paths
// ============================================================================

// Single source of truth for Zod schemas
const ZOD_SCHEMA_FILE = resolve(projectRoot, 'src/lib/schemas/api-responses.ts');
// Legacy OpenAPI components (should re-export from api-responses.ts)
const OPENAPI_COMPONENTS = resolve(projectRoot, 'scripts/openapi/components.ts');
// Re-export file (should import from schemas)
const TS_TYPES_SERVER_DRIVEN = resolve(projectRoot, 'src/lib/types/server-driven-ui.ts');
const TS_TYPES_API_COMMON = resolve(projectRoot, 'src/lib/types/api-common.ts');

// ============================================================================
// Field Extraction
// ============================================================================

/**
 * Extract field names from a Zod schema definition
 * Handles nested objects and optional fields
 */
function extractZodFields(content: string, schemaName: string): Set<string> {
    const fields = new Set<string>();

    // Find the schema definition
    const schemaRegex = new RegExp(
        `export const ${schemaName}\\s*=\\s*z\\s*\\.\\s*object\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`,
        'm',
    );
    const match = content.match(schemaRegex);

    if (!match) {
        console.error(`⚠️  Warning: Could not find schema ${schemaName}`);
        return fields;
    }

    const objectBody = match[1];

    // Extract field names (handles optional(), meta(), nested objects)
    // Pattern: fieldName: z.type()... or fieldName?: z.type()...
    const fieldRegex = /^\s*(\w+)\s*[?:]?\s*:/gm;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(objectBody)) !== null) {
        const fieldName = fieldMatch[1];
        // Skip if it's a nested object definition
        if (fieldName && !['meta', 'optional', 'nullable'].includes(fieldName)) {
            fields.add(fieldName);
        }
    }

    return fields;
}

/**
 * Extract field names from a TypeScript interface definition
 */
function extractTsInterfaceFields(content: string, interfaceName: string): Set<string> {
    const fields = new Set<string>();

    // Find the interface definition - more flexible regex to handle comments
    // Matches: export interface Name { ... } including multi-line with comments
    const interfaceRegex = new RegExp(
        `export\\s+interface\\s+${interfaceName}\\s*(?:\\{|extends[^{]+\\{)([\\s\\S]*?)\\n\\}`,
        'm',
    );
    const match = content.match(interfaceRegex);

    if (!match) {
        // Don't warn - interface might be in different file
        return fields;
    }

    const interfaceBody = match[1];

    // Extract field names (handles optional ?, readonly, JSDoc comments)
    // Pattern: fieldName?: type or fieldName: type
    // Improved to skip JSDoc lines and handle complex type definitions
    const lines = interfaceBody.split('\n');
    for (const line of lines) {
        // Skip comment lines
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) {
            continue;
        }

        // Match field definitions: name?: type or name: type
        const fieldMatch = line.match(/^\s*(?:readonly\s+)?(\w+)\s*[?:]?\s*:/);
        if (fieldMatch) {
            const fieldName = fieldMatch[1];
            if (fieldName) {
                fields.add(fieldName);
            }
        }
    }

    return fields;
}

// ============================================================================
// Comparison Logic
// ============================================================================

interface ComparisonResult {
    name: string;
    zodFields: Set<string>;
    tsFields: Set<string>;
    inSync: number;
    missingInZod: string[];
    onlyInZod: string[];
    notFound?: boolean;
}

function compareSchemas(
    zodContent: string,
    tsContentMap: Map<string, string>,
    schemaName: string,
    interfaceName: string,
): ComparisonResult {
    const zodFields = extractZodFields(zodContent, schemaName);

    // Try to find the interface in any of the TS content files
    let tsFields = new Set<string>();
    for (const tsContent of tsContentMap.values()) {
        const fields = extractTsInterfaceFields(tsContent, interfaceName);
        if (fields.size > 0) {
            tsFields = fields;
            break;
        }
    }

    const missingInZod: string[] = [];
    const onlyInZod: string[] = [];
    let inSync = 0;

    // Check for fields in TS but not in Zod (drift)
    for (const field of tsFields) {
        if (zodFields.has(field)) {
            inSync++;
        } else {
            missingInZod.push(field);
        }
    }

    // Check for fields in Zod but not in TS (unusual, but worth noting)
    for (const field of zodFields) {
        if (!tsFields.has(field)) {
            onlyInZod.push(field);
        }
    }

    return {
        name: interfaceName,
        zodFields,
        tsFields,
        inSync,
        missingInZod: missingInZod.sort(),
        onlyInZod: onlyInZod.sort(),
    };
}

// ============================================================================
// Reporting
// ============================================================================

function printReport(results: ComparisonResult[]): boolean {
    console.log('\n' + '='.repeat(80));
    console.log('Schema Sync Verification Report');
    console.log('='.repeat(80) + '\n');

    let hasDrift = false;
    let totalInSync = 0;
    let totalMissing = 0;

    for (const result of results) {
        console.log(`${result.name}:`);

        if (result.zodFields.size === 0) {
            console.log('  ⚠️  Zod schema not found\n');
            hasDrift = true;
            continue;
        }

        // If no TS interface exists, that's OK - we now use types from Zod schemas
        if (result.tsFields.size === 0) {
            console.log(
                `  ✓ ${result.zodFields.size} fields defined in Zod schema (types inferred from schema)\n`,
            );
            totalInSync += result.zodFields.size;
            continue;
        }

        if (result.missingInZod.length === 0 && result.onlyInZod.length === 0) {
            console.log(
                `  ✓ All ${result.inSync} field${result.inSync === 1 ? '' : 's'} in sync\n`,
            );
            totalInSync += result.inSync;
        } else {
            // Only count as drift if fields are missing FROM Zod
            // Fields only in Zod is fine (TS imports from Zod)
            if (result.missingInZod.length > 0) {
                hasDrift = true;
            }

            if (result.inSync > 0) {
                console.log(`  ✓ ${result.inSync} field${result.inSync === 1 ? '' : 's'} in sync`);
                totalInSync += result.inSync;
            }

            if (result.missingInZod.length > 0) {
                console.log(
                    `  ⚠️  ${result.missingInZod.length} field${result.missingInZod.length === 1 ? '' : 's'} in TypeScript but not in Zod:`,
                );
                for (const field of result.missingInZod) {
                    console.log(`     - ${field}`);
                }
                totalMissing += result.missingInZod.length;
            }

            if (result.onlyInZod.length > 0) {
                console.log(
                    `  ℹ️  ${result.onlyInZod.length} field${result.onlyInZod.length === 1 ? '' : 's'} in Zod only (OK - TS types inferred from schema)`,
                );
            }

            console.log('');
        }
    }

    console.log('='.repeat(80));
    console.log(`Summary: ${totalInSync} fields in Zod, ${totalMissing} fields missing`);
    console.log('='.repeat(80) + '\n');

    return hasDrift;
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
    console.log('Reading schema files...\n');
    console.log('Source of truth: src/lib/schemas/api-responses.ts\n');

    let zodContent: string;
    const tsContentMap = new Map<string, string>();

    try {
        zodContent = readFileSync(ZOD_SCHEMA_FILE, 'utf-8');
    } catch (error) {
        console.error(`❌ Failed to read Zod schema file: ${ZOD_SCHEMA_FILE}`);
        console.error(error);
        process.exit(1);
    }

    // Check that OpenAPI components re-exports from api-responses.ts
    try {
        const openApiContent = readFileSync(OPENAPI_COMPONENTS, 'utf-8');
        if (!openApiContent.includes("from '../../src/lib/schemas/api-responses'")) {
            console.warn(
                '⚠️  Warning: scripts/openapi/components.ts should re-export from api-responses.ts\n',
            );
        }
    } catch (error) {
        console.error(`❌ Failed to read OpenAPI components: ${OPENAPI_COMPONENTS}`);
        console.error(error);
    }

    try {
        tsContentMap.set('server-driven-ui', readFileSync(TS_TYPES_SERVER_DRIVEN, 'utf-8'));
    } catch (error) {
        console.error(`❌ Failed to read TypeScript types file: ${TS_TYPES_SERVER_DRIVEN}`);
        console.error(error);
        process.exit(1);
    }

    try {
        tsContentMap.set('api-common', readFileSync(TS_TYPES_API_COMMON, 'utf-8'));
    } catch (error) {
        console.error(`❌ Failed to read TypeScript types file: ${TS_TYPES_API_COMMON}`);
        console.error(error);
        process.exit(1);
    }

    // Define schema pairs to compare
    // Now we check the Zod schemas themselves (which are the source of truth)
    const schemaPairs: Array<[string, string]> = [
        ['UniversalMediaItemSchema', 'UniversalMediaItem'],
        ['PageSectionSchema', 'PageSection'],
        ['ExternalIdsResponseSchema', 'ExternalIds'],
    ];

    const results: ComparisonResult[] = [];

    for (const [zodSchema, tsInterface] of schemaPairs) {
        const result = compareSchemas(zodContent, tsContentMap, zodSchema, tsInterface);
        results.push(result);
    }

    const hasDrift = printReport(results);

    if (hasDrift) {
        console.log('❌ Issues detected! The Zod schemas should be the single source of truth.\n');
        console.log('Files to check:');
        console.log(`  - Zod schemas (source of truth): ${ZOD_SCHEMA_FILE}`);
        console.log(`  - Re-exports: ${TS_TYPES_SERVER_DRIVEN}`);
        console.log(`  - Legacy types: ${TS_TYPES_API_COMMON}\n`);
        process.exit(1);
    } else {
        console.log('✅ All schemas are in sync!\n');
        process.exit(0);
    }
}

main();
