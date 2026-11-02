// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Optional `{ stageId }` body of the per-item pipeline verbs (retry,
 * re-evaluate). No body means "every stage of this item"; anything else must
 * name a stage.
 *
 * Both handlers used to swallow a parse failure into the no-body case, so a
 * malformed body or a typo (`stage_id`) quietly retried or re-evaluated EVERY
 * stage of the item — a destructive operator action from an invalid request.
 */

import { ApiProblem } from '$lib/server/api/problem.js';

const MAX_STAGE_ID_LENGTH = 128;

export type StageBody =
    { ok: true; stageId: string | undefined } | { ok: false; response: Response };

export async function readStageBody(request: Request): Promise<StageBody> {
    const text = await request.text();
    if (text.trim() === '') return { ok: true, stageId: undefined };

    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return { ok: false, response: ApiProblem.validationFailed('Body must be JSON') };
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, response: ApiProblem.validationFailed('Body must be a JSON object') };
    }
    const record = body as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key) => key !== 'stageId');
    if (unknownKeys.length > 0) {
        return {
            ok: false,
            response: ApiProblem.validationFailed(`Unknown field: ${unknownKeys.join(', ')}`),
        };
    }
    if (record.stageId === undefined || record.stageId === null) {
        return { ok: true, stageId: undefined };
    }
    const stageId = typeof record.stageId === 'string' ? record.stageId.trim() : '';
    if (!stageId || stageId.length > MAX_STAGE_ID_LENGTH) {
        return {
            ok: false,
            response: ApiProblem.validationFailed(
                `stageId must be a non-empty string of at most ${MAX_STAGE_ID_LENGTH} characters`,
            ),
        };
    }
    return { ok: true, stageId };
}
