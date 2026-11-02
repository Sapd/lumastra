// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native exemplar: file-system-scan (demo).
 *
 * TUTORIAL: This shows the "multi-stage pipeline" pattern — three tasks
 * cooperating via `pipeline.of` and `pipeline.after`. The orchestrator
 * translates the declarative DAG into a BullMQ FlowProducer tree, so each
 * stage parks waiting for its predecessor to complete and the runner
 * never sees `WaitingChildrenError`.
 *
 * Three stages here:
 *   1. file-system-scan-discover  — walk the filesystem, list candidate paths
 *   2. file-system-scan-probe     — ffprobe each path
 *   3. file-system-scan-ingest    — upsert into media_items
 *
 * The real implementation spans `media-sources/file-scanner/*.ts` plus
 * `file-library-scan.plugin.ts`. We don't reproduce the heavy logic; we
 * show the SDK pattern so a contributor can scale up. Compare with
 * `tmdb-metadata-sync` (single-stage external API) and
 * `library-embeddings` (chunked drain) for the other patterns.
 *
 * Scoping: this pipeline runs per library group. `identityFor` returns
 * `lg:${libraryGroupId}` so two library groups can scan in parallel but
 * the same group never has two concurrent scans.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';

// ──────────────────────────────────────────────────────────────────────────────
// Shared input schema (every stage takes the same envelope so the
// FlowProducer can wire them up).
// ──────────────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
    libraryGroupId: z.string(),
    /** When true, every file is re-probed; when false, only new/changed. */
    force: z.boolean().optional().default(false),
});

type ScanInput = z.infer<typeof inputSchema>;

// ──────────────────────────────────────────────────────────────────────────────
// Stage 1: discover
// ──────────────────────────────────────────────────────────────────────────────

export const fileSystemScanDiscoverTask = defineTask<ScanInput, { paths: string[] }>({
    id: 'file-system-scan-discover',
    purpose: 'library',
    // SDK tutorial exemplar — the production file scanner lives at
    // `tasks/builtin/native/media-sources/file-scanner.ts`. This stage is a
    // member of the `file-system-scan-demo` tutorial pipeline.
    demo: true,
    name: 'File scan: discover',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // TUTORIAL: pipeline declares this task as a member of the
    // 'file-system-scan' pipeline. No `after` ⇒ it runs first.
    pipeline: { of: 'file-system-scan' },

    // TUTORIAL: per-library identity. The orchestrator dedups two
    // simultaneous scans of the same group via SET NX on this key.
    identityFor: (input) => `lg-${input.libraryGroupId}`,
    scope: 'libraryGroup',
    resourceClass: 'io',
    inputSchema,

    async execute(ctx) {
        ctx.logger.info('discover stage', { lg: ctx.input.libraryGroupId });
        // Real impl: walk LIBRARY_PATHS, ignore .git/.cache, etc.
        const paths = ['/fake/movie.mkv', '/fake/show/s01e01.mkv'];
        return {
            success: true,
            itemsProcessed: paths.length,
            result: { paths },
        };
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// Stage 2: probe (runs after discover)
// ──────────────────────────────────────────────────────────────────────────────

export const fileSystemScanProbeTask = defineTask<ScanInput, unknown>({
    id: 'file-system-scan-probe',
    purpose: 'library',
    demo: true,
    name: 'File scan: probe',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true, ffmpeg: true },

    pipeline: {
        of: 'file-system-scan',
        after: ['file-system-scan-discover'],
        // TUTORIAL: `when` is a conditional predicate evaluated against
        // the parent's result. Return false to skip this stage (the
        // runner marks it `cancelled` with reason "skipped_due_to_
        // pipeline_when"). Useful for "only probe if discover found
        // anything new".
        when: (parentResult) => {
            const r = parentResult as { paths?: string[] } | undefined;
            return (r?.paths?.length ?? 0) > 0;
        },
    },

    identityFor: (input) => `lg-${input.libraryGroupId}`,
    scope: 'libraryGroup',
    resourceClass: 'cpu', // ffprobe is CPU-bound
    inputSchema,

    async execute(ctx) {
        ctx.logger.info('probe stage', { lg: ctx.input.libraryGroupId });
        // Real impl: ctx.ffmpeg.probe(path) for each path from parent
        return { success: true, itemsProcessed: 0 };
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// Stage 3: ingest (runs after probe)
// ──────────────────────────────────────────────────────────────────────────────

export const fileSystemScanIngestTask = defineTask<ScanInput, unknown>({
    id: 'file-system-scan-ingest',
    purpose: 'library',
    demo: true,
    name: 'File scan: ingest',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    pipeline: {
        of: 'file-system-scan',
        after: ['file-system-scan-probe'],
    },

    identityFor: (input) => `lg-${input.libraryGroupId}`,
    scope: 'libraryGroup',
    resourceClass: 'io',
    inputSchema,

    async execute(ctx) {
        ctx.logger.info('ingest stage', { lg: ctx.input.libraryGroupId });
        // Real impl: INSERT INTO media_items, build external_ids, …
        return { success: true, itemsProcessed: 0 };
    },
});

// ──────────────────────────────────────────────────────────────────────────────
// Pipeline trigger — a scheduled root task that starts the DAG. The
// orchestrator resolves the pipeline at startRun time and enqueues the
// stage children via FlowProducer.
// ──────────────────────────────────────────────────────────────────────────────

export const fileSystemScanTask = defineTask<ScanInput, unknown>({
    id: 'file-system-scan-demo',
    purpose: 'library',
    // SDK tutorial exemplar — hidden in production via the `demo` flag.
    // The real file-scan pipeline is `file-system-scan-discover/-probe/-ingest`
    // (registered above); this demo only exists to show the multi-stage
    // pipeline pattern with conditional `when:`.
    demo: true,
    name: 'File scan: orchestrate',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // TUTORIAL: in a real pipeline you'd schedule the root here so the
    // FlowProducer wires the whole DAG (discover → probe → ingest) on a
    // cadence. The demo is operator-only — no `schedule` means it never
    // polls fake paths against the real filesystem in production. Trigger
    // manually from /admin/tasks to watch the multi-stage pattern execute.

    identityFor: (input) => `lg-${input.libraryGroupId}`,
    scope: 'libraryGroup',
    resourceClass: 'io',
    inputSchema,

    async execute(ctx) {
        // TUTORIAL: a pipeline root usually just delegates to its
        // children. The FlowProducer wires the stages; this execute()
        // exists for legacy callers and for runs that don't follow the
        // pipeline path.
        ctx.logger.info('file-system-scan root', {
            lg: ctx.input.libraryGroupId,
        });
        return { success: true, itemsProcessed: 0 };
    },
});

registry.registerTask(fileSystemScanDiscoverTask);
registry.registerTask(fileSystemScanProbeTask);
registry.registerTask(fileSystemScanIngestTask);
registry.registerTask(fileSystemScanTask);
