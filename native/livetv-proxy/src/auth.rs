// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use serde::Serialize;
use subtle::ConstantTimeEq;

#[derive(Debug, Serialize)]
pub struct AuthResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

pub fn validate_auth(secret: Option<&str>, production: bool, provided: Option<&str>) -> AuthResult {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
        return if production {
            AuthResult {
                ok: false,
                status: Some(503),
                reason: Some("STREAM_PROXY_SECRET required"),
            }
        } else {
            AuthResult {
                ok: true,
                status: None,
                reason: None,
            }
        };
    };
    AuthResult {
        ok: provided.is_some_and(|value| bool::from(value.as_bytes().ct_eq(secret.as_bytes()))),
        status: None,
        reason: None,
    }
}
