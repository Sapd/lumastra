// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App-to-docs links carry no tracking or version parameters: the path and an
 * optional anchor, nothing else.
 */

import { describe, expect, it } from 'vitest';
import { docsUrl, DOCS_ORIGIN, TASK_TROUBLESHOOTING } from './docs-url.js';

describe('docsUrl', () => {
    it('builds the plain page URL on the docs origin', () => {
        expect(docsUrl('guides/task-troubleshooting/')).toBe(
            'https://lumastra.org/guides/task-troubleshooting/',
        );
        expect(DOCS_ORIGIN).toBe('https://lumastra.org');
    });

    it('keeps the anchor and adds no query', () => {
        expect(docsUrl(TASK_TROUBLESHOOTING.stuckItems)).toBe(
            'https://lumastra.org/guides/task-troubleshooting/#recipe-1--stuck-items-panel-shows-entries',
        );
    });

    it('drops leading slashes so the origin is not doubled', () => {
        expect(docsUrl('/guides/task-troubleshooting/')).toBe(
            'https://lumastra.org/guides/task-troubleshooting/',
        );
    });

    it('never adds ref or v parameters', () => {
        for (const url of [
            docsUrl('guides/task-troubleshooting/'),
            docsUrl(TASK_TROUBLESHOOTING.queueNotDraining),
        ]) {
            expect(url).not.toContain('?');
            expect(url).not.toMatch(/[?&](ref|v)=/);
            expect(url).not.toContain('ref=app');
        }
    });
});
