// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const files = [
    'src/lib/components/admin/plugins/ExternalPluginInstallForm.svelte',
    'src/lib/components/admin/plugins/ExternalPluginCard.svelte',
    'src/lib/components/admin/plugins/CapabilityBadges.svelte',
    'src/routes/admin/settings/plugins/+page.svelte',
];
describe('invariant 1: no trusted-key / gate-flag write path in the UI', () => {
    it.each(files)('%s never binds trusted-key material', (rel) => {
        const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
        // The UI may DISPLAY a signingKeyId, but must never provide an editable
        // field for the trusted-key set or a gate flag.
        expect(src).not.toMatch(/bind:value=\{[^}]*[Tt]rustedKey/);
        expect(src).not.toMatch(/PLUGIN_TRUSTED_KEYS\s*=/);
        expect(src).not.toContain('bind:value={config');
    });
});
