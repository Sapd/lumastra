// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** The same valid task, but requesting worker isolation. */
export const task = {
    id: 'sample-plugin',
    name: 'Sample Plugin',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'maintenance',
    capabilities: {},
    isolation: 'worker',
    identityFor: () => 'global',
    inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
    execute: async () => ({ ok: true }),
};
export default task;
