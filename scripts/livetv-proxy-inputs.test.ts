// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
    collectProxyInputs,
    fsReader,
    gitBlobId,
    proxyBuildId,
    type InputReader,
} from './livetv-proxy-inputs.mjs';
import { compareProxyInputs } from './livetv-proxy-changes.mjs';
function tree(files: Record<string, string>): InputReader {
    return {
        list: (dir) => Object.keys(files).filter((file) => file.startsWith(`${dir}/`)),
        read: (file) => (file in files ? Buffer.from(files[file]) : null),
    };
}
const base = {
    'native/livetv-proxy/src/main.rs': 'fn main() {}',
    'native/livetv-proxy/Cargo.toml': '[package]',
    'native/rust-toolchain.toml': '1.99.1',
    'scripts/native.mjs': '// native builder',
    'scripts/build-proxy-metadata.mjs': '// metadata',
    'src/shared/livetv-proxy-protocol.ts': 'export const LIVETV_PROXY_PROTOCOL = 1;',
    'src/shared/livetv-proxy-types.ts': 'export interface ProxyStatus {}',
};
describe('Rust proxy fingerprint and release comparisons', () => {
    it('includes native code, build scripts and wire contracts, excludes web code and fixtures', () => {
        const inputs = collectProxyInputs(fsReader(resolve('.')));
        expect(inputs).toContain('native/livetv-proxy/src/runtime_server.rs');
        expect(inputs).toContain('src/shared/livetv-proxy-types.ts');
        expect(inputs).toContain('src/shared/livetv-proxy-protocol.ts');
        expect(inputs).toContain('scripts/build-proxy-metadata.mjs');
        expect(inputs).toContain('deploy/docker/start-proxy.sh');
        expect(inputs.some((file) => /src\/lib\/|__tests__|\/tests\/|\/target\//.test(file))).toBe(
            false,
        );
    });
    it('changes for native code and protocol changes, not for web or test-only edits', () => {
        const original = proxyBuildId(tree(base));
        expect(original).toMatch(/^[0-9a-f]{16}$/);
        expect(
            proxyBuildId(tree({ ...base, 'native/livetv-proxy/src/main.rs': 'changed' })),
        ).not.toBe(original);
        expect(
            proxyBuildId(
                tree({
                    ...base,
                    'native/livetv-proxy/tests/example.rs': 'test',
                    'src/shared/web-only.ts': 'web',
                }),
            ),
        ).toBe(original);
    });
    it('still detects retiring the old implementation when comparing older releases', () => {
        const legacy = {
            ...base,
            'src/stream-proxy/index.ts': "import './server.js';",
            'src/stream-proxy/server.ts': 'old',
            'scripts/build-stream-proxy.ts': 'old builder',
        };
        expect(compareProxyInputs(tree(legacy), tree(base))).toMatchObject({ needed: true });
        expect(compareProxyInputs(tree(legacy), tree(base)).changed).toContain(
            'src/stream-proxy/index.ts',
        );
        expect(compareProxyInputs(tree(base), tree(base)).needed).toBe(false);
    });
    it('fails for the wrong repository prefix instead of claiming no update is needed', () => {
        expect(() => compareProxyInputs(tree({}), tree(base))).toThrow('no Live TV proxy sources');
    });
    it('uses Git blob identities', () => {
        expect(gitBlobId(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    });
});
