// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('Kubernetes application credential boundary', () => {
    it.each(['web', 'worker'])('%s does not mount a Kubernetes API credential', (role) => {
        const manifests = parseAllDocuments(readFileSync(`deploy/k8s/${role}.yaml`, 'utf8'));
        const deployment = manifests.find((doc) => doc.get('kind') === 'Deployment');
        expect(deployment).toBeDefined();
        expect(
            deployment?.getIn(['spec', 'template', 'spec', 'automountServiceAccountToken']),
        ).toBe(false);
    });
});
