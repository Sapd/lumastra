// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, errors as joseErrors, type CryptoKey } from 'jose';
import {
    validateLogoutToken,
    LogoutTokenError,
    OidcBackchannelInfraError,
} from './oidc-logout-token.js';

const ISS = 'https://idp.test/application/o/lumastra/';
const AUD = 'lumastra-client';
const EVENT = 'http://schemas.openid.net/event/backchannel-logout';

let priv: CryptoKey;
let pub: CryptoKey;

async function sign(
    payload: Record<string, unknown>,
    opts: { iss?: string; aud?: string; expSec?: number } = {},
): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'logout+jwt' })
        .setIssuer(opts.iss ?? ISS)
        .setAudience(opts.aud ?? AUD)
        .setIssuedAt(now)
        .setExpirationTime(now + (opts.expSec ?? 120))
        .setJti(`jti-${Math.random()}`)
        .sign(priv);
}

beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    priv = kp.privateKey;
    pub = kp.publicKey;
    void exportJWK; // (kept available if a JWKS-shaped test is added later)
});

describe('validateLogoutToken', () => {
    const opts = () => ({ key: pub, issuer: ISS, audience: AUD });

    it('accepts a valid sid-only logout token', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } });
        const claims = await validateLogoutToken(jwt, opts());
        expect(claims.sid).toBe('sid-1');
        expect(claims.sub).toBeUndefined();
        expect(claims.jti).toBeTruthy();
    });

    it('accepts a valid sub-only logout token', async () => {
        const jwt = await sign({ sub: 'user-1', events: { [EVENT]: {} } });
        const claims = await validateLogoutToken(jwt, opts());
        expect(claims.sub).toBe('user-1');
    });

    it('rejects a token with neither sub nor sid', async () => {
        const jwt = await sign({ events: { [EVENT]: {} } });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a missing/!backchannel events claim', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { 'http://other/event': {} } });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a token containing a nonce', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} }, nonce: 'n' });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a wrong audience', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } }, { aud: 'someone-else' });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a wrong issuer', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } }, { iss: 'https://evil/' });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects an expired token', async () => {
        // expSec must be beyond the 60s clock-tolerance default to actually be rejected.
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } }, { expSec: -120 });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a multi-audience token whose azp is not us', async () => {
        const now = Math.floor(Date.now() / 1000);
        const jwt = await new SignJWT({ sid: 'sid-1', events: { [EVENT]: {} }, azp: 'other-rp' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISS)
            .setAudience([AUD, 'other-rp'])
            .setIssuedAt(now)
            .setExpirationTime(now + 120)
            .setJti('multi')
            .sign(priv);
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects an events member that is not an object', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: 'not-an-object' } });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('treats an empty-string sid+sub as absent (rejects)', async () => {
        const jwt = await sign({ sid: '', sub: '', events: { [EVENT]: {} } });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects a token signed by an unknown key', async () => {
        const other = await generateKeyPair('RS256');
        const jwt = await new SignJWT({ sid: 'sid-1', events: { [EVENT]: {} } })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(ISS)
            .setAudience(AUD)
            .setIssuedAt()
            .setExpirationTime('2m')
            .setJti('x')
            .sign(other.privateKey);
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('rejects an events member that is an array', async () => {
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: [] } });
        await expect(validateLogoutToken(jwt, opts())).rejects.toBeInstanceOf(LogoutTokenError);
    });

    it('maps a malformed JWT string to LogoutTokenError', async () => {
        await expect(validateLogoutToken('not.a.jwt', opts())).rejects.toBeInstanceOf(
            LogoutTokenError,
        );
    });

    it('maps ERR_JOSE_GENERIC from key resolver to OidcBackchannelInfraError', async () => {
        const infraKey = (): never => {
            const err = new joseErrors.JOSEError('simulated JWKS HTTP failure');
            (err as joseErrors.JOSEError & { code: string }).code = 'ERR_JOSE_GENERIC';
            throw err;
        };
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } });
        await expect(
            validateLogoutToken(jwt, { key: infraKey, issuer: ISS, audience: AUD }),
        ).rejects.toBeInstanceOf(OidcBackchannelInfraError);
    });

    it('maps a token-fault code from key resolver to LogoutTokenError', async () => {
        const badTokenKey = (): never => {
            const err = new joseErrors.JOSEError('no matching key');
            (err as joseErrors.JOSEError & { code: string }).code = 'ERR_JWKS_NO_MATCHING_KEY';
            throw err;
        };
        const jwt = await sign({ sid: 'sid-1', events: { [EVENT]: {} } });
        await expect(
            validateLogoutToken(jwt, { key: badTokenKey, issuer: ISS, audience: AUD }),
        ).rejects.toBeInstanceOf(LogoutTokenError);
    });
});
