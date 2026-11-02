// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenAI Batch Embeddings API Integration
// 50% cost reduction for bulk embedding generation

import OpenAI from 'openai';
import { withExternalCallCounting } from '../utils/external-request-counter.js';
import { guardedDefaultFetch } from '../utils/fetch-utils.js';
import { writeFile, readFile, unlink, mkdtemp, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LibraryMediaData, JellyseerrMovieData } from './dual-embedding-generator';
import { Logger } from '../utils/logger';
import { getAiConfig } from '../config/domains/ai.js';
import { isRecord } from '$lib/utils/data-extraction';
import type { EmbeddingSource } from '$lib/server/utils/embedding-source';

const logger = Logger.for('BatchEmbeddings');
const isNumberArray = (value: unknown): value is number[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'number');
const toArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const toBatchStatus = (value: unknown): BatchJobProgress['status'] => {
    const allowed: BatchJobProgress['status'][] = [
        'validating',
        'in_progress',
        'finalizing',
        'completed',
        'failed',
        'expired',
        'cancelling',
        'cancelled',
    ];
    return typeof value === 'string' && allowed.includes(value as BatchJobProgress['status'])
        ? (value as BatchJobProgress['status'])
        : 'failed';
};

// Re-export OpenAI for external usage
export { OpenAI };

// Cached per key+endpoint so a saved change builds a new client.
let openai: { key: string; client: OpenAI } | null = null;

/**
 * Get OpenAI client (supports custom endpoints)
 */
function getOpenAI(): OpenAI | null {
    const ai = getAiConfig();
    if (!ai.openaiApiKey) {
        logger.warn('OPENAI_API_KEY not set - batch embeddings disabled');
        return null;
    }

    const cacheKey = `${ai.openaiApiKey}|${ai.openaiBaseUrl ?? ''}`;
    if (openai?.key !== cacheKey) {
        try {
            const options: { apiKey: string; baseURL?: string; fetch: typeof fetch } = {
                fetch: withExternalCallCounting(guardedDefaultFetch, 'openai'),
                apiKey: ai.openaiApiKey,
            };
            // Support custom OpenAI-compatible endpoints
            if (ai.openaiBaseUrl) {
                options.baseURL = ai.openaiBaseUrl;
            }
            openai = { key: cacheKey, client: new OpenAI(options) };
        } catch (error) {
            logger.warn('OpenAI initialization failed', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    return openai.client;
}

/**
 * Batch embedding request item
 */
export interface BatchEmbeddingRequest {
    id: string; // Custom ID to track this item
    text: string; // Text to embed
    metadata?: {
        tmdbId: number;
        title: string;
        type: EmbeddingSource;
        mediaData: LibraryMediaData | JellyseerrMovieData;
    };
}

/**
 * Batch embedding result
 */
export interface BatchEmbeddingResult {
    id: string;
    embedding: number[];
    metadata?: BatchEmbeddingRequest['metadata'];
    error?: string;
}

/**
 * Batch job progress
 */
export interface BatchJobProgress {
    id: string;
    status:
        | 'validating'
        | 'in_progress'
        | 'finalizing'
        | 'completed'
        | 'failed'
        | 'expired'
        | 'cancelling'
        | 'cancelled';
    requestCounts: {
        total: number;
        completed: number;
        failed: number;
    };
    metadata: {
        created_at: number;
        completion_window: string;
        endpoint: string;
    };
}

/**
 * Create a batch embedding job
 */
export async function createBatchEmbeddingJob(
    requests: BatchEmbeddingRequest[],
    options: {
        model?: string;
        completionWindow?: '24h';
        description?: string;
    } = {},
): Promise<{ batchId: string; inputFileId: string } | null> {
    const client = getOpenAI();
    if (!client) return null;

    if (requests.length === 0) {
        logger.warn('No requests provided for batch');
        return null;
    }

    // OpenAI batch API limits: max 50,000 requests per batch, ~100MB file size
    // Conservative limit: 10,000 requests to stay well under file size limit
    if (requests.length > 10000) {
        logger.warn('Too many requests for single batch (max 10,000), use chunking', {
            count: requests.length,
        });
        return null;
    }

    try {
        logger.info('Creating batch job', { requestCount: requests.length });

        // Create JSONL content
        const jsonlLines = requests.map((req) =>
            JSON.stringify({
                custom_id: req.id,
                method: 'POST',
                url: '/v1/embeddings',
                body: {
                    model: options.model || 'text-embedding-3-small',
                    input: req.text,
                    encoding_format: 'float',
                },
            }),
        );

        const jsonlContent = jsonlLines.join('\n');

        // Create temporary file
        const tempFileName = `batch_embeddings_${Date.now()}.jsonl`;
        const tempDir = await mkdtemp(join(tmpdir(), 'batch_embeddings_'));
        const tempFilePath = join(tempDir, tempFileName);
        await writeFile(tempFilePath, jsonlContent, 'utf8');

        // Upload file to OpenAI
        logger.info('Uploading batch file', { requestCount: requests.length });
        const file = await client.files.create({
            file: new File([await readFile(tempFilePath)], tempFileName, {
                type: 'application/jsonl',
            }),
            purpose: 'batch',
        });

        // Clean up temp file
        await unlink(tempFilePath);
        await rmdir(tempDir).catch(() => {});

        // Create batch job
        logger.info('Creating batch job with uploaded file', {
            fileId: file.id,
        });
        const batch = await client.batches.create({
            input_file_id: file.id,
            endpoint: '/v1/embeddings',
            completion_window: options.completionWindow || '24h',
            metadata: {
                description:
                    options.description ||
                    `Batch embeddings job created at ${new Date().toISOString()}`,
                total_requests: requests.length.toString(),
            },
        });

        logger.info('Batch job created successfully', {
            batchId: batch.id,
            costSavings: '~50%',
        });

        return {
            batchId: batch.id,
            inputFileId: file.id,
        };
    } catch (error) {
        logger.error('Failed to create batch job', error as Error);
        return null;
    }
}

/**
 * Check batch job progress
 */
export async function getBatchJobProgress(batchId: string): Promise<BatchJobProgress | null> {
    const client = getOpenAI();
    if (!client) return null;

    try {
        const batch = await client.batches.retrieve(batchId);

        return {
            id: batch.id,
            status: toBatchStatus(batch.status),
            requestCounts: {
                total: batch.request_counts?.total || 0,
                completed: batch.request_counts?.completed || 0,
                failed: batch.request_counts?.failed || 0,
            },
            metadata: {
                created_at: batch.created_at,
                completion_window: batch.completion_window,
                endpoint: batch.endpoint,
            },
        };
    } catch (error) {
        logger.error('Failed to get batch progress', error as Error, {
            batchId,
        });
        return null;
    }
}

/**
 * Retrieve batch results when completed
 */
export async function getBatchResults(batchId: string): Promise<BatchEmbeddingResult[] | null> {
    const client = getOpenAI();
    if (!client) return null;

    try {
        const batch = await client.batches.retrieve(batchId);

        if (batch.status !== 'completed') {
            logger.info('Batch not completed yet', {
                batchId,
                status: batch.status,
            });
            return null;
        }

        if (!batch.output_file_id) {
            logger.error('No output file for completed batch', undefined, {
                batchId,
            });
            return null;
        }

        logger.info('Downloading results for batch', { batchId });

        // Download the output file
        const outputFile = await client.files.content(batch.output_file_id);
        const outputContent = await outputFile.text();

        // Parse JSONL results
        const results: BatchEmbeddingResult[] = [];
        const lines = outputContent.trim().split('\n');

        for (const line of lines) {
            try {
                const result: unknown = JSON.parse(line);
                if (!isRecord(result)) {
                    continue;
                }

                const customId =
                    typeof result.custom_id === 'string' ? result.custom_id : undefined;
                if (!customId) {
                    continue;
                }

                if (isRecord(result.error)) {
                    const errorMessage =
                        typeof result.error.message === 'string'
                            ? result.error.message
                            : 'Unknown error';
                    results.push({
                        id: customId,
                        embedding: [],
                        error: errorMessage,
                    });
                } else {
                    const response = isRecord(result.response) ? result.response : undefined;
                    const body = response && isRecord(response.body) ? response.body : undefined;
                    const data = toArray(body?.data);
                    const first = data[0];
                    const embedding =
                        isRecord(first) && isNumberArray(first.embedding) ? first.embedding : [];
                    results.push({
                        id: customId,
                        embedding,
                    });
                }
            } catch (parseError) {
                logger.warn('Failed to parse result line', {
                    error: parseError instanceof Error ? parseError.message : String(parseError),
                });
            }
        }

        logger.info('Retrieved batch results', {
            batchId,
            resultCount: results.length,
        });
        return results;
    } catch (error) {
        logger.error('Failed to get batch results', error as Error, {
            batchId,
        });
        return null;
    }
}

/**
 * Cancel a batch job
 */
export async function cancelBatchJob(batchId: string): Promise<boolean> {
    const client = getOpenAI();
    if (!client) return false;

    try {
        await client.batches.cancel(batchId);
        logger.info('Cancelled batch job', { batchId });
        return true;
    } catch (error) {
        logger.error('Failed to cancel batch', error as Error, { batchId });
        return false;
    }
}

/**
 * List all batch jobs
 */
export async function listBatchJobs(limit: number = 10): Promise<BatchJobProgress[]> {
    const client = getOpenAI();
    if (!client) return [];

    try {
        const batches = await client.batches.list({ limit });

        return batches.data.map((batch) => ({
            id: batch.id,
            status: toBatchStatus(batch.status),
            requestCounts: {
                total: batch.request_counts?.total || 0,
                completed: batch.request_counts?.completed || 0,
                failed: batch.request_counts?.failed || 0,
            },
            metadata: {
                created_at: batch.created_at,
                completion_window: batch.completion_window,
                endpoint: batch.endpoint,
            },
        }));
    } catch (error) {
        logger.error('Failed to list batch jobs', error as Error);
        return [];
    }
}

/**
 * Create multiple batch jobs for very large datasets
 */
export async function createChunkedBatchJobs(
    requests: BatchEmbeddingRequest[],
    options: {
        model?: string;
        completionWindow?: '24h';
        description?: string;
        chunkSize?: number; // Default: 8000 items per batch
    } = {},
): Promise<Array<{ batchId: string; inputFileId: string; chunkIndex: number }>> {
    const chunkSize = options.chunkSize || 8000;
    const chunks = [];
    const results = [];

    // Split requests into chunks
    for (let i = 0; i < requests.length; i += chunkSize) {
        chunks.push(requests.slice(i, i + chunkSize));
    }

    logger.info('Creating chunked batch jobs', {
        chunkCount: chunks.length,
        totalRequests: requests.length,
    });

    // Create batch jobs for each chunk
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const batch = await createBatchEmbeddingJob(chunk, {
            ...options,
            description: `${options.description || 'Chunked batch embeddings'} (chunk ${i + 1}/${chunks.length})`,
        });

        if (batch) {
            results.push({
                ...batch,
                chunkIndex: i,
            });
        }

        // Rate limiting between batch creations
        if (i < chunks.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    return results;
}

/**
 * Smart embedding generator that chooses batch vs real-time based on size
 */
export async function generateEmbeddingsSmartly(
    requests: BatchEmbeddingRequest[],
    options: {
        batchThreshold?: number; // Default: 500 items
        forceRealtime?: boolean;
        forceBatch?: boolean;
        enableChunking?: boolean; // Default: true
    } = {},
): Promise<{
    mode: 'realtime' | 'batch' | 'chunked_batch';
    results?: BatchEmbeddingResult[];
    batchId?: string;
    batchIds?: string[];
    message: string;
}> {
    const threshold = options.batchThreshold || 500;
    const shouldUseBatch =
        options.forceBatch || (!options.forceRealtime && requests.length >= threshold);

    if (shouldUseBatch) {
        // Check if we need chunking for very large datasets
        if (options.enableChunking !== false && requests.length > 10000) {
            const batches = await createChunkedBatchJobs(requests);

            if (batches.length > 0) {
                return {
                    mode: 'chunked_batch',
                    batchIds: batches.map((b) => b.batchId),
                    message: `Created ${batches.length} batch jobs for ${requests.length} embeddings. Results available in up to 24 hours. 50% cost savings vs real-time.`,
                };
            } else {
                // Fallback to real-time
                logger.warn('Chunked batch creation failed, falling back to real-time');
                return generateRealtimeEmbeddings(requests);
            }
        } else {
            // Use single batch processing for cost savings
            const batch = await createBatchEmbeddingJob(requests);
            if (batch) {
                return {
                    mode: 'batch',
                    batchId: batch.batchId,
                    message: `Batch job created: ${batch.batchId}. Results available in up to 24 hours. 50% cost savings vs real-time.`,
                };
            } else {
                // Fallback to real-time
                logger.warn('Batch creation failed, falling back to real-time');
                return generateRealtimeEmbeddings(requests);
            }
        }
    } else {
        // Use real-time for immediate results
        return generateRealtimeEmbeddings(requests);
    }
}

/**
 * Real-time embedding generation (current approach)
 */
async function generateRealtimeEmbeddings(requests: BatchEmbeddingRequest[]): Promise<{
    mode: 'realtime';
    results: BatchEmbeddingResult[];
    message: string;
}> {
    const client = getOpenAI();
    if (!client) {
        return {
            mode: 'realtime',
            results: [],
            message: 'OpenAI client not available',
        };
    }

    const results: BatchEmbeddingResult[] = [];

    logger.info('Processing embeddings in real-time', {
        count: requests.length,
    });

    // Process in small batches to avoid rate limiting
    const batchSize = 100;
    for (let i = 0; i < requests.length; i += batchSize) {
        const batch = requests.slice(i, i + batchSize);

        const batchPromises = batch.map(async (req) => {
            try {
                const response = await client.embeddings.create({
                    model: 'text-embedding-3-small',
                    input: req.text,
                });

                return {
                    id: req.id,
                    embedding: response.data[0].embedding,
                    metadata: req.metadata,
                };
            } catch (error) {
                logger.warn('Failed to generate embedding', {
                    id: req.id,
                    error: error instanceof Error ? error.message : String(error),
                });
                return {
                    id: req.id,
                    embedding: [],
                    metadata: req.metadata,
                    error: (error as Error).message,
                };
            }
        });

        const batchResults = await Promise.allSettled(batchPromises);

        let rejectedCount = 0;
        let firstRejection: unknown;
        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                rejectedCount++;
                if (firstRejection === undefined) firstRejection = result.reason;
            }
        }
        if (rejectedCount > 0) {
            // Rejected entries used to be silently dropped — the caller saw
            // results.length < requests.length without any signal. Surface
            // the count so operators can spot real-time embedding
            // generation failure rates.
            logger.warn('batch-embeddings: rejected batch entries', {
                rejectedCount,
                batchSize: batchPromises.length,
                firstRejection:
                    firstRejection instanceof Error
                        ? firstRejection.message
                        : String(firstRejection),
            });
        }

        // Rate limiting pause
        if (i + batchSize < requests.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    logger.info('Generated real-time embeddings', { count: results.length });

    return {
        mode: 'realtime',
        results,
        message: `Generated ${results.length} embeddings in real-time`,
    };
}
