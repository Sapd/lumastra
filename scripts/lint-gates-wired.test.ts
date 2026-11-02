// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verify that supply-chain guards are wired into the CI command surface.
 * Public workflows live with the application; a parent workflow directory
 * is checked when available.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAllDocuments } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_TYPECHECK_WORKFLOW = join(
    __dirname,
    '..',
    '..',
    '.github',
    'workflows',
    'typecheck.yml',
);

interface WorkflowStep {
    name?: string;
    run?: string;
}
interface WorkflowJob {
    steps?: WorkflowStep[];
}
interface WorkflowDoc {
    jobs?: Record<string, WorkflowJob>;
}

function loadWorkflow(): WorkflowDoc {
    const text = readFileSync(ROOT_TYPECHECK_WORKFLOW, 'utf8');
    return parseAllDocuments(text)[0].toJS() as WorkflowDoc;
}

/** Every `run:` string across every job/step in the workflow. */
function allRunCommands(doc: WorkflowDoc): string[] {
    const commands: string[] = [];
    for (const job of Object.values(doc.jobs ?? {})) {
        for (const step of job.steps ?? []) {
            if (step.run) commands.push(step.run);
        }
    }
    return commands;
}

// Private-layout only: the public tree has the app at its root and no `../.github`.
describe.skipIf(!existsSync(ROOT_TYPECHECK_WORKFLOW))('CI runs the supply-chain lint gates', () => {
    it('parses as valid YAML with at least one job', () => {
        const doc = loadWorkflow();
        expect(Object.keys(doc.jobs ?? {}).length).toBeGreaterThan(0);
    });

    it('has a step that runs BOTH lint:actions and lint:dockerfile-fetches', () => {
        const doc = loadWorkflow();
        const commands = allRunCommands(doc);
        const gateStep = commands.find(
            (cmd) => cmd.includes('lint:actions') && cmd.includes('lint:dockerfile-fetches'),
        );
        expect(
            gateStep,
            'expected one step running `npm run lint:actions && npm run lint:dockerfile-fetches`',
        ).toBeDefined();
    });

    it('keeps supply-chain gates separate from the full-lint step', () => {
        const doc = loadWorkflow();
        const commands = allRunCommands(doc);
        // The full-lint step must still be its own, separate, unmodified
        // invocation — see check-actions-pinned.mjs's header for why these
        // two guards must stay out of that chain.
        const fullLintStep = commands.find((cmd) => /\bnpm run lint\b(?!:)/.test(cmd));
        expect(fullLintStep, 'expected an `npm run lint` step to still exist').toBeDefined();
        expect(fullLintStep).not.toContain('lint:actions');
        expect(fullLintStep).not.toContain('lint:dockerfile-fetches');
    });

    // P1 fix-round-1 Important 4: workers/sonic-embedder/embed_test.py (the
    // CLAP-weights revision+digest pin regression guard) had no npm script,
    // no package.json entry, and no CI step — vitest's include globs
    // (vitest.config.ts) don't pick up .py files, so it ran nowhere. That is
    // the exact defect C20 exists to fix, just for a Python guard instead of
    // the two Node ones above.
    it('has a step that runs the sonic sidecar model-pin regression tests (embed_test.py, P1)', () => {
        const doc = loadWorkflow();
        const commands = allRunCommands(doc);
        const pyTestStep = commands.find(
            (cmd) => cmd.includes('unittest') && cmd.includes('embed_test'),
        );
        expect(
            pyTestStep,
            'expected a step running `python3 -m unittest embed_test` (or equivalent)',
        ).toBeDefined();
    });
});
