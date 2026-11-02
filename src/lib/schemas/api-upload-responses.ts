// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for the in-app chunked upload API.
 *
 * All types are the single source of truth — TypeScript types are derived
 * via z.infer<>.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on totalChunks — a session declaring totalSize=1 with
 * totalChunks=20000 × 5MB chunks would write 100GB to disk (bypass of the
 * MAX_VIDEO_UPLOAD_GB size cap). 100 000 chunks × 5MB = 500 GB which is well
 * above any realistic upload; the service further tightens this per-request
 * based on the declared totalSize and the configured chunk size.
 */
export const MAX_TOTAL_CHUNKS = 100_000;

export const UploadInitRequestSchema = z.object({
    filename: z.string().min(1).max(512).describe('Original filename including extension'),
    mimeType: z.string().min(1).describe('MIME type of the file being uploaded'),
    totalSize: z.number().int().positive().describe('Total file size in bytes'),
    totalChunks: z
        .number()
        .int()
        .positive()
        .max(MAX_TOTAL_CHUNKS)
        .describe('Total number of chunks'),
    destinationFolder: z
        .string()
        .optional()
        .describe('Relative subfolder under the library root (default: root)'),
    metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe('Optional custom_metadata passed to the created media item'),
});
export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>;

export const UploadFinalizeRequestSchema = z.object({
    totalChunks: z
        .number()
        .int()
        .positive()
        .max(MAX_TOTAL_CHUNKS)
        .describe('Expected total chunk count (integrity check)'),
    sha256: z.string().optional().describe('Optional client-supplied SHA-256 hex of the full file'),
});
export type UploadFinalizeRequest = z.infer<typeof UploadFinalizeRequestSchema>;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const UploadInitResponseSchema = z
    .object({
        uploadId: z.string().guid().describe('Opaque session ID — use in subsequent chunk PUTs'),
        chunkSize: z.number().int().positive().describe('Byte size per chunk'),
        expiresAt: z.string().datetime().describe('ISO-8601 timestamp when the session expires'),
    })
    .describe('UploadInitResponse');
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>;

export const UploadChunkResponseSchema = z
    .object({
        received: z.literal(true),
        chunkIndex: z.number().int().nonnegative(),
        chunksReceived: z.number().int().nonnegative(),
    })
    .describe('UploadChunkResponse');
export type UploadChunkResponse = z.infer<typeof UploadChunkResponseSchema>;

export const UploadFinalizeResponseSchema = z
    .object({
        path: z.string().describe('Final absolute path of the assembled file on the server'),
        runId: z.string().optional().describe('Task run ID for the triggered file-delta-ingest'),
        status: z.enum(['queued', 'skipped']).describe('Whether ingest was enqueued or skipped'),
    })
    .describe('UploadFinalizeResponse');
export type UploadFinalizeResponse = z.infer<typeof UploadFinalizeResponseSchema>;

export const UploadAbortResponseSchema = z
    .object({
        deleted: z.literal(true),
    })
    .describe('UploadAbortResponse');
export type UploadAbortResponse = z.infer<typeof UploadAbortResponseSchema>;

export const UploadAncillaryResponseSchema = z
    .object({
        path: z.string().describe('Absolute path where the ancillary file was written'),
        undoId: z
            .uuid()
            .optional()
            .describe('Receipt restoring the previous uploaded chapter list and sidecar.'),
        type: z
            .enum(['subtitle', 'chapter', 'resource'])
            .describe('Category of the ancillary file'),
    })
    .describe('UploadAncillaryResponse');
export type UploadAncillaryResponse = z.infer<typeof UploadAncillaryResponseSchema>;

export const UploadAttachmentTargetsSchema = z.object({
    status: z.enum(['pending', 'ready', 'ambiguous', 'failed']),
    targets: z.array(
        z.object({
            id: z.uuid(),
            title: z.string(),
            seasonNumber: z.number().int().optional(),
            episodeNumber: z.number().int().optional(),
        }),
    ),
    targetId: z
        .uuid()
        .optional()
        .describe('The explicit upload target or sole unambiguous ingest result.'),
});
export type UploadAttachmentTargets = z.infer<typeof UploadAttachmentTargetsSchema>;
