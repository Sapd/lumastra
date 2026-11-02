// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lightweight RFC-4180 CSV serializer — isomorphic (works in both Node and
 * browser). No external dependencies.
 *
 * Rules:
 * - CRLF line endings (RFC-4180 §2).
 * - Fields containing `,`, `"`, or newlines are wrapped in double-quotes.
 * - Embedded double-quotes are doubled (`"` → `""`).
 * - null / undefined values are serialized as empty string.
 * - Formula-injection guard: fields whose first character is `=`, `+`, `-`,
 *   `@`, TAB or CR are prefixed with a single-quote (`'`) to prevent spreadsheet
 *   clients (Excel, LibreOffice) from evaluating them as formulas. The
 *   single-quote is visible in the raw CSV but hidden by most spreadsheet apps.
 */

/** Characters that trigger formula injection in spreadsheet apps. */
const FORMULA_INJECTION_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

function quoteField(value: string): string {
    // Apply formula-injection guard before any quoting decisions.
    let safe = value;
    if (value.length > 0 && FORMULA_INJECTION_CHARS.has(value[0])) {
        safe = `'${value}`;
    }
    if (safe.includes(',') || safe.includes('"') || safe.includes('\n') || safe.includes('\r')) {
        return `"${safe.replace(/"/g, '""')}"`;
    }
    return safe;
}

/**
 * Serialize an array of rows to RFC-4180 CSV.
 *
 * @param columns - Ordered column names (appear as header row).
 * @param rows    - Each row is a `Record<string, string>`. Values are stringified;
 *                  missing / undefined / null values become empty string.
 * @param bom     - When true, prepend the UTF-8 BOM (0xEF 0xBB 0xBF) so that
 *                  Excel on Windows opens the file with the correct encoding.
 *                  Default: false.
 * @returns The complete CSV string with CRLF line endings, header included.
 */
export function serializeToCSV(
    columns: string[],
    rows: Record<string, string | undefined | null>[],
    { bom = false }: { bom?: boolean } = {},
): string {
    const lines: string[] = [columns.map(quoteField).join(',')];
    for (const row of rows) {
        const cells = columns.map((col) => quoteField(row[col] ?? ''));
        lines.push(cells.join(','));
    }
    const body = lines.join('\r\n') + '\r\n';
    return bom ? '﻿' + body : body;
}
