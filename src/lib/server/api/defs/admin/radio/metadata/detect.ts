// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/radio/metadata/detect.ts
 *
 * POST /api/admin/radio/metadata/detect
 *   Fetches the admin-provided metadata URL and runs the heuristic field
 *   detector for JSON responses, or returns the raw text for regex responses.
 *   Station-less, so the create form can map fields before the station exists.
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * POST response (json format):  bare object { format, contentType, rawResponse, proposedPaths, detectionConfidence, allLeafPaths }
 * POST response (regex format): bare object { format, contentType, rawResponse }
 * 422  validation_failed on fetch/parse error.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { fetchMetadataUrl, detectFields } from '$lib/server/services/radio-metadata/index.js';

// ── request schema ────────────────────────────────────────────────────────────

const DetectBodySchema = z.object({
    url: z.string().url(),
    format: z.enum(['json', 'regex']).default('json'),
    timeoutMs: z.number().int().min(500).max(15000).optional(),
    userAgent: z.string().max(200).optional(),
});

// ── response schemas ──────────────────────────────────────────────────────────

const DetectJsonResponseSchema = z.object({
    format: z.literal('json'),
    contentType: z.string(),
    rawResponse: z.unknown(),
    proposedPaths: z.record(z.string(), z.string()),
    detectionConfidence: z.record(z.string(), z.number()),
    allLeafPaths: z.array(z.string()),
});

const DetectRegexResponseSchema = z.object({
    format: z.literal('regex'),
    contentType: z.string(),
    rawResponse: z.string(),
});

// ── def ───────────────────────────────────────────────────────────────────────

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: DetectBodySchema,
    },
    handlers: {
        POST: async (event) => {
            let body: z.infer<typeof DetectBodySchema>;
            try {
                const raw: unknown = await event.request.json();
                const parsed = DetectBodySchema.safeParse(raw);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: i.path.join('.'),
                            message: i.message,
                        })),
                    );
                }
                body = parsed.data;
            } catch {
                return ApiProblem.validationFailed('Invalid JSON body');
            }

            try {
                const { text, contentType } = await fetchMetadataUrl(body.url, {
                    timeoutMs: body.timeoutMs,
                    userAgent: body.userAgent,
                });

                if (body.format === 'json') {
                    const parsed = JSON.parse(text) as unknown;
                    const detection = detectFields(parsed);
                    return json(
                        DetectJsonResponseSchema.parse({
                            format: 'json',
                            contentType,
                            rawResponse: parsed,
                            proposedPaths: detection.jsonPaths,
                            detectionConfidence: detection.confidence,
                            allLeafPaths: detection.allLeafPaths,
                        }),
                    );
                }

                return json(
                    DetectRegexResponseSchema.parse({
                        format: 'regex',
                        contentType,
                        rawResponse: text.slice(0, 8192),
                    }),
                );
            } catch (err) {
                return ApiProblem.validationFailed(
                    `Detect failed: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
    },
});
