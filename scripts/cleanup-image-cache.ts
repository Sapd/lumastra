#!/usr/bin/env npx tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Image Cache Cleanup Script
 *
 * Removes expired image files from all cache directories.
 * Run manually or via cron job (recommended: daily).
 *
 * Usage:
 *   npx tsx scripts/cleanup-image-cache.ts
 *   # or with custom retention:
 *   IMAGE_CACHE_RETENTION_DAYS=7 npx tsx scripts/cleanup-image-cache.ts
 *
 * Cache directories cleaned:
 *   - .cache/jellyfin     (Jellyfin images)
 *   - .cache/tmdb         (TMDB posters/backdrops)
 *   - .cache/tmdb-persons (Actor photos)
 *   - .cache/user-avatars (User profile images)
 *   - .cache/custom-url   (Custom URL proxied images)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

// Configuration
const RETENTION_DAYS = Number.parseInt(process.env.IMAGE_CACHE_RETENTION_DAYS || '30', 10);
const MAX_AGE_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PROJECT_ROOT = process.cwd();

// Cache directories to clean
function getImageCacheDirs(): { name: string; path: string }[] {
    return [
        {
            name: 'jellyfin',
            path: process.env.JELLYFIN_CACHE_DIR || path.join(PROJECT_ROOT, '.cache', 'jellyfin'),
        },
        {
            name: 'tmdb',
            path: process.env.TMDB_CACHE_DIR || path.join(PROJECT_ROOT, '.cache', 'tmdb'),
        },
        {
            name: 'tmdb-persons',
            path: process.env.TMDB_CACHE_DIR
                ? path.join(process.env.TMDB_CACHE_DIR, 'persons')
                : path.join(PROJECT_ROOT, '.cache', 'tmdb-persons'),
        },
        {
            name: 'user-avatars',
            path:
                process.env.USER_AVATAR_CACHE_DIR ||
                path.join(PROJECT_ROOT, '.cache', 'user-avatars'),
        },
        {
            name: 'custom-url',
            path: path.join(PROJECT_ROOT, '.cache', 'custom-url'),
        },
        {
            name: 'audiobook',
            path: path.join(PROJECT_ROOT, '.cache', 'audiobook'),
        },
        {
            name: 'arr-images',
            path: path.join(PROJECT_ROOT, '.cache', 'arr-images'),
        },
    ];
}

interface CleanupStats {
    totalFiles: number;
    deletedFiles: number;
    deletedBytes: number;
    errors: number;
}

function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

async function cleanupDirectory(dirPath: string): Promise<CleanupStats> {
    const stats: CleanupStats = {
        totalFiles: 0,
        deletedFiles: 0,
        deletedBytes: 0,
        errors: 0,
    };

    try {
        await fs.access(dirPath);
    } catch {
        // Directory doesn't exist
        return stats;
    }

    const now = Date.now();

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isFile()) continue;

            stats.totalFiles++;
            const filePath = path.join(dirPath, entry.name);

            try {
                const fileStat = await fs.stat(filePath);
                const age = now - fileStat.mtimeMs;

                if (age > MAX_AGE_MS) {
                    await fs.unlink(filePath);
                    stats.deletedFiles++;
                    stats.deletedBytes += fileStat.size;
                }
            } catch (err) {
                stats.errors++;
                console.warn(`   ⚠️  Error processing ${entry.name}: ${(err as Error).message}`);
            }
        }
    } catch (err) {
        stats.errors++;
        console.error(`   ❌ Error reading directory: ${(err as Error).message}`);
    }

    return stats;
}

async function main() {
    const startTime = Date.now();

    console.log('🧹 Image Cache Cleanup');
    console.log('━'.repeat(50));
    console.log(`📅 Run time: ${new Date().toISOString()}`);
    console.log(`📁 Retention: ${RETENTION_DAYS} days`);
    console.log('');

    const cacheDirs = getImageCacheDirs();
    let totalDeleted = 0;
    let totalBytes = 0;
    let totalFiles = 0;
    let totalErrors = 0;

    for (const { name, path: dirPath } of cacheDirs) {
        console.log(`📂 ${name}`);
        console.log(`   Path: ${dirPath}`);

        const stats = await cleanupDirectory(dirPath);

        totalFiles += stats.totalFiles;
        totalDeleted += stats.deletedFiles;
        totalBytes += stats.deletedBytes;
        totalErrors += stats.errors;

        if (stats.totalFiles === 0) {
            console.log('   (empty or not found)');
        } else if (stats.deletedFiles === 0) {
            console.log(`   ✓ ${stats.totalFiles} files, none expired`);
        } else {
            console.log(
                `   ✓ Deleted ${stats.deletedFiles}/${stats.totalFiles} files (${formatBytes(stats.deletedBytes)})`,
            );
        }
        console.log('');
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('━'.repeat(50));
    console.log('📊 Summary');
    console.log(`   Total files scanned: ${totalFiles}`);
    console.log(`   Files deleted: ${totalDeleted}`);
    console.log(`   Space freed: ${formatBytes(totalBytes)}`);
    if (totalErrors > 0) {
        console.log(`   Errors: ${totalErrors}`);
    }
    console.log(`   Duration: ${duration}s`);
    console.log('');

    if (totalErrors > 0) {
        console.log('⚠️  Completed with errors');
        process.exit(1);
    } else {
        console.log('✅ Cleanup completed successfully!');
    }
}

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
