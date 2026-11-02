// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { STATUS_FOR_CODE } from '../../src/lib/server/api/problem.js';
import { PROBLEM_CODES } from './helpers.js';

describe('OpenAPI problem code taxonomy', () => {
    it('lists exactly the runtime ProblemCode values in the generated spec enum', () => {
        // STATUS_FOR_CODE is typed Record<ProblemCode, number>, so its keys are the
        // runtime view of the ProblemCode union.
        const runtime = new Set(Object.keys(STATUS_FOR_CODE));
        const spec = new Set<string>(PROBLEM_CODES);

        const missingFromSpec = [...runtime].filter((code) => !spec.has(code)).sort();
        const extraInSpec = [...spec].filter((code) => !runtime.has(code)).sort();

        expect(missingFromSpec, 'runtime codes missing from PROBLEM_CODES').toEqual([]);
        expect(extraInSpec, 'PROBLEM_CODES entries the runtime does not send').toEqual([]);
        expect(PROBLEM_CODES.length).toBe(spec.size);
    });
});
