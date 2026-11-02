// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { createTaskCatalog, parseTaskCatalog, PLUGIN_CONTRACT_KINDS } from './catalog.js';

const task = defineTask({
    id: 'fixture-task',
    name: 'Fixture',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.1.0',
    resourceClass: 'io',
    capabilities: { http: true, allowedDomains: ['example.org'], database: true },
    inputSchema: z.object({ id: z.string() }),
    identityFor: (input) => input.id,
    manualOnly: true,
    async execute() {
        return { success: true, itemsProcessed: 0 };
    },
});

describe('normalized task catalog', () => {
    it('retains ABI and all eleven plugin contract placements while serializing no SDK context or functions', () => {
        const catalog = createTaskCatalog([task]);
        expect(catalog.sdkAbi).toBe(1);
        expect(PLUGIN_CONTRACT_KINDS).toHaveLength(11);
        expect(catalog.tasks[0]).toMatchObject({
            id: task.id,
            isolation: 'inline',
            capabilities: task.capabilities,
            inputValidation: 'typescript-sdk',
        });
        expect(JSON.stringify(catalog)).not.toMatch(/execute|inputSchema|secrets|sql/);
    });
    it('detaches manifests, sorts tasks and revisions by content instead of registration order', () => {
        const another = { ...task, id: 'another-task' };
        expect(createTaskCatalog([task, another])).toEqual(createTaskCatalog([another, task]));
        const catalog = createTaskCatalog([task]);
        catalog.tasks[0].capabilities.allowedDomains?.push('changed.example');
        expect(task.capabilities.allowedDomains).toEqual(['example.org']);
        expect(createTaskCatalog([{ ...task, processingVersion: 2 }]).revision).not.toBe(
            createTaskCatalog([task]).revision,
        );
        expect(() => createTaskCatalog([task, task])).toThrow('Duplicate');
    });
    it('preserves isolation, dependency policies and host-owned predicates without serializing functions', () => {
        const catalog = createTaskCatalog([
            {
                ...task,
                isolation: 'worker',
                pipeline: { of: 'fixture', after: ['parent'], when: () => true },
            },
        ]);
        expect(catalog.tasks[0]).toMatchObject({
            isolation: 'worker',
            pipeline: { of: 'fixture', after: ['parent'], conditional: true },
        });
    });
    it('rejects unknown catalog versions, ABI mismatches and content changes under an old revision', () => {
        const catalog = createTaskCatalog([task]);
        expect(parseTaskCatalog(catalog)).toEqual(catalog);
        expect(() => parseTaskCatalog({ ...catalog, version: 2 })).toThrow();
        expect(() => parseTaskCatalog({ ...catalog, sdkAbi: 2 })).toThrow();
        expect(() =>
            parseTaskCatalog({
                ...catalog,
                tasks: [{ ...catalog.tasks[0], processingVersion: 2 }],
            }),
        ).toThrow('revision mismatch');
    });
});
