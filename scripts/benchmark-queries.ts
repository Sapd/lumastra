#!/usr/bin/env tsx
// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import 'dotenv/config';
import { Database } from '../src/lib/server/database/connection';
import { performance } from 'perf_hooks';

const db = new Database();

interface BenchmarkResult {
    operation: string;
    avgTime: number;
    minTime: number;
    maxTime: number;
    medianTime: number;
    p95Time: number;
    iterations: number;
    throughput?: number;
}

async function benchmark(
    name: string,
    fn: () => Promise<unknown>,
    iterations: number = 10,
): Promise<BenchmarkResult> {
    const times: number[] = [];

    // Warmup run to avoid cold start bias
    console.log(`  Warming up ${name}...`);
    await fn();

    // Actual measurements
    console.log(`  Running ${iterations} iterations...`);
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        await fn();
        const end = performance.now();
        times.push(end - start);
    }

    times.sort((a, b) => a - b);
    const avgTime = times.reduce((a, b) => a + b) / times.length;
    const minTime = times[0];
    const maxTime = times[times.length - 1];
    const medianTime = times[Math.floor(times.length / 2)];
    const p95Index = Math.floor(times.length * 0.95);
    const p95Time = times[p95Index];

    return {
        operation: name,
        avgTime,
        minTime,
        maxTime,
        medianTime,
        p95Time,
        iterations,
    };
}

async function benchmarkBatch(
    name: string,
    fn: () => Promise<unknown>,
    itemCount: number,
    iterations: number = 5,
): Promise<BenchmarkResult> {
    const result = await benchmark(name, fn, iterations);

    // Calculate throughput (items per second)
    const throughput = (itemCount * 1000) / result.avgTime;

    return {
        ...result,
        throughput,
    };
}

async function main(): Promise<void> {
    console.log('Database Refactoring Performance Benchmarks');
    console.log('='.repeat(80));
    console.log(`Started at: ${new Date().toISOString()}\n`);

    const results: BenchmarkResult[] = [];

    // Get sample data for benchmarks
    console.log('Preparing sample data...');
    const sampleItems = await db.searchMedia('action', { limit: 20 });
    const sampleTmdbId = sampleItems[0]?.tmdb_id;
    const sampleMediaType = sampleItems[0]?.media_type;
    const sampleUuid = sampleTmdbId ? await db.resolveMediaId(sampleTmdbId, sampleMediaType) : null;

    console.log('\n--- Search Queries ---\n');

    results.push(
        await benchmark('searchMedia("matrix", limit: 20)', () =>
            db.searchMedia('matrix', { limit: 20 }),
        ),
    );

    results.push(
        await benchmark('searchMediaFulltext("space adventure", limit: 20)', () =>
            db.searchMediaFulltext('space adventure', { limit: 20 }),
        ),
    );

    // searchEpisode requires season/episode numbers, skip it
    // results.push(
    // 	await benchmark('searchEpisode("pilot", limit: 20)', () =>
    // 		db.searchEpisode('pilot', { limit: 20 })
    // 	)
    // );

    console.log('\n--- Browse Queries ---\n');

    results.push(
        await benchmark('getMediaAlphabetical(limit: 50)', () =>
            db.getMediaAlphabetical({ limit: 50, offset: 0 }),
        ),
    );

    results.push(await benchmark('getAvailableLibraries()', () => db.getAvailableLibraries()));

    if (sampleUuid) {
        console.log('\n--- Embedding Operations ---\n');

        results.push(
            await benchmark('buildMediaEmbeddingFromUuid()', () =>
                db.buildMediaEmbeddingFromUuid(sampleUuid),
            ),
        );

        if (sampleTmdbId && sampleMediaType) {
            results.push(
                await benchmark('getDualEmbedding()', () =>
                    db.getDualEmbedding(sampleTmdbId, sampleMediaType),
                ),
            );

            results.push(
                await benchmark('getMediaEmbedding()', () =>
                    db.getMediaEmbedding(sampleTmdbId, sampleMediaType),
                ),
            );
        }
    }

    console.log('\n--- Batch Operations ---\n');

    // Batch embedding generation
    const uuidBatch: string[] = [];
    for (const item of sampleItems.slice(0, 10)) {
        const uuid = await db.resolveMediaId(item.tmdb_id, item.media_type);
        if (uuid) {
            uuidBatch.push(uuid);
        }
    }

    if (uuidBatch.length > 0) {
        results.push(
            await benchmarkBatch(
                `batchBuildMediaEmbeddingsFromUuids(${uuidBatch.length} items)`,
                () => db.batchBuildMediaEmbeddingsFromUuids(uuidBatch),
                uuidBatch.length,
                3,
            ),
        );
    }

    // Batch watch status - requires UUIDs, so resolve them first
    const mediaUuids: string[] = [];
    for (const item of sampleItems.slice(0, 20)) {
        const uuid = await db.resolveMediaId(item.tmdb_id, item.media_type);
        if (uuid) {
            mediaUuids.push(uuid);
        }
    }
    if (mediaUuids.length > 0) {
        const testUserId = 'test-user';
        results.push(
            await benchmarkBatch(
                `batchGetWatchStatus(${mediaUuids.length} items)`,
                () => db.batchGetWatchStatus(testUserId, mediaUuids),
                mediaUuids.length,
                3,
            ),
        );
    }

    // batchResolveMediaIds is a helper function, not a Database method - skip

    if (sampleTmdbId && sampleMediaType) {
        console.log('\n--- Resolution Operations ---\n');

        results.push(
            await benchmark('resolveMediaId()', () =>
                db.resolveMediaId(sampleTmdbId, sampleMediaType),
            ),
        );
    }

    // Skipping user data and analytics queries - many are not exposed on Database class
    // These are accessed through services or direct query modules

    // Print summary table
    console.log('\n' + '='.repeat(80));
    console.log('RESULTS SUMMARY');
    console.log('='.repeat(80));
    console.log();

    // Format results for table display
    const tableData = results.map((r) => {
        const row: Record<string, string | number> = {
            Operation: r.operation,
            'Avg (ms)': r.avgTime.toFixed(2),
            'Min (ms)': r.minTime.toFixed(2),
            'Max (ms)': r.maxTime.toFixed(2),
            'Median (ms)': r.medianTime.toFixed(2),
            'P95 (ms)': r.p95Time.toFixed(2),
            Iterations: r.iterations,
        };

        if (r.throughput !== undefined) {
            row['Items/sec'] = r.throughput.toFixed(0);
        }

        return row;
    });

    console.table(tableData);

    // Calculate overall statistics
    const avgTimes = results.map((r) => r.avgTime);
    const overallAvg = avgTimes.reduce((a, b) => a + b, 0) / avgTimes.length;
    const fastestOp = results.reduce((min, r) => (r.avgTime < min.avgTime ? r : min));
    const slowestOp = results.reduce((max, r) => (r.avgTime > max.avgTime ? r : max));

    console.log('\n' + '='.repeat(80));
    console.log('OVERALL STATISTICS');
    console.log('='.repeat(80));
    console.log(`Total operations tested: ${results.length}`);
    console.log(`Average query time: ${overallAvg.toFixed(2)}ms`);
    console.log(`Fastest operation: ${fastestOp.operation} (${fastestOp.avgTime.toFixed(2)}ms)`);
    console.log(`Slowest operation: ${slowestOp.operation} (${slowestOp.avgTime.toFixed(2)}ms)`);

    // Batch operation efficiency
    const batchOps = results.filter((r) => r.throughput !== undefined);
    if (batchOps.length > 0) {
        console.log('\n--- Batch Operation Efficiency ---');
        batchOps.forEach((r) => {
            console.log(`${r.operation}: ${r.throughput?.toFixed(0)} items/sec`);
        });
    }

    console.log('\n' + '='.repeat(80));
    console.log(`Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(80));

    // Database connection cleanup happens automatically
    process.exit(0);
}

main().catch((error) => {
    console.error('\n❌ Benchmark failed:', error);
    process.exit(1);
});
