// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A VALID minimal task, as the SDK defines valid.
 *
 * Every field here is required by `defineTask`, which the loader now runs over
 * external plugins (b5d7ab8eb). This fixture used to be `{ id, kind,
 * inputSchema, execute }` — a shape no real plugin could ever have had, since
 * the registry's own startup sweep would have rejected it. It only loaded
 * because nothing validated it on the way in.
 *
 * `inputSchema` is duck-typed rather than a real Zod schema: the validator
 * checks for `.parse`/`.safeParse`, and a fixture must not drag zod into a
 * file that gets copied into a plugin bundle.
 */
export const task = {
    id: 'sample-plugin',
    name: 'Sample Plugin',
    version: '1.0.0',
    processingVersion: 1,
    resourceClass: 'maintenance',
    capabilities: {},
    identityFor: () => 'global',
    inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
    execute: async () => ({ ok: true }),
};
export default task;
