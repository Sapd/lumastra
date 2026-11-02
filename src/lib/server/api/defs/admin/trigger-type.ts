// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared validated cast for `playback_incident_events.trigger_type`.
 *
 * Both the list and detail handlers previously did an unchecked
 * `row.trigger_type as PlaybackIncidentSummary['triggerType']` before handing
 * the DTO to the response schema's `.parse()` — a row with any other stored
 * value threw INSIDE the handler, and only got turned into a generic 500 by
 * the mount-level error boundary rather than being handled as a clear
 * data-shape problem here.
 */

import { Logger } from '$lib/server/utils/logger.js';
import { ApiProblem } from '$lib/server/api/problem.js';

const logger = Logger.for('PlaybackIncidentTriggerType');

const TRIGGER_TYPES = ['error', 'reconnect', 'terminal'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

/** Thrown by {@link toTriggerType} on an unrecognized stored value; callers
 *  catch it and map it to a clean `internal_error` problem+json response. */
export class InvalidTriggerTypeError extends Error {
    constructor(readonly value: string) {
        super(`Unexpected playback_incident_events.trigger_type value: ${value}`);
        this.name = 'InvalidTriggerTypeError';
    }
}

export function toTriggerType(value: string): TriggerType {
    if ((TRIGGER_TYPES as readonly string[]).includes(value)) {
        return value as TriggerType;
    }
    throw new InvalidTriggerTypeError(value);
}

/** Map an {@link InvalidTriggerTypeError} to a problem+json response, or
 *  re-throw anything else so the mount-level error boundary still handles it. */
export function handleInvalidTriggerType(err: unknown): Response {
    if (err instanceof InvalidTriggerTypeError) {
        logger.error('playback_incident_events row has an unrecognized trigger_type', {
            value: err.value,
        });
        return ApiProblem.internalError('Incident has an unrecognized trigger type');
    }
    throw err;
}
