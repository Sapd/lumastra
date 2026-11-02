// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Baked-in license-signing PUBLIC key.
 *
 * Licenses are signed off-box by the licensing server with the matching PRIVATE
 * key (held only as a server-side secret — it is NEVER in this repo). The app
 * verifies signatures locally against this public key, so verification is fully
 * offline (no phone-home for the crypto itself).
 *
 * Algorithm: ECDSA P-384 / ES384 (Web-Crypto-friendly).
 *
 * Fingerprint (SHA-256 of the SPKI DER, the operator can confirm the keypair
 * matches): 72:11:48:a2:e3:26:e9:3a:40:a7:29:f9:82:2b:6a:b8:e0:ef:27:96:84:74:a6:06:ea:b7:b8:23:fb:81:85:e4
 *
 * Rotated 2026-09-27 before the OSS launch: the June 2026 keypair's private half
 * was not recoverable. No released build ever enforced with the old key.
 */
export const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEM14tnUa0AIQtivPdlYw5iAsSBocfL5O9
I2hkdrL0YnXrONJuF9BnyCXmCcZd38Yj6RjgPzVQ1V4/jFQf9y+vIP58fP8dYsIY
qmoADauQWmVaNe0EuwdIjYCB5rF9nccC
-----END PUBLIC KEY-----`;

/** JWS algorithm the license tokens are signed with. */
export const LICENSE_JWT_ALG = 'ES384' as const;

/** Expected JWT issuer claim. */
export const LICENSE_JWT_ISSUER = 'lumastra' as const;
