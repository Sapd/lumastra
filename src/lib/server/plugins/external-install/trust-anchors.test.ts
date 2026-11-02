// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
    OFFICIAL_TRUSTED_KEY_ENTRIES,
    getOfficialTrustedKeys,
    buildEffectiveTrustedKeys,
    classifyKeyId,
} from './trust-anchors.js';
import { Logger } from '$lib/server/utils/logger.js';

/** Ephemeral Ed25519 keypair → { entry: 'keyId:spkiB64', priv }. Never a committed key. */
function makeEntry(keyId: string): { entry: string; priv: crypto.KeyObject; pubB64: string } {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    return { entry: `${keyId}:${pubB64}`, priv: privateKey, pubB64 };
}

describe('buildEffectiveTrustedKeys', () => {
    it('empty anchor + operator keys ⇒ effective == operator (identity with today)', () => {
        const a = makeEntry('op-a');
        const b = makeEntry('op-b');
        const eff = buildEffectiveTrustedKeys([], `${a.entry}\n${b.entry}`);
        expect(eff.map((k) => k.keyId)).toEqual(['op-a', 'op-b']);
        expect(eff.every((k) => k.source === 'operator')).toBe(true);
    });

    it('official-only (operator unset) ⇒ effective == official, tagged official', () => {
        const o = makeEntry('off-1');
        const eff = buildEffectiveTrustedKeys([o.entry], undefined);
        expect(eff).toHaveLength(1);
        expect(eff[0].keyId).toBe('off-1');
        expect(eff[0].source).toBe('official');
    });

    it('union: distinct official + operator keyIds ⇒ both present, correctly tagged, official first', () => {
        const o = makeEntry('off-1');
        const p = makeEntry('op-1');
        const eff = buildEffectiveTrustedKeys([o.entry], p.entry);
        expect(eff.map((k) => [k.keyId, k.source])).toEqual([
            ['off-1', 'official'],
            ['op-1', 'operator'],
        ]);
    });

    it('REGRESSION: intra-operator duplicate keyIds (different material) are BOTH kept, no WARN', () => {
        // rot:OLD,rot:NEW mid-rotation — empty anchor. Both must survive.
        const oldK = makeEntry('rot');
        const newK = makeEntry('rot'); // same keyId, different key material
        const warn = vi.spyOn(Logger.for('PluginTrustAnchors'), 'warn');
        const eff = buildEffectiveTrustedKeys([], `${oldK.entry}\n${newK.entry}`);
        expect(eff.map((k) => k.keyId)).toEqual(['rot', 'rot']);
        // Both kept AND distinct material — a manifest signed by EITHER verifies.
        const mats = eff.map((k) =>
            k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        );
        expect(mats[0]).not.toBe(mats[1]);
        // No collision WARN fired for the operator↔operator dup.
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it('ADVERSARIAL: operator entry reusing an OFFICIAL keyId is dropped with an accurate WARN', () => {
        const off = makeEntry('shared');
        const opBogus = makeEntry('shared'); // same keyId, different material, operator source
        const distinctOp = makeEntry('op-ok');
        const warn = vi.spyOn(Logger.for('PluginTrustAnchors'), 'warn');
        const eff = buildEffectiveTrustedKeys([off.entry], `${opBogus.entry}\n${distinctOp.entry}`);
        // official 'shared' kept (its material), operator 'shared' dropped, 'op-ok' kept.
        expect(eff.map((k) => [k.keyId, k.source])).toEqual([
            ['shared', 'official'],
            ['op-ok', 'operator'],
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][1]).toMatchObject({ keyId: 'shared' });
        warn.mockRestore();
    });

    it('malformed / non-ed25519 anchor entry is dropped, does not poison the set', () => {
        const good = makeEntry('off-1');
        const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const rsaB64 = rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
        const eff = buildEffectiveTrustedKeys(
            ['garbage-no-colon', `rsa:${rsaB64}`, good.entry],
            undefined,
        );
        expect(eff.map((k) => k.keyId)).toEqual(['off-1']);
    });

    it('ADVERSARIAL: a PKCS8 Ed25519 PRIVATE key fed as an entry is dropped, never trusted', () => {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        const privB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
        expect(buildEffectiveTrustedKeys([`leak:${privB64}`], undefined)).toEqual([]);
        expect(buildEffectiveTrustedKeys([], `leak:${privB64}`)).toEqual([]);
    });
});

describe('OFFICIAL_TRUSTED_KEY_ENTRIES anchor integrity', () => {
    // This constant is compiled into EVERY install and grants full host trust to
    // anything it verifies, with no revocation path (removal blocks future
    // installs but unloads nothing). So the guards here are not style checks —
    // each one is a way the anchor could ship wrong and be unfixable in the field.

    it('ships at least one official key', () => {
        // Guards the silent-revert direction: a bad merge or an over-eager
        // "clean up the placeholder" emptying this array would disable official
        // trust for every install, and nothing else in the suite would notice.
        expect(OFFICIAL_TRUSTED_KEY_ENTRIES.length).toBeGreaterThan(0);
    });

    it('every shipped entry parses (fails CI if release infra ever ships a corrupt entry)', () => {
        expect(getOfficialTrustedKeys().length).toBe(OFFICIAL_TRUSTED_KEY_ENTRIES.length);
    });

    it('every shipped entry is an Ed25519 PUBLIC key, and no entry is a PRIVATE key', () => {
        // The catastrophic typo: pasting the .pem half instead of the printed
        // SPKI. parseTrustedKeys already drops it (so the length test above
        // would fail too), but assert it directly — a leaked private key in a
        // public repo is not a failure mode to detect only by side effect.
        for (const entry of OFFICIAL_TRUSTED_KEY_ENTRIES) {
            const idx = entry.indexOf(':');
            expect(idx).toBeGreaterThan(0);
            const raw = Buffer.from(entry.slice(idx + 1), 'base64');
            const pub = crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
            expect(pub.asymmetricKeyType).toBe('ed25519');
            expect(() =>
                crypto.createPrivateKey({ key: raw, format: 'der', type: 'pkcs8' }),
            ).toThrow();
        }
    });

    it('never ships a TEST key as a compile-time trust anchor', () => {
        // The original reason this describe block existed. A throwaway key whose
        // private half is a scratch file must never become a trust anchor on
        // every install — so pin the known fixture key by BOTH id and material,
        // and refuse anything self-labelled test/dev/example/scratch.
        const FIXTURE_PUB = 'MCowBQYDK2VwAyEAWG0PnWWnVHrXnwFVLwUmVr1esEsiWcVROA7m+b8s1xs=';
        for (const entry of OFFICIAL_TRUSTED_KEY_ENTRIES) {
            const [keyId, material] = [
                entry.slice(0, entry.indexOf(':')),
                entry.slice(entry.indexOf(':') + 1),
            ];
            expect(material).not.toBe(FIXTURE_PUB);
            expect(keyId).not.toBe('lumastra-test-2026');
            expect(keyId).not.toMatch(/test|dev|example|scratch|throwaway|tmp/i);
        }
    });

    it('has unique, well-formed keyIds', () => {
        // A duplicate id makes audit output ambiguous ("which key admitted this
        // plugin?"); a colon in an id would split the entry on parse.
        const ids = OFFICIAL_TRUSTED_KEY_ENTRIES.map((e) => e.slice(0, e.indexOf(':')));
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
    });
});

describe('classifyKeyId', () => {
    const off = makeEntry('off-1');
    const op = makeEntry('op-1');
    const effective = buildEffectiveTrustedKeys([off.entry], op.entry);
    it('classifies official / operator / unknown / null', () => {
        expect(classifyKeyId('off-1', effective)).toBe('official');
        expect(classifyKeyId('op-1', effective)).toBe('operator');
        expect(classifyKeyId('removed-key', effective)).toBe('unknown');
        expect(classifyKeyId(null, effective)).toBe('unknown');
    });
});
