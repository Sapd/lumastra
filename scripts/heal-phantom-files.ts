// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phantom-file cleanup script.
 *
 * The W3.1 deleteStaleMediaFile fix added sibling promotion when the
 * default file is removed, so going-forward all stale-delete paths preserve
 * the is_default invariant. But preprod has accumulated ~12,000 phantom
 * media_files rows whose `file_path` no longer exists on disk — leftovers
 * from earlier scanner runs that crashed mid-rotation, ad-hoc operator
 * deletes, etc. This script walks the table, statting each path, and
 * routes the missing ones through `deleteStaleMediaFile` so sibling
 * promotion + has_files recompute + orphan cleanup all run in the same
 * transaction the live scanner uses.
 *
 * It is INTENTIONALLY a script, not a SQL migration: deciding whether a
 * file is "missing" requires `fs.stat`, which migrations cannot perform
 * inside their own transaction. Operators run this once after deploy of
 * W5 to drain the backlog, then the W6 daily integrity scanner keeps it
 * clean.
 *
 * Usage:
 *   Dry run (default): npx tsx scripts/heal-phantom-files.ts
 *   Apply changes:     npx tsx scripts/heal-phantom-files.ts --apply
 *   Verbose progress:  npx tsx scripts/heal-phantom-files.ts --verbose
 *   Custom batch size: npx tsx scripts/heal-phantom-files.ts --batch-size=500
 *
 * Idempotent — safe to re-run. A re-run after a successful first pass
 * walks all rows again, finds zero missing, and exits cleanly.
 *
 * The script is also the contract used by the unit test
 * `scripts/heal-phantom-files.test.ts`, which exposes the inner
 * `healPhantomFiles({ sql, fileExists, ... })` function so callers can
 * inject a mocked stat function over a tmpdir of real files.
 */

import { stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import type postgres from 'postgres';

dotenv.config({ quiet: true });

interface MediaFileRow {
    id: string;
    file_path: string;
}

export interface HealPhantomFilesOptions {
    sql: postgres.Sql;
    /**
     * Predicate that returns true when the file at `path` exists. Defaults
     * to `node:fs/promises#stat` not throwing. The test injects a tmpdir
     * stub.
     */
    fileExists?: (_path: string) => Promise<boolean>;
    /**
     * Drives the deletion path. Defaults to the production
     * `deleteStaleMediaFile` query. Tests can pass a no-op or counting
     * stub to keep the test offline.
     */
    deleteStaleMediaFile?: (_sql: postgres.Sql, _filePath: string) => Promise<void>;
    /** When false, do not delete anything; just return counts. */
    apply?: boolean;
    /** Rows pulled per page. Defaults to 1000. */
    batchSize?: number;
    /** Print per-row progress. */
    verbose?: boolean;
    /** Sink for log output. Defaults to console.log. */
    log?: (_msg: string) => void;
}

export interface HealPhantomFilesResult {
    /** Total rows walked across all batches. */
    scanned: number;
    /** Rows whose file_path is missing on disk. */
    missing: number;
    /** Rows we deleted (= missing iff apply=true; 0 if apply=false). */
    deleted: number;
    /** Rows whose deletion threw. */
    errors: number;
}

async function defaultFileExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * Walk every media_files row in batches. For each row whose file_path
 * cannot be stat'd, call deleteStaleMediaFile so the W3.1 sibling-promotion
 * logic runs inside the same transaction as the row delete.
 */
export async function healPhantomFiles(
    opts: HealPhantomFilesOptions,
): Promise<HealPhantomFilesResult> {
    const fileExists = opts.fileExists ?? defaultFileExists;
    const apply = opts.apply ?? false;
    const batchSize = opts.batchSize ?? 1000;
    const verbose = opts.verbose ?? false;
    const log = opts.log ?? ((msg: string) => console.log(msg));

    const sql = opts.sql;
    let deleteFn = opts.deleteStaleMediaFile;
    if (!deleteFn) {
        const mod = await import('../src/lib/server/database/queries/media-files.queries.js');
        deleteFn = mod.deleteStaleMediaFile;
    }

    const result: HealPhantomFilesResult = {
        scanned: 0,
        missing: 0,
        deleted: 0,
        errors: 0,
    };

    // Cursor pagination via id (UUID) ordering. Stable across deletions
    // because the cursor is on the row we already advanced past.
    let cursor: string | null = null;

    while (true) {
        const rows: MediaFileRow[] = cursor
            ? await sql<MediaFileRow[]>`
                  SELECT id, file_path
                  FROM media_files
                  WHERE id > ${cursor}::uuid
                  ORDER BY id
                  LIMIT ${batchSize}
              `
            : await sql<MediaFileRow[]>`
                  SELECT id, file_path
                  FROM media_files
                  ORDER BY id
                  LIMIT ${batchSize}
              `;

        if (rows.length === 0) break;

        for (const row of rows) {
            result.scanned++;
            const exists = await fileExists(row.file_path);
            if (exists) continue;

            result.missing++;
            if (verbose) {
                log(`[heal-phantom-files] missing: ${row.file_path} (id=${row.id})`);
            }

            if (!apply) continue;

            try {
                // deleteStaleMediaFile uses withTx + sibling promotion +
                // recomputeHasFiles + cleanupOrphanedMediaItems atomically.
                await deleteFn(sql, row.file_path);
                result.deleted++;
            } catch (err) {
                result.errors++;
                log(
                    `[heal-phantom-files] failed to delete ${row.file_path}: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                );
            }
        }

        // Advance the cursor to the last row we saw. If we deleted that
        // row in this batch the cursor still points at a UUID that no
        // longer exists, but the WHERE id > cursor predicate works on
        // ordering, not existence — so the next page resumes correctly.
        cursor = rows.at(-1)?.id ?? null;

        if (rows.length < batchSize) break;
    }

    return result;
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const verbose = process.argv.includes('--verbose');
    const batchSizeArg = process.argv.find((arg) => arg.startsWith('--batch-size='));
    const batchSize = batchSizeArg
        ? Math.max(1, Number.parseInt(batchSizeArg.split('=')[1], 10) || 1000)
        : 1000;

    console.log(
        `[heal-phantom-files] starting (mode=${apply ? 'APPLY' : 'DRY-RUN'}, batchSize=${batchSize})`,
    );

    const { getDb } = await import('../src/lib/server/database/connection.js');
    const db = getDb();
    if (!db) {
        console.error('[heal-phantom-files] database not available');
        process.exit(1);
    }

    try {
        const result = await healPhantomFiles({
            sql: db,
            apply,
            verbose,
            batchSize,
        });

        console.log('[heal-phantom-files] summary:');
        console.log(`  scanned:  ${result.scanned}`);
        console.log(`  missing:  ${result.missing}`);
        console.log(`  deleted:  ${result.deleted}`);
        console.log(`  errors:   ${result.errors}`);

        if (!apply) {
            console.log(
                `[heal-phantom-files] DRY RUN — re-run with --apply to delete the ${result.missing} missing rows`,
            );
        }
        process.exit(0);
    } catch (err) {
        console.error('[heal-phantom-files] fatal error:', err);
        process.exit(1);
    }
}

// Only run main when invoked as the entry script.
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err: unknown) => {
        console.error('[heal-phantom-files] fatal error:', err);
        process.exit(1);
    });
}
