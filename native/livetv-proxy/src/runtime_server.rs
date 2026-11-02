// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

//! Operational HTTP boundary. Fixture hosting remains a separate explicit mode.
use crate::{
    auth,
    config::{Environment, ProxyConfig},
    http_contract::{self, Rejection, Route},
    masters,
    playlist::{self, PlaylistOptions},
    runtime_connections::PeerAddress,
    runtime_coordinator::Coordinator,
    runtime_feed::{FeedGrants, FeedManager, valid_feed_id},
    runtime_ingest::IngestManager,
    runtime_media::{Segment, observed_bitrate},
    runtime_outputs::{OutputManager, OutputSnapshot},
    status::{self, StatusSnapshot},
};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Request, State},
    http::Response,
};
use bytes::Bytes;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

struct ServerState {
    coordinator: Arc<Coordinator>,
    feeds: Arc<FeedManager>,
    grants: FeedGrants,
    secret: Option<String>,
    production: bool,
    started: Instant,
    ffmpeg_available: AtomicBool,
}
fn response(status: u16, content_type: &str, bytes: Bytes) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", content_type)
        .header("content-length", bytes.len())
        .header("cache-control", "no-cache")
        .body(Body::from(bytes))
        .expect("constant response headers")
}
fn json_response(status: u16, body: &Value) -> Response<Body> {
    response(
        status,
        "application/json",
        Bytes::from(serde_json::to_vec(body).expect("JSON value")),
    )
}
fn reject(error: Rejection) -> Response<Body> {
    json_response(error.status, &error.body)
}
fn error(status: u16, name: &str) -> Response<Body> {
    reject(Rejection::error(status, name))
}
fn media_playlist(segments: &[Arc<Segment>], options: PlaylistOptions) -> Response<Body> {
    let segments: Vec<_> = segments
        .iter()
        .map(|s| playlist::Segment {
            index: s.index,
            duration: s.duration,
        })
        .collect();
    match playlist::render_playlist(&segments, &options) {
        Some(body) => response(200, "application/vnd.apple.mpegurl", Bytes::from(body)),
        None => error(404, "no_segments"),
    }
}
/// `/status` keeps the newest end of an ingest's stderr, as much as the TS proxy does.
const STATUS_ERROR_TAIL: usize = 500;
fn status_response(state: &ServerState, detailed: bool) -> Response<Body> {
    let mut snapshot = StatusSnapshot {
        mux: state.coordinator.mux_status(),
        ffmpeg_available: state.ffmpeg_available.load(Ordering::Acquire),
        egress: Some(vec![]),
        adaptive: Some(vec![]),
        capacity: Some(state.coordinator.outputs.capacity()),
        ..Default::default()
    };
    for id in state.coordinator.ingest.channel_ids() {
        let Some(ingest) = state.coordinator.ingest.snapshot(&id) else {
            continue;
        };
        let video = &ingest.probe["video"];
        let audio = &ingest.probe["audio"];
        let mut row = json!({"channelId":id,"channelName":id,"viewers":0,"sourceId":"","ffmpegHealthy":ingest.health=="healthy","ffmpegHealth":if ingest.health=="healthy"{"healthy"}else if ingest.health=="degraded"{"degraded"}else{"error"},"startedAt":crate::runtime_operations::iso_timestamp(ingest.started_at_ms),"containerFormat":"mpegts","segmentCount":ingest.segments.len(),"memoryBytes":ingest.segments.iter().map(|s|s.data.len()).sum::<usize>(),"initSegmentReady":false,"transcodeDecision":ingest.decision,"probeResult":{"videoCodec":video["codec"],"audioCodec":audio["codec"],"interlaced":video["interlaced"],"hdr":video["hdr"],"bitDepth":video["bitDepth"],"width":video["width"],"height":video["height"]}});
        row["outputDiagnostics"] = ingest
            .output_diagnostics
            .snapshot(ingest.segments.iter().map(|segment| segment.duration).sum());
        if ingest.last_segment_at_ms > 0 {
            row["lastSegmentAt"] = json!(crate::runtime_operations::iso_timestamp(
                ingest.last_segment_at_ms
            ));
        }
        if matches!(ingest.health.as_str(), "error" | "degraded") {
            row["ffmpegError"] = json!(crate::runtime_operations::tail(
                &ingest.stderr_tail,
                STATUS_ERROR_TAIL
            ));
        }
        snapshot.channels.push((id, row));
    }
    // Every encoder, not only those of a live ingest: one that outlived its channel
    // still holds its slot, and render() lists it under orphanedEncoders.
    if let Some(rows) = snapshot.egress.as_mut() {
        let mut ids: Vec<String> = snapshot.channels.iter().map(|(id, _)| id.clone()).collect();
        for id in state.coordinator.outputs.channel_ids() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        for id in ids {
            let encoders = state.coordinator.outputs.encoder_status(&id);
            rows.push((id, encoders.as_array().cloned().unwrap_or_default()));
        }
    }
    json_response(
        200,
        &status::render(
            &snapshot,
            detailed,
            state.coordinator.is_stopping(),
            state.started.elapsed().as_secs(),
            // Unused: every multiplexer row carries its own startedAt.
            "",
        ),
    )
}
async fn wait_ingest(
    state: &ServerState,
    channel: &str,
) -> Result<crate::runtime_ingest::IngestSnapshot, Rejection> {
    let deadline = Instant::now() + Duration::from_secs(18);
    let mut changed = state.coordinator.ingest.subscribe(channel);
    loop {
        if let Some(failed) = state.coordinator.hls_failure(channel) {
            return Err(Rejection {
                status: 410,
                body: failed,
            });
        }
        let lifecycle = state.coordinator.lifecycle(channel);
        if let Some(snapshot) = state.coordinator.ingest.snapshot(channel) {
            if !snapshot.segments.is_empty() {
                return Ok(snapshot);
            }
        } else if !lifecycle.failing_over {
            return Err(Rejection::error(404, "channel_not_found"));
        }
        if Instant::now() >= deadline {
            return Err(Rejection::error(404, "no_segments"));
        }
        // A terminal transition does not publish on `changed`; look again at least once
        // a second so a waiting player sees the 410 promptly.
        let wake = deadline.min(Instant::now() + Duration::from_secs(1));
        let wake = tokio::time::Instant::from_std(wake);
        if let Ok(Err(_)) = tokio::time::timeout_at(wake, changed.changed()).await {
            tokio::time::sleep_until(wake).await;
        }
    }
}
async fn wait_output(
    state: &ServerState,
    channel: &str,
    output: &str,
    adaptive: bool,
) -> Result<OutputSnapshot, Rejection> {
    let deadline = Instant::now() + Duration::from_secs(18);
    loop {
        if let Some(failed) = state.coordinator.hls_failure(channel) {
            return Err(Rejection {
                status: 410,
                body: failed,
            });
        }
        match if adaptive {
            state.coordinator.outputs.adaptive_snapshot(channel, output)
        } else {
            state.coordinator.outputs.snapshot(channel, output)
        } {
            Some(snapshot) if !snapshot.segments.is_empty() => return Ok(snapshot),
            None if !state.coordinator.lifecycle(channel).failing_over => {
                return Err(Rejection::error(404, "rung_not_found"));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(Rejection::error(404, "no_segments"));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
fn output_playlist(snapshot: OutputSnapshot) -> Response<Body> {
    let options = PlaylistOptions {
        aged_out_discontinuities: snapshot.aged_out_discontinuities,
        fmp4: snapshot.fmp4,
        discontinuity_anchors: snapshot.discontinuity_anchors,
        init_uris: serde_json::from_value(snapshot.init_uris).unwrap_or_default(),
    };
    media_playlist(&snapshot.segments, options)
}
fn segment_response(segments: &[Arc<Segment>], index: &str, fmp4: bool) -> Response<Body> {
    let Ok(index) = index.parse::<u64>() else {
        return error(400, "invalid_segment_index");
    };
    match segments.iter().find(|s| s.index == index) {
        Some(segment) => response(
            200,
            if fmp4 { "video/mp4" } else { "video/MP2T" },
            segment.data.clone(),
        ),
        None => error(404, "segment_not_found"),
    }
}
/// The proxy's own encoders read the ingest here. They hold a per-encoder feed grant
/// instead of the shared secret, which never reaches a child process, and they always
/// connect over loopback.
async fn feed_response(
    state: &ServerState,
    loopback: bool,
    url: &url::Url,
    channel: &str,
) -> Response<Body> {
    let id = url
        .query_pairs()
        .find(|(k, _)| k == "feed")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    if !valid_feed_id(&id) {
        return error(400, "invalid_feed_id");
    }
    if !loopback || !state.grants.allows(channel, &id) {
        return error(403, "feed_forbidden");
    }
    if state.coordinator.is_stopping() {
        return json_response(
            503,
            &json!({"error":"shutting_down","message":"Server is shutting down"}),
        );
    }
    match state.feeds.open(channel, &id).await {
        Ok(stream) => Response::builder()
            .status(200)
            .header("content-type", "video/MP2T")
            .header("cache-control", "no-store")
            .body(Body::from_stream(stream))
            .expect("constant response"),
        Err(e) => error(e.status, e.error),
    }
}
async fn handle(State(state): State<Arc<ServerState>>, request: Request) -> Response<Body> {
    let base = url::Url::parse("http://localhost").expect("constant URL");
    let Ok(url) = base.join(&request.uri().to_string()) else {
        return error(400, "invalid_url");
    };
    let method = request.method().as_str().to_owned();
    let loopback = request
        .extensions()
        .get::<ConnectInfo<PeerAddress>>()
        .is_some_and(|peer| peer.0.is_loopback());
    if let Ok(Route::Feed { channel }) = http_contract::route(&method, url.path(), true, true) {
        return feed_response(&state, loopback, &url, &channel).await;
    }
    let supplied: Vec<String> = request
        .headers()
        .get_all("x-proxy-secret")
        .iter()
        .map(|v| v.as_bytes().iter().map(|b| char::from(*b)).collect())
        .collect();
    let provided = (!supplied.is_empty()).then(|| supplied.join(", "));
    let auth = auth::validate_auth(
        state.secret.as_deref(),
        state.production,
        provided.as_deref(),
    );
    if method == "GET" && url.path() == "/status" {
        return status_response(&state, auth.ok);
    }
    if !auth.ok {
        return error(
            auth.status.unwrap_or(401),
            if auth.reason.is_some() {
                "misconfigured"
            } else {
                "unauthorized"
            },
        );
    }
    if state.coordinator.is_stopping() {
        return json_response(
            503,
            &json!({"error":"shutting_down","message":"Server is shutting down"}),
        );
    }
    // Every GET under a channel serves media. A channel whose every URL failed answers
    // 410 with its reason instead of a stale playlist or no_segments, until a new join
    // starts it over. (feed.ts was answered above, before authentication.)
    if method == "GET"
        && let Some((channel, _)) = url
            .path()
            .strip_prefix("/streams/")
            .and_then(|rest| rest.split_once('/'))
        && http_contract::safe_id(channel)
        && let Some(failed) = state.coordinator.hls_failure(channel)
    {
        return json_response(410, &failed);
    }
    let route = match http_contract::route(&method, url.path(), true, true) {
        Ok(route) => route,
        Err(rejection) => return reject(rejection),
    };
    match route {
        Route::Status => status_response(&state, auth.ok),
        Route::Join { channel } => {
            if request
                .headers()
                .get("content-type")
                .is_some_and(|v| !v.as_bytes().starts_with(b"application/json"))
            {
                return error(415, "unsupported_media_type");
            }
            let bytes = match tokio::time::timeout(
                Duration::from_secs(30),
                to_bytes(request.into_body(), http_contract::MAX_BODY_SIZE),
            )
            .await
            {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return error(413, "payload_too_large"),
                Err(_) => return error(408, "request_timeout"),
            };
            let body: Value = match serde_json::from_slice(&bytes) {
                Ok(body) => body,
                Err(_) => {
                    return json_response(
                        400,
                        &json!({"error":"invalid_json","message":"Invalid JSON"}),
                    );
                }
            };
            if let Err(rejection) = http_contract::validate_join(&body) {
                return reject(rejection);
            }
            let (status, body) = state.coordinator.join(&channel, &body).await;
            json_response(status, &body)
        }
        Route::Leave { channel } | Route::Heartbeat { channel } => {
            let viewer = url
                .query_pairs()
                .find(|(k, _)| k == "viewerId")
                .map(|(_, v)| v.into_owned());
            let Some(viewer) = viewer.filter(|s| !s.is_empty()) else {
                return json_response(
                    400,
                    &json!({"error":"validation_error","message":"viewerId query parameter is required"}),
                );
            };
            let body = if method == "DELETE" {
                if url
                    .query_pairs()
                    .any(|(key, value)| key == "immediate" && value == "true")
                {
                    state.coordinator.leave_immediately(&channel, &viewer).await
                } else {
                    state.coordinator.leave(&channel, &viewer).await
                }
            } else {
                state.coordinator.heartbeat(&channel, &viewer)
            };
            // A terminal channel answers 200 with success:false and `failure`, so the app
            // reads the reason as JSON; 404 keeps meaning "unknown channel or viewer".
            json_response(
                if method == "POST" && body["success"] != true && body.get("failure").is_none() {
                    404
                } else {
                    200
                },
                &body,
            )
        }
        Route::Kill { channel } => json_response(200, &state.coordinator.kill(&channel).await),
        Route::Feed { channel } => feed_response(&state, loopback, &url, &channel).await,
        Route::Master { channel } => {
            if state.coordinator.ingest.snapshot(&channel).is_none() {
                error(404, "channel_not_found")
            } else {
                response(
                    200,
                    "application/vnd.apple.mpegurl",
                    Bytes::from_static(playlist::master_playlist().as_bytes()),
                )
            }
        }
        Route::Playlist { channel } => match wait_ingest(&state, &channel).await {
            Ok(snapshot) => {
                let lifecycle = state.coordinator.lifecycle(&channel);
                media_playlist(
                    &snapshot.segments,
                    PlaylistOptions {
                        discontinuity_anchors: lifecycle.anchors,
                        aged_out_discontinuities: lifecycle.aged_out,
                        ..Default::default()
                    },
                )
            }
            Err(rejection) => reject(rejection),
        },
        Route::Segment { channel, index } => match state.coordinator.ingest.snapshot(&channel) {
            Some(snapshot) => {
                let mut response = segment_response(&snapshot.segments, &index, false);
                if response.status().is_success() {
                    response.headers_mut().insert(
                        "cache-control",
                        "public, max-age=3600".parse().expect("constant header"),
                    );
                }
                response
            }
            None => error(404, "channel_not_found"),
        },
        Route::Init { channel } => {
            if state.coordinator.ingest.snapshot(&channel).is_some() {
                error(404, "init_segment_not_ready")
            } else {
                error(404, "channel_not_found")
            }
        }
        Route::RungPlaylist { channel, output } => {
            match wait_output(&state, &channel, &output, false).await {
                Ok(snapshot) => output_playlist(snapshot),
                Err(rejection) => reject(rejection),
            }
        }
        Route::RungSegment {
            channel,
            output,
            index,
        } => match state.coordinator.outputs.snapshot(&channel, &output) {
            Some(snapshot) => segment_response(&snapshot.segments, &index, snapshot.fmp4),
            None => error(404, "rung_not_found"),
        },
        Route::VariantPlaylist { channel, variant } => {
            match wait_output(&state, &channel, &format!("v-{variant}"), false).await {
                Ok(snapshot) => output_playlist(snapshot),
                Err(rejection) => reject(rejection),
            }
        }
        Route::VariantSegment {
            channel,
            variant,
            index,
        } => match state
            .coordinator
            .outputs
            .snapshot(&channel, &format!("v-{variant}"))
        {
            Some(snapshot) => segment_response(&snapshot.segments, &index, snapshot.fmp4),
            None => error(404, "rung_not_found"),
        },
        Route::VariantInit {
            channel,
            variant,
            name,
        } => match state
            .coordinator
            .outputs
            .snapshot(&channel, &format!("v-{variant}"))
        {
            Some(snapshot) => match snapshot.init_segments.get(&name) {
                Some(data) => response(200, "video/mp4", data.clone()),
                None => error(404, "init_segment_not_ready"),
            },
            None => error(404, "rung_not_found"),
        },
        Route::VariantMaster { channel, variant } => {
            let Some(snapshot) = state
                .coordinator
                .outputs
                .snapshot(&channel, &format!("v-{variant}"))
            else {
                return error(404, "rung_not_found");
            };
            let ingest = state.coordinator.ingest.snapshot(&channel);
            let probe = ingest
                .as_ref()
                .map(|s| s.probe.clone())
                .unwrap_or(Value::Null);
            match masters::variant(
                &variant,
                &probe,
                snapshot
                    .init_segments
                    .get(
                        snapshot
                            .init_uris
                            .as_array()
                            .and_then(|v| v.last())
                            .and_then(|v| v["uri"].as_str())
                            .unwrap_or("init.mp4"),
                    )
                    .map(Bytes::as_ref),
                // A copy remux carries the ingest's rate, measured on the same bytes.
                ingest.as_ref().and_then(|s| observed_bitrate(&s.segments)),
            ) {
                Ok(body) => response(200, "application/vnd.apple.mpegurl", Bytes::from(body)),
                Err(_) => error(404, "rung_not_found"),
            }
        }
        Route::AdaptiveMaster { channel } => {
            let variants = state.coordinator.outputs.variants(&channel);
            if variants.is_null() {
                return error(404, "adaptive_not_found");
            }
            let ingest = state.coordinator.ingest.snapshot(&channel);
            let probe = ingest
                .as_ref()
                .map(|s| s.probe.clone())
                .unwrap_or(Value::Null);
            let rate = ingest.as_ref().and_then(|s| observed_bitrate(&s.segments));
            match masters::adaptive(&variants, &probe, rate) {
                Ok(body) => response(200, "application/vnd.apple.mpegurl", Bytes::from(body)),
                Err(_) => error(404, "adaptive_not_found"),
            }
        }
        Route::AdaptivePlaylist { channel, output } => {
            match wait_output(&state, &channel, &output, true).await {
                Ok(snapshot) => output_playlist(snapshot),
                Err(rejection) => reject(rejection),
            }
        }
        Route::AdaptiveSegment {
            channel,
            output,
            index,
        } => {
            match state
                .coordinator
                .outputs
                .adaptive_snapshot(&channel, &output)
            {
                Some(snapshot) => segment_response(&snapshot.segments, &index, false),
                None => error(404, "rung_not_found"),
            }
        }
    }
}

pub async fn run(env: Environment) -> Result<(), String> {
    let production = env.get("NODE_ENV").is_some_and(|s| s == "production");
    let secret = env
        .get("STREAM_PROXY_SECRET")
        .filter(|s| !s.is_empty())
        .cloned();
    if production && secret.is_none() {
        return Err("STREAM_PROXY_SECRET required".into());
    }
    let port = env
        .get("PORT")
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(3000);
    let address = env
        .get("STREAM_PROXY_BIND")
        .map(String::as_str)
        .unwrap_or("0.0.0.0");
    let listener = tokio::net::TcpListener::bind((address, port))
        .await
        .map_err(|_| "proxy_bind_failed")?;
    let port = listener
        .local_addr()
        .map_err(|_| "proxy_address_failed")?
        .port();
    let config = ProxyConfig::from_env(&env);
    let ffmpeg_path = config.ffmpeg_path.clone();
    let ffmpeg_available = executable_available(&ffmpeg_path).await;
    let root = env
        .get("HLS_TEMP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/lumastra-live"));
    let generation = crate::runtime_generations::MediaGeneration::create(root).await?;
    let root = generation.path().to_owned();
    let ingest = Arc::new(IngestManager::new(
        config.clone(),
        env.clone(),
        root.clone(),
    ));
    let grants = FeedGrants::default();
    let outputs = Arc::new(OutputManager::new(
        ingest.clone(),
        config,
        env.clone(),
        root,
        port,
        grants.clone(),
    ));
    let operations = crate::runtime_operations::RuntimeOperations::start(&env)
        .await
        .map_err(|error| {
            format!(
                "{}: {error}",
                crate::runtime_operations::COORDINATION_URL_VAR
            )
        })?;
    let weak_operations = Arc::downgrade(&operations);
    let sink: crate::runtime_media::FailureSink = Arc::new(move |event| {
        eprintln!(
            "[StreamProxy] {} {} {}: {}",
            event.source,
            event.channel_id,
            event.outcome,
            crate::runtime_media::sanitized_stderr(&event.stderr_tail)
        );
        if let Some(operations) = weak_operations.upgrade() {
            let _ = operations.report_failure(event);
        }
    });
    ingest.set_failure_sink(Some(sink.clone()));
    outputs.set_failure_sink(Some(sink));
    let coordinator = Arc::new(Coordinator::new(ingest.clone(), outputs, &env));
    let weak = Arc::downgrade(&coordinator);
    let feeds = Arc::new(FeedManager::new(
        ingest,
        Arc::new(move |id| weak.upgrade().map(|c| c.lifecycle(id)).unwrap_or_default()),
    ));
    let state = Arc::new(ServerState {
        coordinator: coordinator.clone(),
        feeds: feeds.clone(),
        grants,
        secret,
        production,
        started: Instant::now(),
        ffmpeg_available: AtomicBool::new(ffmpeg_available),
    });
    let maintenance = tokio::spawn({
        let coordinator = coordinator.clone();
        let state = state.clone();
        async move {
            let mut availability_check = Instant::now();
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                coordinator.maintenance().await;
                if !state.ffmpeg_available.load(Ordering::Acquire)
                    && availability_check.elapsed() >= Duration::from_secs(5)
                {
                    state
                        .ffmpeg_available
                        .store(executable_available(&ffmpeg_path).await, Ordering::Release);
                    availability_check = Instant::now();
                }
            }
        }
    });
    let app = Router::new().fallback(handle).with_state(state);
    eprintln!("Live TV proxy listening on port {port}");
    let drain = shutdown_drain(&env);
    let listener = crate::runtime_connections::BoundedListener::new(
        listener,
        crate::runtime_connections::MAX_ACCEPTED_CONNECTIONS,
        crate::runtime_connections::WRITE_INACTIVITY_TIMEOUT,
    );
    let (stop_accepting, accepting) = tokio::sync::watch::channel(false);
    let mut server = tokio::spawn(std::future::IntoFuture::into_future(
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<PeerAddress>(),
        )
        .with_graceful_shutdown(async move {
            let mut accepting = accepting;
            let _ = accepting.wait_for(|stop| *stop).await;
        }),
    ));
    tokio::select! {
        _ = termination_signal() => {}
        result = &mut server => {
            maintenance.abort();
            coordinator.stop_all().await;
            operations.shutdown().await;
            generation.cleanup().await;
            return match result {
                Ok(Ok(())) => Ok(()),
                _ => Err("proxy_server_failed".into()),
            };
        }
    }
    eprintln!("[StreamProxy] SIGTERM received, shutting down...");
    let outcome = graceful_shutdown(
        ShutdownPlan {
            stop_accepting,
            server,
            drain,
            hard: SHUTDOWN_HARD_TIMEOUT,
        },
        {
            let coordinator = coordinator.clone();
            async move {
                maintenance.abort();
                let _ = maintenance.await;
                coordinator.begin_shutdown();
                coordinator.outputs.stop_all().await;
                feeds.close_all();
            }
        },
        async move {
            coordinator.ingest.cancel_all();
            coordinator.stop_all().await;
            operations.shutdown().await;
            generation.cleanup().await;
        },
    )
    .await;
    match outcome {
        ShutdownOutcome::Forced => {
            eprintln!("[StreamProxy] Forced shutdown after timeout");
            Err("forced_shutdown".into())
        }
        ShutdownOutcome::DrainTimedOut => {
            eprintln!("[StreamProxy] Connections still open after drain; closed");
            Ok(())
        }
        ShutdownOutcome::Clean => Ok(()),
    }
}

/// Upper bound on the whole shutdown; past it the process exits non-zero.
const SHUTDOWN_HARD_TIMEOUT: Duration = Duration::from_secs(10);

fn shutdown_drain(env: &Environment) -> Duration {
    Duration::from_secs(
        env.get("LIVETV_SHUTDOWN_DRAIN_SECONDS")
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(5),
    )
}

async fn termination_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal registration");
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

struct ShutdownPlan<T> {
    stop_accepting: tokio::sync::watch::Sender<bool>,
    server: tokio::task::JoinHandle<T>,
    drain: Duration,
    hard: Duration,
}
#[derive(Debug, PartialEq)]
enum ShutdownOutcome {
    Clean,
    DrainTimedOut,
    Forced,
}

/// Same order as the TS proxy: stop accepting, stop egress (its loopback feed
/// requests are connections too, so draining first would always wait the full
/// timeout), drain, then stop viewers and ingests. The hard timeout covers it all.
async fn graceful_shutdown<T>(
    plan: ShutdownPlan<T>,
    stop_egress: impl std::future::Future<Output = ()>,
    stop_ingest: impl std::future::Future<Output = ()>,
) -> ShutdownOutcome {
    let ShutdownPlan {
        stop_accepting,
        mut server,
        drain,
        hard,
    } = plan;
    let sequence = async {
        let _ = stop_accepting.send(true);
        stop_egress.await;
        let drained = tokio::time::timeout(drain, &mut server).await.is_ok();
        if !drained {
            server.abort();
        }
        stop_ingest.await;
        if drained {
            ShutdownOutcome::Clean
        } else {
            ShutdownOutcome::DrainTimedOut
        }
    };
    match tokio::time::timeout(hard, sequence).await {
        Ok(outcome) => outcome,
        Err(_) => {
            server.abort();
            ShutdownOutcome::Forced
        }
    }
}

async fn executable_available(path: &str) -> bool {
    executable_available_within(path, Duration::from_secs(2)).await
}

async fn executable_available_within(path: &str, limit: Duration) -> bool {
    let Ok(mut child) = tokio::process::Command::new(path)
        .arg("-version")
        .env_clear()
        .envs(crate::config::process_child_environment())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return false;
    };
    match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            false
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> Arc<ServerState> {
        fixture_with(|_, _| {})
    }
    /// A fixture whose encoders are a shell script that only sleeps.
    fn encoder_fixture() -> Arc<ServerState> {
        fixture_with(|root, config| {
            std::fs::create_dir_all(root).unwrap();
            let executable = root.join("encoder");
            std::fs::write(&executable, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '-filters' ]; then exit 0; fi; done\nexec /bin/sleep 30\n").unwrap();
            crate::test_support::seal_executable(&executable, 0o755);
            config.ffmpeg_path = executable.to_string_lossy().into_owned();
            config.max_egress_encoders = 2;
        })
    }
    fn fixture_with(
        configure: impl FnOnce(&std::path::Path, &mut ProxyConfig),
    ) -> Arc<ServerState> {
        let env = Environment::new();
        let mut config = ProxyConfig::from_env(&env);
        let root = std::env::temp_dir().join(format!(
            "server-fixture-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        configure(&root, &mut config);
        let ingest = Arc::new(IngestManager::new(
            config.clone(),
            env.clone(),
            root.clone(),
        ));
        ingest.publish_test("channel", 1, &[0]);
        ingest.set_test_probe(
            "channel",
            json!({"success":true,"video":{"codec":"h264","height":1080,"width":1920,"hdr":false,"bitDepth":8}}),
            json!({"videoAction":"transcode","videoEncoder":"libx264"}),
        );
        let grants = FeedGrants::default();
        let outputs = Arc::new(OutputManager::new(
            ingest.clone(),
            config,
            env.clone(),
            root,
            65534,
            grants.clone(),
        ));
        let coordinator = Arc::new(Coordinator::new(ingest.clone(), outputs, &env));
        let weak = Arc::downgrade(&coordinator);
        let feeds = Arc::new(FeedManager::new(
            ingest,
            Arc::new(move |id| weak.upgrade().map(|c| c.lifecycle(id)).unwrap_or_default()),
        ));
        Arc::new(ServerState {
            coordinator,
            feeds,
            grants,
            secret: Some("secret".into()),
            production: true,
            started: Instant::now(),
            ffmpeg_available: AtomicBool::new(true),
        })
    }
    async fn get(state: Arc<ServerState>, path: &str, secret: Option<&str>) -> Response<Body> {
        let mut request = HttpRequest::builder().uri(path);
        if let Some(secret) = secret {
            request = request.header("x-proxy-secret", secret);
        }
        handle(State(state), request.body(Body::empty()).unwrap()).await
    }
    async fn body(response: Response<Body>) -> Value {
        serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap()).unwrap()
    }
    #[tokio::test]
    async fn operational_routes_enforce_auth_and_withhold_diagnostics() {
        let state = fixture();
        assert_eq!(
            get(state.clone(), "/streams/channel/segment-0.ts", None)
                .await
                .status(),
            401
        );
        let public = body(get(state.clone(), "/status", None).await).await;
        assert_eq!(public["healthy"], true);
        assert_eq!(public["perSourceLimits"], json!([]));
        assert!(public.get("egressCapacity").is_none());
        assert!(public["channels"][0].get("transcodeDecision").is_none());
        assert!(public["channels"][0].get("probeResult").is_none());
        let detailed = body(get(state.clone(), "/status", Some("secret")).await).await;
        assert!(detailed.get("egressCapacity").is_some());
        assert!(detailed["channels"][0].get("transcodeDecision").is_some());
        let segment = get(
            state.clone(),
            "/streams/channel/segment-0.ts",
            Some("secret"),
        )
        .await;
        assert_eq!(segment.status(), 200);
        assert_eq!(segment.headers()["cache-control"], "public, max-age=3600");
        assert_eq!(
            to_bytes(segment.into_body(), 64).await.unwrap(),
            Bytes::from_static(b"0")
        );
        let malformed = get(
            state.clone(),
            "/streams/%2e%2e/segment-0.ts",
            Some("secret"),
        )
        .await;
        assert!(!malformed.status().is_success());
        state.coordinator.stop_all().await;
    }
    #[tokio::test]
    async fn feed_route_takes_a_loopback_feed_grant_never_the_shared_secret() {
        let state = fixture();
        let feed = "0123456789abcdef0123456789abcdef";
        let open = |path: String, peer: &str, secret: Option<&str>| {
            let mut request = HttpRequest::builder().uri(path);
            if let Some(secret) = secret {
                request = request.header("x-proxy-secret", secret);
            }
            let mut request = request.body(Body::empty()).unwrap();
            request
                .extensions_mut()
                .insert(ConnectInfo(PeerAddress(peer.parse().unwrap())));
            handle(State(state.clone()), request)
        };
        let path = format!("/streams/channel/feed.ts?feed={feed}");
        let loopback = "127.0.0.1:40000";
        // Without a grant even the shared secret opens nothing.
        let refused = open(path.clone(), loopback, Some("secret")).await;
        assert_eq!(refused.status(), 403);
        assert_eq!(body(refused).await["error"], "feed_forbidden");
        assert_eq!(
            open("/streams/channel/feed.ts".into(), loopback, None)
                .await
                .status(),
            400
        );
        let grant = state.grants.grant("channel", feed);
        assert_eq!(
            open(
                format!("/streams/other/feed.ts?feed={feed}"),
                loopback,
                None
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            open(
                "/streams/channel/feed.ts?feed=fedcba9876543210fedcba9876543210".into(),
                loopback,
                None
            )
            .await
            .status(),
            403
        );
        assert_eq!(
            open(path.clone(), "192.0.2.10:40000", None).await.status(),
            403
        );
        let granted = open(path.clone(), loopback, None).await;
        assert_eq!(granted.status(), 200);
        assert_eq!(granted.headers()["content-type"], "video/MP2T");
        drop(granted);
        drop(grant);
        assert_eq!(open(path, loopback, None).await.status(), 403);
        state.feeds.close_all();
        state.coordinator.stop_all().await;
    }
    #[tokio::test]
    async fn permission_revocation_stops_idle_pipeline_without_killing_other_viewers() {
        for shared_output in [false, true] {
            let state = encoder_fixture();
            state.coordinator.seed_test_channel("channel", json!({"sourceId":"source","maxStreams":1,"channelName":"Fixture","streamUrls":["http://127.0.0.1/fixture"]}));
            for viewer in ["child", "other"] {
                let request = json!({"viewerId":viewer,"sourceId":"source","maxStreams":1,"channelName":"Fixture","streamUrls":["http://127.0.0.1/fixture"],"allowPrivateUrls":true});
                assert_eq!(state.coordinator.join("channel", &request).await.0, 200);
            }
            assert_eq!(
                state
                    .coordinator
                    .outputs
                    .attach_variant("channel", "h264", "child")
                    .await["ok"],
                true
            );
            if shared_output {
                assert_eq!(
                    state
                        .coordinator
                        .outputs
                        .attach_variant("channel", "h264", "other")
                        .await["ok"],
                    true
                );
            }
            assert!(state.coordinator.outputs.has_active("channel"));
            for viewer in ["child", "other"] {
                let request = HttpRequest::builder()
                    .method("DELETE")
                    .uri(format!(
                        "/streams/channel/leave?viewerId={viewer}&immediate=true"
                    ))
                    .header("x-proxy-secret", "secret")
                    .body(Body::empty())
                    .unwrap();
                assert_eq!(handle(State(state.clone()), request).await.status(), 200);
                if viewer == "child" {
                    assert_eq!(
                        state.coordinator.heartbeat("channel", "other")["success"],
                        true
                    );
                    assert!(state.coordinator.ingest.snapshot("channel").is_some());
                    assert_eq!(
                        state.coordinator.outputs.has_active("channel"),
                        shared_output
                    );
                    if !shared_output {
                        assert_eq!(
                            state.coordinator.outputs.encoder_status("channel"),
                            json!([])
                        );
                    }
                }
            }
            assert!(state.coordinator.ingest.snapshot("channel").is_none());
            assert_eq!(
                state.coordinator.outputs.encoder_status("channel"),
                json!([])
            );
            assert_eq!(state.coordinator.mux_status()["channels"], json!([]));
            state.coordinator.stop_all().await;
        }
    }
    #[tokio::test]
    async fn operational_heartbeat_and_shutdown_match_control_contract() {
        let state = fixture();
        let missing = HttpRequest::builder()
            .method("POST")
            .uri("/streams/channel/heartbeat")
            .header("x-proxy-secret", "secret")
            .body(Body::empty())
            .unwrap();
        let response = handle(State(state.clone()), missing).await;
        assert_eq!(response.status(), 400);
        assert_eq!(
            body(response).await,
            json!({"error":"validation_error","message":"viewerId query parameter is required"})
        );
        let unknown = HttpRequest::builder()
            .method("POST")
            .uri("/streams/channel/heartbeat?viewerId=missing")
            .header("x-proxy-secret", "secret")
            .body(Body::empty())
            .unwrap();
        assert_eq!(handle(State(state.clone()), unknown).await.status(), 404);
        state.coordinator.begin_shutdown();
        assert_eq!(
            get(
                state.clone(),
                "/streams/channel/playlist.m3u8",
                Some("secret")
            )
            .await
            .status(),
            503
        );
        assert_eq!(
            body(get(state.clone(), "/status", None).await).await["healthy"],
            false
        );
        state.coordinator.stop_all().await;
    }
    #[tokio::test]
    async fn an_encoder_outliving_its_ingest_is_still_reported() {
        let state = encoder_fixture();
        let rung = json!({"id":"720p","height":720,"maxBitrate":2000000,"codec":"h264"});
        let options = json!({"requestedMaxBitrate":2000000,"belowLadder":false,"pinned":true,"fallback":"refuse"});
        assert_eq!(
            state
                .coordinator
                .outputs
                .attach_fixed("channel", &rung, "viewer", &options)
                .await["ok"],
            true
        );
        let detailed = body(get(state.clone(), "/status", Some("secret")).await).await;
        assert!(detailed.get("orphanedEncoders").is_none());
        assert_eq!(detailed["channels"][0]["encoders"][1]["rungId"], "720p");
        // The ingest goes away; the encoder keeps its ledger slot.
        state.coordinator.ingest.stop("channel").await.unwrap();
        let detailed = body(get(state.clone(), "/status", Some("secret")).await).await;
        assert_eq!(detailed["activeChannels"], 0);
        assert_eq!(detailed["egressCapacity"]["used"], 1);
        assert_eq!(
            detailed["orphanedEncoders"],
            json!([state.coordinator.outputs.encoder_status("channel")[0]])
        );
        assert_eq!(detailed["orphanedEncoders"][0]["channelId"], "channel");
        // Unauthenticated callers never see the inventory.
        let public = body(get(state.clone(), "/status", None).await).await;
        assert!(public.get("orphanedEncoders").is_none());
        state.coordinator.stop_all().await;
    }
    #[tokio::test]
    async fn status_error_keeps_the_last_500_characters_of_stderr() {
        let state = fixture();
        let stderr = format!("{}{}", "a".repeat(4000), "z".repeat(500));
        state
            .coordinator
            .ingest
            .set_test_failure("channel", "error", &stderr);
        let detailed = body(get(state.clone(), "/status", Some("secret")).await).await;
        assert_eq!(detailed["channels"][0]["ffmpegError"], "z".repeat(500));
        state
            .coordinator
            .ingest
            .set_test_failure("channel", "degraded", "short tail");
        let detailed = body(get(state.clone(), "/status", Some("secret")).await).await;
        assert_eq!(detailed["channels"][0]["ffmpegError"], "short tail");
        state.coordinator.stop_all().await;
    }
    async fn text(response: Response<Body>) -> String {
        String::from_utf8(
            to_bytes(response.into_body(), 64 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn masters_use_the_observed_ingest_rate_only_after_four_segments() {
        let state = encoder_fixture();
        assert_eq!(
            state
                .coordinator
                .outputs
                .attach_variant("channel", "fmp4", "viewer")
                .await["ok"],
            true
        );
        let master = text(
            get(
                state.clone(),
                "/streams/channel/v/fmp4/master.m3u8",
                Some("secret"),
            )
            .await,
        )
        .await;
        assert!(master.contains("BANDWIDTH=20000000"), "{master}");
        // Four 3 s segments of one byte each: 32 bits over 12 s.
        state
            .coordinator
            .ingest
            .publish_test("channel", 1, &[0, 1, 2, 3]);
        let master = text(
            get(
                state.clone(),
                "/streams/channel/v/fmp4/master.m3u8",
                Some("secret"),
            )
            .await,
        )
        .await;
        assert!(master.contains("BANDWIDTH=3,"), "{master}");
        state.coordinator.stop_all().await;
    }
    #[test]
    fn shutdown_drain_honours_the_variable() {
        let env = |value: &str| {
            Environment::from([("LIVETV_SHUTDOWN_DRAIN_SECONDS".into(), value.into())])
        };
        assert_eq!(shutdown_drain(&Environment::new()), Duration::from_secs(5));
        assert_eq!(shutdown_drain(&env("12")), Duration::from_secs(12));
        assert_eq!(shutdown_drain(&env("0")), Duration::from_secs(5));
        assert_eq!(shutdown_drain(&env("soon")), Duration::from_secs(5));
    }
    async fn test_server(
        router: Router,
    ) -> (
        std::net::SocketAddr,
        tokio::sync::watch::Sender<bool>,
        tokio::task::JoinHandle<std::io::Result<()>>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (stop, mut accepting) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(std::future::IntoFuture::into_future(
            axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = accepting.wait_for(|stop| *stop).await;
            }),
        ));
        (address, stop, server)
    }
    #[tokio::test]
    async fn shutdown_stops_accepting_before_egress_and_ingest_last() {
        let (address, stop_accepting, server) =
            test_server(Router::new().fallback(|| async { "ok" })).await;
        tokio::net::TcpStream::connect(address).await.unwrap();
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let outcome = graceful_shutdown(
            ShutdownPlan {
                stop_accepting,
                server,
                drain: Duration::from_secs(2),
                hard: Duration::from_secs(5),
            },
            {
                let order = order.clone();
                async move {
                    // New connections are already refused while egress is stopping.
                    tokio::time::timeout(Duration::from_secs(2), async {
                        while tokio::net::TcpStream::connect(address).await.is_ok() {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                        }
                    })
                    .await
                    .unwrap();
                    order.lock().unwrap().push("egress");
                }
            },
            {
                let order = order.clone();
                async move { order.lock().unwrap().push("ingest") }
            },
        )
        .await;
        assert_eq!(outcome, ShutdownOutcome::Clean);
        assert_eq!(*order.lock().unwrap(), ["egress", "ingest"]);
    }
    #[tokio::test]
    async fn drain_timeout_moves_on_and_still_stops_ingests() {
        let (address, stop_accepting, server) =
            test_server(Router::new().fallback(std::future::pending::<&str>)).await;
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut client, b"GET / HTTP/1.1\r\nhost: x\r\n\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let stopped = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let outcome = graceful_shutdown(
            ShutdownPlan {
                stop_accepting,
                server,
                drain: Duration::from_millis(200),
                hard: Duration::from_secs(60),
            },
            async {},
            {
                let stopped = stopped.clone();
                async move { stopped.store(true, Ordering::Release) }
            },
        )
        .await;
        assert_eq!(outcome, ShutdownOutcome::DrainTimedOut);
        assert!(stopped.load(Ordering::Acquire));
        // Far below the hard timeout: the drain limit ended the wait, not the hard stop.
        assert!(started.elapsed() < Duration::from_secs(20));
    }
    #[tokio::test]
    async fn a_hanging_shutdown_is_forced_after_the_hard_timeout() {
        let (_, stop_accepting, server) =
            test_server(Router::new().fallback(|| async { "ok" })).await;
        let started = Instant::now();
        let outcome = graceful_shutdown(
            ShutdownPlan {
                stop_accepting,
                server,
                drain: Duration::from_secs(1),
                hard: Duration::from_millis(300),
            },
            async {},
            std::future::pending::<()>(),
        )
        .await;
        assert_eq!(outcome, ShutdownOutcome::Forced);
        // The stop future never finishes; any bound proves the hard timeout ended it.
        assert!(started.elapsed() < Duration::from_secs(20));
    }
    #[tokio::test]
    async fn capability_probe_is_bounded_reaped_and_can_recover() {
        let root = std::env::temp_dir().join(format!(
            "proxy-capability-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("ffmpeg");
        let path = path.to_str().unwrap();
        assert!(!executable_available(path).await);
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        crate::test_support::seal_executable(path, 0o755);
        // A test thread forking while this file was open for writing can make the first exec
        // fail with ETXTBSY, and a loaded host can be slow to start a shell: retry a bounded
        // number of times with a generous limit instead of trusting one attempt.
        let mut available = false;
        for _ in 0..20 {
            if executable_available_within(path, Duration::from_secs(30)).await {
                available = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(available);
        let pid = root.join("pid");
        std::fs::write(
            path,
            format!(
                "#!/bin/sh\necho $$ > '{}'\nexec /bin/sleep 30\n",
                pid.display()
            ),
        )
        .unwrap();
        // A probe that never exits is bounded by its limit, killed and reaped.
        assert!(!executable_available_within(path, Duration::from_millis(500)).await);
        // The shell may have been killed before it wrote its pid; if it did write one, that
        // process must be gone (waited for, not left as a zombie or a running sleep).
        let written = std::fs::read_to_string(&pid).ok();
        if let Some(pid) = written.and_then(|pid| pid.trim().parse::<i32>().ok()) {
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
