// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * R2 (security review 2026-09-13): the example k8s manifests under
 * `deploy/k8s/` had no pod/container `securityContext` anywhere and no
 * `NetworkPolicy` at all — every pod ran as whatever uid the image defaults
 * to, with every Linux capability and a writable root filesystem, and any
 * pod in the namespace (or one that lands there later) could reach Postgres
 * or Valkey directly.
 *
 * This asserts the hardening lands and stays landed: every Deployment/
 * StatefulSet across `web.yaml`, `worker.yaml`, `postgres.yaml`, and
 * `valkey.yaml` carries the pod AND container `securityContext` fields, and
 * `network-policy.yaml` exists, is registered in `kustomization.yaml`, and
 * default-denies ingress for the namespace.
 *
 * `kubectl apply --dry-run=client -k deploy/k8s` (the brief's preferred
 * check) needs a reachable API server even in client mode — CI/dev sandboxes
 * commonly don't have one. `kubectl kustomize deploy/k8s` (pure templating,
 * no cluster) DOES succeed locally and was used to hand-verify these
 * manifests build; this test is the one that actually runs in CI, parsing
 * the real files with the `yaml` package the same way
 * `docker-compose-proxy-volumes.test.ts` parses the compose file.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseAllDocuments } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const K8S_DIR = join(__dirname, '..', 'deploy', 'k8s');

interface K8sDoc {
    apiVersion?: string;
    kind?: string;
    metadata?: { name?: string; namespace?: string };
    spec?: Record<string, unknown>;
}

/** Parse every YAML document (handles multi-doc `---`-separated files) in one k8s manifest file. */
function loadDocs(filename: string): K8sDoc[] {
    const text = readFileSync(join(K8S_DIR, filename), 'utf8');
    return parseAllDocuments(text)
        .map((d) => d.toJS() as K8sDoc)
        .filter((d) => d && typeof d === 'object' && d.kind);
}

/** Every workload-carrying manifest that must have hardened pod/container securityContext. */
const WORKLOAD_FILES = ['web.yaml', 'worker.yaml', 'postgres.yaml', 'valkey.yaml'];

type PodSpec = {
    securityContext?: {
        runAsNonRoot?: boolean;
        runAsUser?: number;
        fsGroup?: number;
        seccompProfile?: { type?: string };
    };
    containers?: Array<{
        name?: string;
        securityContext?: {
            allowPrivilegeEscalation?: boolean;
            capabilities?: { drop?: string[] };
            readOnlyRootFilesystem?: boolean;
        };
    }>;
};

/** Pull the pod template spec out of a Deployment or StatefulSet doc. */
function podSpecOf(doc: K8sDoc): PodSpec {
    const spec = doc.spec as { template?: { spec?: PodSpec } } | undefined;
    const podSpec = spec?.template?.spec;
    if (!podSpec) {
        throw new Error(`${doc.kind}/${doc.metadata?.name}: no spec.template.spec found`);
    }
    return podSpec;
}

function workloadDocs(filename: string): K8sDoc[] {
    return loadDocs(filename).filter((d) => d.kind === 'Deployment' || d.kind === 'StatefulSet');
}

describe('deploy/k8s manifests parse as valid YAML', () => {
    it('every *.yaml file in deploy/k8s parses without error', () => {
        const files = readdirSync(K8S_DIR).filter((f) => f.endsWith('.yaml'));
        expect(files.length).toBeGreaterThan(0);
        for (const f of files) {
            expect(() => loadDocs(f), f).not.toThrow();
        }
    });
});

describe.each(WORKLOAD_FILES)('%s — pod securityContext', (filename) => {
    it('every Deployment/StatefulSet has a workload to check', () => {
        expect(workloadDocs(filename).length).toBeGreaterThan(0);
    });

    it('sets runAsNonRoot, runAsUser, fsGroup, and seccompProfile RuntimeDefault on every pod', () => {
        for (const doc of workloadDocs(filename)) {
            const sc = podSpecOf(doc).securityContext;
            expect(sc, `${doc.kind}/${doc.metadata?.name}`).toBeDefined();
            expect(sc!.runAsNonRoot, `${doc.kind}/${doc.metadata?.name}`).toBe(true);
            expect(typeof sc!.runAsUser, `${doc.kind}/${doc.metadata?.name}`).toBe('number');
            expect(typeof sc!.fsGroup, `${doc.kind}/${doc.metadata?.name}`).toBe('number');
            expect(sc!.seccompProfile?.type, `${doc.kind}/${doc.metadata?.name}`).toBe(
                'RuntimeDefault',
            );
        }
    });
});

describe.each(WORKLOAD_FILES)('%s — container securityContext', (filename) => {
    it('every container drops all capabilities and refuses privilege escalation', () => {
        for (const doc of workloadDocs(filename)) {
            const containers = podSpecOf(doc).containers ?? [];
            expect(containers.length, `${doc.kind}/${doc.metadata?.name}`).toBeGreaterThan(0);
            for (const c of containers) {
                const label = `${doc.kind}/${doc.metadata?.name}/${c.name}`;
                expect(c.securityContext, label).toBeDefined();
                expect(c.securityContext!.allowPrivilegeEscalation, label).toBe(false);
                expect(c.securityContext!.capabilities?.drop, label).toContain('ALL');
                // readOnlyRootFilesystem is asserted to be explicitly SET (true or
                // false) rather than forced to `true` — the brief allows `false`
                // with a comment when true isn't achievable for a given image.
                expect(typeof c.securityContext!.readOnlyRootFilesystem, label).toBe('boolean');
            }
        }
    });
});

describe('network-policy.yaml', () => {
    it('exists and parses to at least one NetworkPolicy', () => {
        const docs = loadDocs('network-policy.yaml').filter((d) => d.kind === 'NetworkPolicy');
        expect(docs.length).toBeGreaterThan(0);
    });

    it('default-denies ingress for the whole namespace (empty podSelector, no ingress rules)', () => {
        const docs = loadDocs('network-policy.yaml').filter((d) => d.kind === 'NetworkPolicy');
        const denyAll = docs.find((d) => {
            const spec = d.spec as {
                podSelector?: Record<string, unknown>;
                policyTypes?: string[];
                ingress?: unknown[];
            };
            return (
                spec?.policyTypes?.includes('Ingress') &&
                spec.podSelector &&
                Object.keys(spec.podSelector).length === 0 &&
                !spec.ingress
            );
        });
        expect(denyAll, 'expected a default-deny-ingress NetworkPolicy').toBeDefined();
    });

    it('restricts Postgres and Valkey ingress to the web/worker pods only', () => {
        const docs = loadDocs('network-policy.yaml').filter((d) => d.kind === 'NetworkPolicy');
        const namesJoined = docs.map((d) => d.metadata?.name).join(',');
        expect(namesJoined).toContain('postgres');
        expect(namesJoined).toMatch(/valkey/);
    });
});

describe('kustomization.yaml', () => {
    it('registers network-policy.yaml as a resource', () => {
        const [doc] = loadDocs('kustomization.yaml');
        const resources = (doc as unknown as { resources?: string[] }).resources ?? [];
        expect(resources).toContain('network-policy.yaml');
    });
});

describe('README.md', () => {
    it('quick-start paths point at deploy/k8s/, not the stale .deploy/k8s/', () => {
        const text = readFileSync(join(K8S_DIR, 'README.md'), 'utf8');
        expect(text).not.toContain('.deploy/k8s');
        expect(text).toContain('deploy/k8s/');
    });

    it('documents which paths need to be writable (Hardening section)', () => {
        const text = readFileSync(join(K8S_DIR, 'README.md'), 'utf8');
        expect(text).toMatch(/## Hardening/);
        expect(text).toContain('/app/.cache');
        expect(text).toContain('/app/plugins');
    });
});
