// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Loopback-only contract fixture host. No ingest, upstream fetch, process spawning,
//! or operational startup is reachable through this explicit test entry point.
use crate::{
    auth,
    http_contract::{self, Rejection, Route},
    status::{self, StatusSnapshot},
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Instant};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Fixture {
    status: StatusSnapshot,
    shutting_down: bool,
    egress_enabled: bool,
    adaptive_enabled: bool,
    replies: BTreeMap<String, Reply>,
    media: crate::media::MediaSnapshot,
    trace_waiters: bool,
}
#[derive(Debug, Deserialize)]
struct Reply {
    status: u16,
    body: Value,
}
struct ServerState {
    fixture: Fixture,
    secret: Option<String>,
    production: bool,
    started: Instant,
    waiters: Arc<crate::playlist_wait::WaitCounters>,
}
fn json_response(status: u16, body: &Value) -> Response<Body> {
    let bytes = serde_json::to_vec(body).expect("JSON Value serialization cannot fail");
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("content-length", bytes.len())
        .body(Body::from(bytes))
        .expect("constant HTTP response headers")
}
fn reject(error: Rejection) -> Response<Body> {
    json_response(error.status, &error.body)
}
async fn handle(State(state): State<Arc<ServerState>>, request: Request) -> Response<Body> {
    let base = url::Url::parse("http://localhost").expect("constant base URL");
    let Ok(url) = base.join(&request.uri().to_string()) else {
        return reject(Rejection::error(400, "invalid_url"));
    };
    let method = request.method().as_str();
    // Node's HTTP/1 parser presents header octets as Latin-1 strings; UTF-8
    // validation here would reject an otherwise identical non-ASCII secret.
    let supplied: Vec<String> = request
        .headers()
        .get_all("x-proxy-secret")
        .iter()
        .map(|v| v.as_bytes().iter().map(|byte| char::from(*byte)).collect())
        .collect();
    let provided = (!supplied.is_empty()).then(|| supplied.join(", "));
    let auth = auth::validate_auth(
        state.secret.as_deref(),
        state.production,
        provided.as_deref(),
    );
    if method == "GET" && url.path() == "/status" {
        return json_response(
            200,
            &status::render(
                &state.fixture.status,
                auth.ok,
                state.fixture.shutting_down,
                state.started.elapsed().as_secs(),
                "",
            ),
        );
    }
    if !auth.ok {
        return reject(Rejection::error(
            auth.status.unwrap_or(401),
            if auth.reason.is_some() {
                "misconfigured"
            } else {
                "unauthorized"
            },
        ));
    }
    if state.fixture.shutting_down {
        return json_response(
            503,
            &json!({"error":"shutting_down","message":"Server is shutting down"}),
        );
    }
    let route = match http_contract::route(
        method,
        url.path(),
        state.fixture.egress_enabled,
        state.fixture.adaptive_enabled,
    ) {
        Ok(route) => route,
        Err(error) => return reject(error),
    };
    if matches!(route, Route::Feed { .. }) {
        let feed = url
            .query_pairs()
            .find(|(key, _)| key == "feed")
            .map(|(_, value)| value.into_owned());
        if !feed.as_deref().is_some_and(|id| {
            (16..=64).contains(&id.len())
                && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        }) {
            return reject(Rejection::error(400, "invalid_feed_id"));
        }
    }
    if matches!(route, Route::Join { .. }) {
        if request
            .headers()
            .get("content-type")
            .is_some_and(|v| !v.as_bytes().starts_with(b"application/json"))
        {
            return reject(Rejection::error(415, "unsupported_media_type"));
        }
        let body = match to_bytes(request.into_body(), http_contract::MAX_BODY_SIZE).await {
            Ok(body) => body,
            Err(_) => return reject(Rejection::error(413, "payload_too_large")),
        };
        let parsed = match serde_json::from_slice::<Value>(&body) {
            Ok(parsed) => parsed,
            Err(_) => {
                return json_response(
                    400,
                    &json!({"error":"invalid_json","message":"Invalid JSON"}),
                );
            }
        };
        if let Err(error) = http_contract::validate_join(&parsed) {
            return reject(error);
        }
    } else if matches!(route, Route::Leave { .. } | Route::Heartbeat { .. })
        && !url
            .query_pairs()
            .find(|(key, _)| key == "viewerId")
            .is_some_and(|(_, value)| !value.is_empty())
    {
        return json_response(
            400,
            &json!({"error":"validation_error","message":"viewerId query parameter is required"}),
        );
    }
    if let Some(initial) = crate::media::respond(&state.fixture.media, &route) {
        let response = if matches!(
            route,
            Route::Playlist { .. }
                | Route::RungPlaylist { .. }
                | Route::AdaptivePlaylist { .. }
                | Route::VariantPlaylist { .. }
        ) {
            crate::playlist_wait::wait_ready(
                || {
                    if crate::media::playlist_source(&state.fixture.media, &route).is_some_and(
                        |source| {
                            source.segments.is_some()
                                && state.started.elapsed().as_millis()
                                    < u128::from(source.playlist_ready_after_ms)
                        },
                    ) {
                        return crate::media::MediaResponse::Wait;
                    }
                    crate::media::respond(&state.fixture.media, &route).expect("typed media route")
                },
                || crate::media::playlist_timeout_error(&state.fixture.media, &route),
                state.waiters.clone(),
                state.fixture.trace_waiters.then(|| url.path().to_owned()),
                crate::playlist_wait::WaitLimits::default(),
            )
            .await
        } else {
            initial
        };
        match response {
            crate::media::MediaResponse::Json(error) => return reject(error),
            crate::media::MediaResponse::Bytes {
                content_type,
                cache_control,
                body,
            } => {
                return Response::builder()
                    .status(200)
                    .header("content-type", content_type)
                    .header("cache-control", cache_control)
                    .header("content-length", body.len())
                    .body(Body::from(body))
                    .expect("constant media headers");
            }
            crate::media::MediaResponse::Wait => {}
        }
    }
    let operation = serde_json::to_value(route).expect("typed route serializes");
    let key = operation["operation"]
        .as_str()
        .expect("tagged route has operation");
    if let Some(reply) = state.fixture.replies.get(key) {
        return json_response(reply.status, &reply.body);
    }
    // Recognition is not implementation: never return a fabricated successful
    // lifecycle result when the fixture did not provide its manager response.
    json_response(501, &json!({"error":"native_runtime_unavailable"}))
}
pub async fn run(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    // Bounded before parsing: fixture files are local test data, not a runtime API.
    let file = tokio::fs::File::open(path).await?;
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("fixture too large".into());
    }
    let fixture: Fixture = serde_json::from_slice(&bytes)?;
    let state = Arc::new(ServerState {
        fixture,
        secret: std::env::var("STREAM_PROXY_SECRET").ok(),
        production: std::env::var("NODE_ENV").ok().as_deref() == Some("production"),
        started: Instant::now(),
        waiters: Arc::default(),
    });
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    println!("{}", json!({"port":listener.local_addr()?.port()}));
    let router = Router::new().fallback(handle).with_state(state);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
