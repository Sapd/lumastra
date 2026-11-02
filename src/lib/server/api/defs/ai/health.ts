// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/ai/health.ts — GET /api/ai
 *
 * AI health-check endpoint: verifies DB + embedding connectivity.
 * Internal surface only — dashboard polling, not a v1 public contract.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AIHealth');

type AIHealthResponse = {
    status: string;
    services: { database: string; openai: string };
    ready: boolean;
};

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    handlers: {
        GET: async () => {
            try {
                logger.info('Starting AI health check');

                const { testDbConnection } = await import('$lib/server/database');
                const { testEmbeddingConnection } = await import('$lib/server/ai/openai');

                logger.info('Testing database connection');
                const dbHealth = await testDbConnection();
                logger.info('Database connection result', { connected: dbHealth });

                logger.info('Testing embedding connection');
                const openaiHealth = await testEmbeddingConnection();
                logger.info('Embedding connection result', { connected: openaiHealth });

                const body: AIHealthResponse = {
                    status: 'ok',
                    services: {
                        database: dbHealth ? 'connected' : 'disconnected',
                        openai: openaiHealth ? 'connected' : 'disconnected',
                    },
                    ready: dbHealth && openaiHealth,
                };
                return json(body);
            } catch (error) {
                logger.error('AI health check failed', error as Error);
                return ApiProblem.dependencyUnavailable('AI service unavailable');
            }
        },
    },
});
