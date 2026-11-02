// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

#[path = "upstream_routes.rs"]
mod upstream_routes;
use upstream_routes::PlaylistRoutes;

#[path = "upstream_cache.rs"]
mod upstream_cache;
#[path = "upstream_cookies.rs"]
mod upstream_cookies;
#[path = "upstream_transport.rs"]
mod upstream_transport;

use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode},
};
use bytes::Bytes;
use futures_core::Stream;
use hyper::{server::conn::http1, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use std::{
    collections::VecDeque,
    convert::Infallible,
    net::IpAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::SystemTime,
};
use tokio::{
    net::{TcpListener, lookup_host},
    sync::{Semaphore, mpsc, watch},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use upstream_cache::{LiveManifestCache, REFRESH_DEADLINE};
use upstream_cookies::UpstreamCookies;
use upstream_transport::{DEADLINE, Transport, UpstreamResponse};
use url::Url;

const MAX_PLAYLIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_URL_BYTES: usize = 64 * 1024;
/// Bytes of a provider's error body kept for classification (`classify_upstream`).
const STATUS_SNIPPET_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GuardFailureInfo {
    pub status: u16,
    pub diagnostic: &'static str,
}

impl GuardFailureInfo {
    fn forbidden(diagnostic: &'static str) -> Self {
        Self {
            status: 403,
            diagnostic,
        }
    }
    fn timeout(diagnostic: &'static str) -> Self {
        Self {
            status: 504,
            diagnostic,
        }
    }
    fn connection() -> Self {
        Self {
            status: 502,
            diagnostic: "upstream connection failed",
        }
    }
}

/// Active outcomes for one ingest attempt, fenced by request ticket. A genuine
/// newer success clears failures; protected refreshes update historical evidence only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelaySignals {
    /// Latest unprotected provider failure and up to 512 bytes of its body.
    pub upstream: Option<(u16, String)>,
    /// The relay's own last refusal.
    pub guard: Option<GuardFailureInfo>,
    /// A 2xx answer with data arrived during this attempt.
    pub connected: bool,
    /// Successfully protected refreshes; no URL, body or credentials are retained.
    pub protected_refreshes: u64,
}

/// Read access to a relay's signals that outlives nothing but the relay's own state.
#[derive(Clone)]
pub struct RelaySignalsHandle(Arc<State>);

impl RelaySignalsHandle {
    pub fn read(&self) -> RelaySignals {
        let active = self
            .0
            .active_signals
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        RelaySignals {
            upstream: active.upstream.clone(),
            guard: active.guard,
            connected: active.connected,
            protected_refreshes: self
                .0
                .protected_refreshes
                .load(std::sync::atomic::Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
struct ActiveSignals {
    ticket: Option<u64>,
    failure_ticket: Option<u64>,
    upstream: Option<(u16, String)>,
    guard: Option<GuardFailureInfo>,
    connected: bool,
}

#[derive(Default)]
struct UpstreamObservation(Mutex<Option<(u16, String)>>);
impl UpstreamObservation {
    fn record(&self, status: u16, body: &[u8]) {
        if status >= 400 {
            *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((
                status,
                String::from_utf8_lossy(&body[..body.len().min(STATUS_SNIPPET_BYTES)]).into_owned(),
            ));
        }
    }
    fn read(&self) -> Option<(u16, String)> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

struct State {
    origin: String,
    token: String,
    transport: Transport,
    cookies: Mutex<UpstreamCookies>,
    playlists: Mutex<VecDeque<String>>,
    observed_hls: std::sync::atomic::AtomicBool,
    manifest_cache: Mutex<LiveManifestCache>,
    playlist_routes: Mutex<PlaylistRoutes>,
    request_ticket: std::sync::atomic::AtomicU64,
    active_signals: Mutex<ActiveSignals>,
    protected_refreshes: std::sync::atomic::AtomicU64,
    shutdown: watch::Sender<bool>,
    producers: Mutex<JoinSet<()>>,
}

/// A per-ingest HTTP boundary. Children and redirects can only reach checked sockets.
pub struct UpstreamGuard {
    state: Arc<State>,
    server: Mutex<Option<JoinHandle<()>>>,
}

impl UpstreamGuard {
    pub async fn start(allow_private: bool, proxy: &str) -> Result<Self, String> {
        Self::with_transport(Transport::new(allow_private, proxy)?).await
    }

    async fn with_transport(transport: Transport) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "upstream relay bind failed")?;
        let address = listener
            .local_addr()
            .map_err(|_| "upstream relay address unavailable")?;
        // Any local process can reach this port; only URLs carrying this unguessable
        // path token are relayed, so the relay is not a fetch proxy for them.
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).map_err(|_| "upstream relay token unavailable")?;
        let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let (shutdown, mut stopped) = watch::channel(false);
        let state = Arc::new(State {
            origin: format!("http://{address}/r/{token}"),
            token,
            transport,
            cookies: Mutex::new(UpstreamCookies::default()),
            playlists: Mutex::new(VecDeque::new()),
            observed_hls: std::sync::atomic::AtomicBool::new(false),
            manifest_cache: Mutex::new(LiveManifestCache::default()),
            playlist_routes: Mutex::new(PlaylistRoutes::default()),
            request_ticket: std::sync::atomic::AtomicU64::new(0),
            active_signals: Mutex::new(ActiveSignals::default()),
            protected_refreshes: std::sync::atomic::AtomicU64::new(0),
            shutdown,
            producers: Mutex::new(JoinSet::new()),
        });
        let shared = state.clone();
        let server = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            let permits = Arc::new(Semaphore::new(64));
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    Some(_) = connections.join_next(), if !connections.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((socket, _)) = accepted else { break };
                        let Ok(permit) = permits.clone().try_acquire_owned() else { continue };
                        let state = shared.clone();
                        connections.spawn(async move {
                            let _permit = permit;
                            let service = service_fn(move |request| handle(state.clone(), request));
                            let mut builder = http1::Builder::new();
                            builder.max_buf_size(64 * 1024).keep_alive(false).timer(TokioTimer::new()).header_read_timeout(DEADLINE);
                            let _ = builder.serve_connection(TokioIo::new(socket), service).await;
                        });
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Ok(Self {
            state,
            server: Mutex::new(Some(server)),
        })
    }

    pub fn stream_url(&self, url: &str) -> Result<String, String> {
        let parsed = parse_target(url).map_err(|failure| failure.diagnostic.to_owned())?;
        relay_url(&self.state.origin, &parsed).map_err(|failure| failure.diagnostic.to_owned())
    }

    /// A complete HLS response was successfully rewritten during this ingest attempt.
    /// This includes master/redirected/extensionless playlists, without another request.
    pub fn observed_hls(&self) -> bool {
        self.state
            .observed_hls
            .load(std::sync::atomic::Ordering::Acquire)
    }

    pub fn failed(&self) -> bool {
        self.failure().is_some()
    }
    pub fn failure(&self) -> Option<GuardFailureInfo> {
        self.state
            .active_signals
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .guard
    }
    pub fn signals(&self) -> RelaySignalsHandle {
        RelaySignalsHandle(self.state.clone())
    }

    pub async fn shutdown(&self) {
        self.state.shutdown.send_replace(true);
        self.state
            .playlist_routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.state
            .manifest_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        let task = self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(task) = task {
            let _ = task.await;
        }
        let mut producers = std::mem::take(
            &mut *self
                .state
                .producers
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        producers.abort_all();
        while producers.join_next().await.is_some() {}
        self.state.transport.shutdown().await;
    }
}

impl Drop for UpstreamGuard {
    fn drop(&mut self) {
        self.state.shutdown.send_replace(true);
        self.state
            .playlist_routes
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.state
            .manifest_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.state.transport.abort_all();
        self.state
            .producers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .abort_all();
        if let Some(task) = self.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
            task.abort();
        }
    }
}

/// Direct RTSP/RTMP admission. RTSP can redirect FFmpeg outside the checked address,
/// even over TCP, so it requires explicit private-network access. Native RTMP in
/// the pinned FFmpeg does not follow connect redirects; when private targets are
/// disallowed its checked address replaces the host to prevent DNS rebinding.
pub async fn validate_direct_input(url: &str, allow_private: bool) -> Result<String, String> {
    if url.len() > MAX_URL_BYTES {
        return Err("invalid stream URL".into());
    }
    let parsed = Url::parse(url).map_err(|_| "invalid stream URL")?;
    if !matches!(parsed.scheme(), "rtsp" | "rtmp") || parsed.host_str().is_none() {
        return Err("unsupported direct stream protocol".into());
    }
    if allow_private {
        return Ok(url.to_owned());
    }
    if parsed.scheme() == "rtsp" {
        return Err(
            "RTSP requires LIVETV_ALLOW_PRIVATE_URLS because FFmpeg follows unchecked redirects"
                .into(),
        );
    }
    let address = resolve_address(&parsed, false)
        .await
        .map_err(|error| error.diagnostic.to_owned())?;
    pinned_url(parsed, address)
}

fn pinned_url(mut url: Url, address: IpAddr) -> Result<String, String> {
    url.set_ip_host(address)
        .map_err(|_| "invalid stream URL".to_owned())?;
    Ok(url.into())
}

/// The relay path after the guard's token, or None when the token is missing or wrong.
fn authorized_path<'a>(state: &State, path: &'a str) -> Option<&'a str> {
    use subtle::ConstantTimeEq;
    let (token, rest) = path.strip_prefix("/r/")?.split_once('/')?;
    bool::from(token.as_bytes().ct_eq(state.token.as_bytes()))
        .then_some(&path[path.len() - rest.len() - 1..])
}

async fn resolve_address(url: &Url, allow_private: bool) -> Result<IpAddr, GuardFailureInfo> {
    let host = url
        .host_str()
        .ok_or_else(GuardFailureInfo::connection)?
        .trim_matches(['[', ']']);
    let addresses: Vec<_> = if let Ok(address) = host.parse::<IpAddr>() {
        vec![address]
    } else {
        timeout(DEADLINE, lookup_host((host, 0)))
            .await
            .map_err(|_| GuardFailureInfo::timeout("upstream DNS timeout"))?
            .map_err(|_| GuardFailureInfo::connection())?
            .map(|socket| socket.ip())
            .collect()
    };
    checked_address(&addresses, allow_private)
}

fn checked_address(addresses: &[IpAddr], allow_private: bool) -> Result<IpAddr, GuardFailureInfo> {
    if !allow_private && addresses.iter().any(|address| private_ip(*address)) {
        return Err(GuardFailureInfo::forbidden("private upstream destination"));
    }
    addresses
        .first()
        .copied()
        .ok_or_else(GuardFailureInfo::connection)
}

fn private_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let val = u32::from(address);
            [
                (0x0a000000, 8),
                (0xac100000, 12),
                (0xc0a80000, 16),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0x64400000, 10),
                (0, 8),
                (0xc0000000, 24),
                (0xc6120000, 15),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(prefix, bits)| val >> (32 - bits) == prefix >> (32 - bits))
        }
        IpAddr::V6(address) => {
            let val = u128::from(address);
            if val >> 32 == 0x0064ff9b0000000000000000 {
                return private_ip(IpAddr::V4((val as u32).into()));
            }
            [
                (0, 96),
                (0xfc00u128 << 112, 7),
                (0xfe80u128 << 112, 10),
                (0xfec0u128 << 112, 10),
                (0xff00u128 << 112, 8),
                (0x0064ff9b0001u128 << 80, 48),
                (0xffffu128 << 32, 96),
            ]
            .iter()
            .any(|(prefix, bits)| val >> (128 - bits) == prefix >> (128 - bits))
        }
    }
}

fn parse_target(value: &str) -> Result<Url, GuardFailureInfo> {
    if value.len() > MAX_URL_BYTES {
        return Err(GuardFailureInfo::forbidden("invalid upstream target"));
    }
    let url =
        Url::parse(value).map_err(|_| GuardFailureInfo::forbidden("invalid upstream target"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(GuardFailureInfo::forbidden("unsupported upstream protocol"));
    }
    Ok(url)
}

fn relay_url(origin: &str, target: &Url) -> Result<String, GuardFailureInfo> {
    if target.as_str().len() > MAX_URL_BYTES {
        return Err(GuardFailureInfo::forbidden("invalid upstream target"));
    }
    let suffix = target.path().rsplit('.').next().filter(|part| {
        !part.is_empty() && part.len() <= 8 && part.bytes().all(|b| b.is_ascii_alphanumeric())
    });
    let extension = if target.path().contains('.') {
        suffix.unwrap_or("ts")
    } else {
        "ts"
    };
    let mut url = Url::parse(&format!("{origin}/upstream.{extension}"))
        .map_err(|_| GuardFailureInfo::connection())?;
    url.query_pairs_mut().append_pair("url", target.as_str());
    Ok(url.into())
}

fn strip_hop_headers(headers: &mut HeaderMap) {
    let extra: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|v| v.trim().to_owned())
        .collect();
    for key in extra {
        headers.remove(key.as_str());
    }
    for key in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ] {
        headers.remove(key);
    }
}

async fn fetch(
    state: &State,
    target: &Url,
    method: &Method,
    headers: &HeaderMap,
) -> Result<UpstreamResponse, GuardFailureInfo> {
    let mut headers = headers.clone();
    strip_hop_headers(&mut headers);
    for key in ["authorization", "cookie", "host", "content-length"] {
        headers.remove(key);
    }
    headers.insert("accept-encoding", HeaderValue::from_static("identity"));
    if state
        .playlists
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|url| url == target.as_str())
    {
        headers.remove("range");
    }
    if let Some(cookie) = state
        .cookies
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(target, SystemTime::now())
    {
        headers.insert(
            "cookie",
            HeaderValue::from_str(&cookie).map_err(|_| GuardFailureInfo::connection())?,
        );
    }
    let response = state.transport.request(target, method, headers).await?;
    for value in response
        .headers
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
    {
        state.cookies.lock().unwrap_or_else(|e| e.into_inner()).set(
            target,
            value,
            SystemTime::now(),
        );
    }
    Ok(response)
}

async fn handle(
    state: Arc<State>,
    request: Request<hyper::body::Incoming>,
) -> Result<Response<Body>, Infallible> {
    // An unauthorized local caller is not an upstream failure of this ingest.
    if authorized_path(&state, request.uri().path()).is_none() {
        return Ok(Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap());
    }
    let ticket = state
        .request_ticket
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let result = relay(state.clone(), request, ticket).await;
    Ok(match result {
        Ok(response) => response,
        Err(failure) => {
            record_guard(&state, ticket, failure);
            Response::builder()
                .status(failure.status)
                .body(Body::empty())
                .unwrap()
        }
    })
}

/// How much of a body is read to decide whether it is a playlist.
const PLAYLIST_PREFIX_BYTES: usize = 64;

/// The bytes after an optional UTF-8 BOM and ASCII whitespace.
fn without_leading_blanks(bytes: &[u8]) -> &[u8] {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let start = bytes
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .unwrap_or(bytes.len());
    &bytes[start..]
}

/// `#EXTM3U` after an optional UTF-8 BOM and ASCII whitespace; case-sensitive, as in HLS.
fn is_playlist_prefix(bytes: &[u8]) -> bool {
    without_leading_blanks(bytes).starts_with(b"#EXTM3U")
}

/// More bytes could still turn this into a playlist (only blanks or a partial tag so far).
fn playlist_undecided(bytes: &[u8]) -> bool {
    let rest = without_leading_blanks(bytes);
    rest.len() < 7 && b"#EXTM3U".starts_with(rest)
}

async fn prefix(response: &mut UpstreamResponse) -> Result<(Vec<u8>, bool), GuardFailureInfo> {
    let mut bytes = Vec::new();
    // 16 bytes always; up to 64 only while the start is still blanks or a partial tag, so
    // a short raw stream is never held back waiting for bytes that may not come.
    while bytes.len() < PLAYLIST_PREFIX_BYTES && (bytes.len() < 16 || playlist_undecided(&bytes)) {
        match response.next().await? {
            Some(chunk) => bytes.extend_from_slice(&chunk),
            None => break,
        }
    }
    let playlist = is_playlist_prefix(&bytes);
    Ok((bytes, playlist))
}

fn record_failure(
    state: &State,
    ticket: u64,
    upstream: Option<(u16, String)>,
    guard: Option<GuardFailureInfo>,
) {
    let mut active = state
        .active_signals
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if active.failure_ticket.is_some_and(|latest| ticket < latest) {
        return;
    }
    active.ticket = Some(active.ticket.map_or(ticket, |latest| latest.max(ticket)));
    active.failure_ticket = Some(ticket);
    active.upstream = upstream;
    active.guard = guard;
}
fn record_guard(state: &State, ticket: u64, failure: GuardFailureInfo) {
    let mut active = state
        .active_signals
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if active.failure_ticket.is_some_and(|latest| ticket < latest) {
        return;
    }
    if active.failure_ticket != Some(ticket) {
        active.upstream = None;
    }
    active.ticket = Some(active.ticket.map_or(ticket, |latest| latest.max(ticket)));
    active.failure_ticket = Some(ticket);
    active.guard = Some(failure);
}
fn record_connected(state: &State, ticket: u64) {
    let mut active = state
        .active_signals
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if active.ticket.is_some_and(|latest| ticket < latest) {
        return;
    }
    active.ticket = Some(ticket);
    active.failure_ticket = None;
    active.upstream = None;
    active.guard = None;
    active.connected = true;
}
fn protected_refresh(state: &State, _ticket: u64, status: u16) {
    // Historical evidence only: a protected response is not upstream recovery and
    // cannot replace or clear another request's unresolved failure.
    state
        .protected_refreshes
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[UpstreamGuard] protected refresh status={status}");
}

fn uncompressed(response: &UpstreamResponse) -> Result<(), GuardFailureInfo> {
    if response
        .headers
        .get("content-encoding")
        .is_some_and(|value| value != "identity")
    {
        return Err(GuardFailureInfo {
            status: 502,
            diagnostic: "compressed upstream response refused",
        });
    }
    Ok(())
}

fn retryable_status(status: u16) -> bool {
    matches!(status, 500 | 502 | 503 | 504)
}

/// Statuses that mean a pinned (typically signed) destination has expired.
fn is_refusal(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 410)
}

/// Consecutive transport or 5xx failures after which a pinned destination is abandoned.
const PIN_FAILURE_LIMIT: u32 = 3;

/// A connect, DNS, TLS or timeout failure. Address refusals (403) are a security
/// decision, not a dead server, and never count.
fn transport_failure(failure: &GuardFailureInfo) -> bool {
    failure.diagnostic == "upstream connection failed" || failure.status == 504
}

fn cached_manifest(state: &State, key: &str) -> Option<Response<Body>> {
    if *state.shutdown.borrow() {
        return None;
    }
    let body = state
        .manifest_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key, std::time::Instant::now())?;
    Some(
        Response::builder()
            .status(200)
            .header("content-type", "application/vnd.apple.mpegurl")
            .header("content-length", body.len())
            .body(Body::from(body))
            .unwrap(),
    )
}

async fn relay(
    state: Arc<State>,
    request: Request<hyper::body::Incoming>,
    ticket: u64,
) -> Result<Response<Body>, GuardFailureInfo> {
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return Err(GuardFailureInfo::forbidden("unsupported request method"));
    }
    let path = authorized_path(&state, request.uri().path()).unwrap_or("");
    if path.len() > 64 || !path.starts_with("/upstream.") {
        return Err(GuardFailureInfo::forbidden("invalid upstream target"));
    }
    let query = request.uri().query().unwrap_or("");
    if query.len() > MAX_URL_BYTES * 3 + 16 {
        return Err(GuardFailureInfo::forbidden("invalid upstream target"));
    }
    let target = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();
    let target = parse_target(&target)?;
    let key = target.to_string();
    let head = *request.method() == Method::HEAD;
    let fresh = !head && cached_manifest(&state, &key).is_some();
    state
        .manifest_cache
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .begin(ticket);
    let observation = UpstreamObservation::default();
    let pinned = {
        let mut routes = state
            .playlist_routes
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // HEAD uses the pin read-only: it neither refreshes it nor judges it.
        if head {
            routes.peek(&key)
        } else {
            routes.get(&key)
        }
    };
    let watched = pinned.clone().filter(|_| !head);
    // One deadline covers the first attempt and any renewal.
    let deadline = fresh.then(|| std::time::Instant::now() + REFRESH_DEADLINE);
    let renewing = std::sync::atomic::AtomicBool::new(false);
    let work = async {
        let stale_pin = std::sync::atomic::AtomicBool::new(false);
        let mut result = relay_target(
            state.clone(),
            pinned.clone().unwrap_or_else(|| target.clone()),
            request.method().clone(),
            request.headers().clone(),
            RefreshAttempt {
                key: &key,
                ticket,
                observation: &observation,
                until: deadline,
                renewable: watched.is_some(),
                renewed: false,
                stale_pin: &stale_pin,
            },
        )
        .await;
        let Some(pin) = watched.as_ref() else {
            return result;
        };
        let observed = observation.read().map_or(0, |(status, _)| status);
        let refused = stale_pin.load(std::sync::atomic::Ordering::Relaxed)
            || match &result {
                Ok(response) => is_refusal(response.status().as_u16()),
                Err(_) => is_refusal(observed),
            };
        // Some(tombstoned) when the pin must be replaced now.
        let mut replace = None;
        if refused {
            replace = Some(
                state
                    .playlist_routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set(&key, None, ticket),
            );
        } else {
            let failed = match &result {
                Ok(response) => response.status().as_u16() >= 500,
                Err(failure) => transport_failure(failure) || observed >= 500,
            };
            let mut routes = state
                .playlist_routes
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if failed {
                replace = routes.fail(&key, pin, ticket, PIN_FAILURE_LIMIT);
            } else if result.is_ok() {
                routes.reset(&key, pin);
            }
        }
        let Some(tombstoned) = replace else {
            return result;
        };
        // A request fenced out by a newer pin follows that pin instead of its own stale
        // verdict; after shutdown there is nothing to follow.
        let next = if tombstoned {
            Some(target.clone())
        } else if *state.shutdown.borrow() {
            None
        } else {
            let current = state
                .playlist_routes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key);
            (current.as_ref() != Some(pin)).then(|| current.unwrap_or_else(|| target.clone()))
        };
        let Some(next) = next else {
            if refused && is_refusal(observed) {
                // The refusal stands, so a cached manifest must not mask it.
                state
                    .manifest_cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key, ticket);
            }
            return result;
        };
        renewing.store(true, std::sync::atomic::Ordering::Relaxed);
        *observation.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
        result = relay_target(
            state.clone(),
            next,
            request.method().clone(),
            request.headers().clone(),
            RefreshAttempt {
                key: &key,
                ticket,
                observation: &observation,
                until: deadline,
                renewable: false,
                renewed: tombstoned,
                stale_pin: &stale_pin,
            },
        )
        .await;
        result
    };
    let result = match deadline {
        Some(deadline) => {
            match tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), work).await {
                Ok(result) => result,
                Err(_) => {
                    // A pinned host too slow for the refresh deadline is failing too.
                    if let Some(pin) = watched.as_ref()
                        && !renewing.load(std::sync::atomic::Ordering::Relaxed)
                    {
                        state
                            .playlist_routes
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .fail(&key, pin, ticket, PIN_FAILURE_LIMIT);
                    }
                    Err(GuardFailureInfo::timeout(
                        "upstream manifest refresh timeout",
                    ))
                }
            }
        }
        None => work.await,
    };
    match result {
        Ok(response) => {
            if fresh
                && retryable_status(response.status().as_u16())
                && let Some(cached) = cached_manifest(&state, &key)
            {
                protected_refresh(&state, ticket, response.status().as_u16());
                return Ok(cached);
            }
            if let Some(upstream) = observation.read() {
                record_failure(&state, ticket, Some(upstream), None);
            }
            Ok(response)
        }
        Err(failure) => {
            let upstream = observation.read();
            let observed = upstream.as_ref().map_or(0, |(status, _)| *status);
            let transient =
                failure.diagnostic == "upstream connection failed" || failure.status == 504;
            if !transient {
                state
                    .manifest_cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&key, ticket);
            }
            if fresh
                && transient
                && (observed < 400 || retryable_status(observed))
                && let Some(cached) = cached_manifest(&state, &key)
            {
                protected_refresh(&state, ticket, failure.status);
                return Ok(cached);
            }
            record_failure(&state, ticket, upstream, Some(failure));
            if observed >= 400 && !retryable_status(observed) {
                return Ok(Response::builder()
                    .status(observed)
                    .body(Body::empty())
                    .unwrap());
            }
            Err(failure)
        }
    }
}

struct RefreshAttempt<'a> {
    key: &'a str,
    ticket: u64,
    observation: &'a UpstreamObservation,
    until: Option<std::time::Instant>,
    /// First attempt against a pin that may be replaced: refusals leave the cache alone
    /// (the caller removes it only once a renewal answered) and a non-playlist 200 is
    /// reported through `stale_pin`.
    renewable: bool,
    /// The pin was dropped and the entry URL is resolved again: the renewed manifest
    /// replaces the cached one.
    renewed: bool,
    stale_pin: &'a std::sync::atomic::AtomicBool,
}

async fn relay_target(
    state: Arc<State>,
    mut target: Url,
    method: Method,
    mut headers: HeaderMap,
    attempt: RefreshAttempt<'_>,
) -> Result<Response<Body>, GuardFailureInfo> {
    let RefreshAttempt {
        key,
        ticket,
        observation,
        until: refresh_until,
        renewable,
        renewed,
        stale_pin,
    } = attempt;
    let mut response;
    let mut hop = 0;
    loop {
        response = fetch(&state, &target, &method, &headers).await?;
        if !matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            break;
        }
        if hop >= 10 {
            return Err(GuardFailureInfo {
                status: 502,
                diagnostic: "invalid upstream redirect",
            });
        }
        let location = response
            .headers
            .get("location")
            .and_then(|v| v.to_str().ok())
            .ok_or(GuardFailureInfo {
                status: 502,
                diagnostic: "invalid upstream redirect",
            })?;
        let next = target.join(location).map_err(|_| GuardFailureInfo {
            status: 502,
            diagnostic: "invalid upstream redirect",
        })?;
        parse_target(next.as_str())?;
        target = next;
        hop += 1;
    }
    observation.record(response.status.as_u16(), &[]);
    if response.status.as_u16() >= 400 {
        observation.record(response.status.as_u16(), &[]);
        if !retryable_status(response.status.as_u16())
            && !(renewable && is_refusal(response.status.as_u16()))
        {
            state
                .manifest_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(key, ticket);
        }
    }
    uncompressed(&response)?;
    if method == Method::HEAD {
        if response.status.as_u16() >= 400 {
            observation.record(response.status.as_u16(), &[]);
        }
        let mut output = Response::new(Body::empty());
        *output.status_mut() = response.status;
        *output.headers_mut() = response.headers.clone();
        strip_hop_headers(output.headers_mut());
        output.headers_mut().remove("set-cookie");
        return Ok(output);
    }
    let (mut first, mut is_playlist) = prefix(&mut response).await?;
    let known = state
        .playlists
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .any(|url| url == target.as_str());
    let typed = response
        .headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("mpegurl"));
    if response.status == StatusCode::PARTIAL_CONTENT
        && (is_playlist || known || target.path().to_ascii_lowercase().ends_with(".m3u8") || typed)
    {
        drop(response);
        headers.remove("range");
        response = fetch(&state, &target, &method, &headers).await?;
        observation.record(response.status.as_u16(), &[]);
        if response.status.as_u16() >= 400 {
            observation.record(response.status.as_u16(), &[]);
            if !retryable_status(response.status.as_u16())
                && !(renewable && is_refusal(response.status.as_u16()))
            {
                state
                    .manifest_cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(key, ticket);
            }
        }
        uncompressed(&response)?;
        if response.status != StatusCode::OK && response.status.as_u16() < 400 {
            return Err(GuardFailureInfo {
                status: 502,
                diagnostic: "incomplete upstream playlist",
            });
        }
        (first, is_playlist) = prefix(&mut response).await?;
        if !is_playlist && response.status == StatusCode::OK {
            return Err(GuardFailureInfo {
                status: 502,
                diagnostic: "invalid upstream playlist",
            });
        }
    }
    if renewable && response.status == StatusCode::OK && !is_playlist {
        // A pin only exists for a destination that served a playlist: a 200 that is
        // not one means the provider moved on (login page, error page).
        stale_pin.store(true, std::sync::atomic::Ordering::Relaxed);
        return Err(GuardFailureInfo::connection());
    }
    if response.status.as_u16() >= 400 {
        // The bytes stay in `first` and are forwarded unchanged; only error bodies
        // (small by nature) are read ahead like this.
        while first.len() < STATUS_SNIPPET_BYTES {
            match response.next().await? {
                Some(chunk) => first.extend_from_slice(&chunk),
                None => break,
            }
        }
        observation.record(response.status.as_u16(), &first);
    }
    if !is_playlist && !first.is_empty() && response.status.is_success() {
        record_connected(&state, ticket);
    }

    let mut out_headers = response.headers.clone();
    strip_hop_headers(&mut out_headers);
    out_headers.remove("set-cookie");
    let status = response.status;
    let body = if is_playlist {
        {
            let mut known = state.playlists.lock().unwrap_or_else(|e| e.into_inner());
            known.retain(|url| url != target.as_str());
            known.push_back(target.to_string());
            while known.len() > 256 {
                known.pop_front();
            }
        }
        if first.len() > MAX_PLAYLIST_BYTES {
            return Err(GuardFailureInfo {
                status: 502,
                diagnostic: "upstream playlist too large",
            });
        }
        while let Some(bytes) = response.next().await? {
            if first.len().saturating_add(bytes.len()) > MAX_PLAYLIST_BYTES {
                return Err(GuardFailureInfo {
                    status: 502,
                    diagnostic: "upstream playlist too large",
                });
            }
            first.extend_from_slice(&bytes);
        }
        let rewritten = rewrite_playlist(&String::from_utf8_lossy(&first), &target, &state.origin)?;
        if refresh_until.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
            return Err(GuardFailureInfo::timeout(
                "upstream manifest refresh timeout",
            ));
        }
        if status.is_success() && !*state.shutdown.borrow() && response.clean_end {
            record_connected(&state, ticket);
            if target.as_str() != key
                && Url::parse(key).is_ok_and(|entry| pin_allowed(&entry, &target))
            {
                state
                    .playlist_routes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set(key, Some(target.clone()), ticket);
            }
            let mut cache = state
                .manifest_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if renewed {
                cache.reset_for_renewal(key, ticket);
            }
            cache.put(key, &rewritten, ticket, std::time::Instant::now());
            drop(cache);
            state
                .observed_hls
                .store(true, std::sync::atomic::Ordering::Release);
        }
        for key in ["content-encoding", "etag", "content-range", "accept-ranges"] {
            out_headers.remove(key);
        }
        out_headers.insert(
            "content-type",
            HeaderValue::from_static("application/vnd.apple.mpegurl"),
        );
        out_headers.insert(
            "content-length",
            HeaderValue::from_str(&rewritten.len().to_string())
                .map_err(|_| GuardFailureInfo::connection())?,
        );
        Body::from(rewritten)
    } else {
        if status.is_success() {
            state
                .manifest_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .discard(key, ticket);
        }
        let (sender, receiver) = mpsc::channel(2);
        let shared = state.clone();
        let mut stopped = state.shutdown.subscribe();
        let mut producers = state.producers.lock().unwrap_or_else(|e| e.into_inner());
        while producers.try_join_next().is_some() {}
        producers.spawn(async move {
            if sender.send(Ok(Bytes::from(first))).await.is_err() { return; }
            loop {
                let next = tokio::select! {
                    biased;
                    _ = stopped.changed() => break,
                    _ = sender.closed() => break,
                    next = response.next() => next,
                };
                match next {
                    Ok(Some(bytes)) => {
                        // A paced consumer (FFmpeg readrate/prefetch) can stop reading
                        // longer than the upstream inactivity limit. This wait is local
                        // backpressure, not a failed provider. Shutdown/disconnect still
                        // drops the body and closes its owned upstream connection.
                        let sent = tokio::select! { _ = stopped.changed() => break, sent = sender.send(Ok(bytes)) => sent };
                        if sent.is_err() { break; }
                    }
                    Ok(None) => break,
                    Err(failure) => {
                        record_guard(&shared,ticket,failure);
                        let _ = sender.try_send(Err(std::io::Error::other(failure.diagnostic)));
                        break;
                    }
                }
            }
        });
        Body::from_stream(ReceiverStream(receiver))
    };
    let mut output = Response::new(body);
    *output.status_mut() = status;
    *output.headers_mut() = out_headers;
    Ok(output)
}

struct ReceiverStream(mpsc::Receiver<Result<Bytes, std::io::Error>>);
impl Stream for ReceiverStream {
    type Item = Result<Bytes, std::io::Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.0.poll_recv(cx)
    }
}

fn rewrite_playlist(body: &str, target: &Url, origin: &str) -> Result<String, GuardFailureInfo> {
    let mut rewritten = String::new();
    for (index, line) in body.split('\n').enumerate() {
        let rewritten_line = (|| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            if line.trim().is_empty() {
                return Ok(line.to_owned());
            }
            if !line.trim_start().starts_with('#') {
                let child = target
                    .join(line.trim())
                    .map_err(|_| GuardFailureInfo::forbidden("invalid upstream target"))?;
                return relay_url(origin, &child);
            }
            let mut output = String::new();
            let mut remaining = line;
            while let Some(position) = remaining.find("URI") {
                let before = &remaining[..position];
                let candidate = &remaining[position + 3..];
                if position > 0 && remaining.as_bytes()[position - 1].is_ascii_alphanumeric() {
                    output.push_str(&remaining[..position + 3]);
                    remaining = candidate;
                    continue;
                }
                let Some(value) = candidate.trim_start().strip_prefix('=') else {
                    output.push_str(&remaining[..position + 3]);
                    remaining = candidate;
                    continue;
                };
                let value = value.trim_start();
                let failure = || GuardFailureInfo::forbidden("invalid upstream URI attribute");
                let Some(quoted) = value.strip_prefix('"') else {
                    return Err(failure());
                };
                let Some(end) = quoted.find('"') else {
                    return Err(failure());
                };
                let uri = &quoted[..end];
                if uri.contains('\\') {
                    return Err(failure());
                }
                let child = target.join(uri).map_err(|_| failure())?;
                output.push_str(before);
                output.push_str(&format!("URI=\"{}\"", relay_url(origin, &child)?));
                remaining = &quoted[end + 1..];
            }
            output.push_str(remaining);
            Ok(output)
        })()?;
        if rewritten
            .len()
            .saturating_add(rewritten_line.len())
            .saturating_add(1)
            > MAX_PLAYLIST_BYTES * 4
        {
            return Err(GuardFailureInfo::connection());
        }
        if index > 0 {
            rewritten.push('\n');
        }
        rewritten.push_str(&rewritten_line);
    }
    Ok(rewritten)
}

/// A redirect chain may not move a pin from https to plain http.
fn pin_allowed(entry: &Url, resolved: &Url) -> bool {
    !(entry.scheme() == "https" && resolved.scheme() == "http")
}

#[cfg(test)]
#[path = "upstream_backpressure_tests.rs"]
mod backpressure_tests;
#[cfg(test)]
#[path = "upstream_pin_tests.rs"]
mod pin_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Fixture {
        origin: String,
        task: JoinHandle<()>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    async fn fixture(f: impl Fn(&str) -> String + Send + Sync + 'static) -> Fixture {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let f = Arc::new(f);
        let task = tokio::spawn(async move {
            let mut tasks = JoinSet::new();
            loop {
                tokio::select! {
                    Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
                    accepted = listener.accept() => {
                        let (mut stream,_) = accepted.unwrap();
                        let f = f.clone();
                        tasks.spawn(async move {
                            let mut request = Vec::new();
                            let mut byte = [0];
                            while !request.ends_with(b"\r\n\r\n") && request.len() < 100_000 {
                                if stream.read(&mut byte).await.unwrap_or(0) == 0 { return; }
                                request.push(byte[0]);
                            }
                            let response = f(&String::from_utf8_lossy(&request));
                            let _ = stream.write_all(response.as_bytes()).await;
                        });
                    }
                }
            }
        });
        Fixture { origin, task }
    }
    fn response(status: u16, headers: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status} Test\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n{body}",
            body.len()
        )
    }
    async fn request(url: &str, headers: &str) -> (u16, String, String) {
        let url = Url::parse(url).unwrap();
        let mut stream =
            tokio::net::TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
                .await
                .unwrap();
        let request = format!(
            "GET {}?{} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{headers}\r\n",
            url.path(),
            url.query().unwrap_or("")
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        timeout(DEADLINE * 2, stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        let response = String::from_utf8(response).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        (
            headers.split_whitespace().nth(1).unwrap().parse().unwrap(),
            headers.to_owned(),
            body.to_owned(),
        )
    }

    fn live_media() -> &'static str {
        "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:3,\nsegment.ts\n"
    }

    #[tokio::test]
    async fn redirected_playlist_sticks_and_renews_expiry_once() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let entries = Arc::new(AtomicUsize::new(0));
        let expired = Arc::new(AtomicBool::new(false));
        let seen = entries.clone();
        let expiry = expired.clone();
        let forward = fixture(move |r| {
            if r.starts_with("GET http://8.8.8.8/entry ") {
                let n = seen.fetch_add(1, Ordering::Relaxed);
                response(
                    302,
                    if n == 0 {
                        "Location: /a\r\n"
                    } else {
                        "Location: /b\r\n"
                    },
                    "",
                )
            } else if r.starts_with("GET http://8.8.8.8/a ") {
                if expiry.load(Ordering::Relaxed) {
                    response(403, "", "expired")
                } else {
                    response(200, "", live_media())
                }
            } else if r.starts_with("GET http://8.8.8.8/b ") {
                response(
                    200,
                    "",
                    &live_media().replace("SEQUENCE:10", "SEQUENCE:100"),
                )
            } else {
                response(404, "", "missing")
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
        for _ in 0..3 {
            let r = request(&url, "").await;
            assert_eq!(r.0, 200);
            assert!(r.2.contains("SEQUENCE:10\n"));
        }
        assert_eq!(entries.load(Ordering::Relaxed), 1);
        expired.store(true, Ordering::Relaxed);
        let r = request(&url, "").await;
        assert_eq!(r.0, 200);
        assert!(r.2.contains("SEQUENCE:100\n"));
        assert_eq!(entries.load(Ordering::Relaxed), 2);
        assert!(guard.failure().is_none());
        assert_eq!(request(&url, "").await.0, 200);
        assert_eq!(entries.load(Ordering::Relaxed), 2);
        guard.shutdown().await;
        assert!(
            guard
                .state
                .playlist_routes
                .lock()
                .unwrap()
                .get("http://8.8.8.8/entry")
                .is_none()
        );
    }

    #[tokio::test]
    async fn pinned_refusals_remain_visible_and_transient_failures_keep_the_route() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        for status in [401, 403, 404, 410, 429, 503] {
            let entries = Arc::new(AtomicUsize::new(0));
            let fail = Arc::new(AtomicBool::new(false));
            let seen = entries.clone();
            let failed = fail.clone();
            let forward = fixture(move |r| {
                if r.starts_with("GET http://8.8.8.8/entry ") {
                    seen.fetch_add(1, Ordering::Relaxed);
                    if failed.load(Ordering::Relaxed) {
                        response(status, "", "refused")
                    } else {
                        response(302, "Location: /playlist\r\n", "")
                    }
                } else if failed.load(Ordering::Relaxed) {
                    response(status, "", "refused")
                } else {
                    response(200, "", live_media())
                }
            })
            .await;
            let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
            let url = guard.stream_url("http://8.8.8.8/entry").unwrap();
            assert_eq!(request(&url, "").await.0, 200);
            fail.store(true, Ordering::Relaxed);
            let r = request(&url, "").await;
            if status == 503 {
                assert_eq!(r.0, 200);
                assert!(r.2.contains("#EXTM3U"));
            } else {
                assert_eq!(r.0, status);
            }
            assert_eq!(
                entries.load(Ordering::Relaxed),
                if [401, 403, 404, 410].contains(&status) {
                    2
                } else {
                    1
                }
            );
            guard.shutdown().await;
        }
    }

    #[tokio::test]
    async fn live_refresh_status_policy_keeps_failures_visible() {
        for status in [500, 502, 503, 504, 401, 403, 404, 410, 429, 501] {
            let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counted = reads.clone();
            let forward = fixture(move |_| {
                if counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                    response(200, "", live_media())
                } else {
                    response(status, "", "provider refusal")
                }
            })
            .await;
            let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
            let url = guard.stream_url("http://8.8.8.8/extensionless").unwrap();
            let original = request(&url, "").await;
            let refreshed = request(&url, "").await;
            if retryable_status(status) {
                assert_eq!((refreshed.0, refreshed.2), (original.0, original.2));
            } else {
                assert_eq!(
                    (refreshed.0, refreshed.2.as_str()),
                    (status, "provider refusal")
                );
            }
            let signals = guard.signals().read();
            assert_eq!(
                signals.upstream,
                if retryable_status(status) {
                    None
                } else {
                    Some((status, "provider refusal".into()))
                }
            );
            assert_eq!(
                signals.protected_refreshes,
                u64::from(retryable_status(status))
            );
            guard.shutdown().await;
        }
    }

    #[tokio::test]
    async fn finite_master_and_policy_refusals_are_not_cached_over() {
        for (initial, next, expected) in [
            (
                format!("{}#EXT-X-ENDLIST\n", live_media()),
                response(503, "", "offline"),
                503,
            ),
            (
                format!("{}#EXT-X-PLAYLIST-TYPE:VOD\n", live_media()),
                response(503, "", "offline"),
                503,
            ),
            (
                "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=10\nvariant\n".into(),
                response(503, "", "offline"),
                503,
            ),
            (
                live_media().into(),
                response(200, "", "#EXTM3U\n#EXT-X-KEY:URI=unquoted\n"),
                403,
            ),
            (
                live_media().into(),
                response(503, "", "#EXTM3U\n#EXT-X-KEY:URI=unquoted\n"),
                403,
            ),
            (
                live_media().into(),
                response(302, "Location: file:///secret\r\n", ""),
                403,
            ),
            (
                live_media().into(),
                response(302, "Location: http://127.0.0.1:1/private\r\n", ""),
                403,
            ),
        ] {
            let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let forward = fixture(move |_| {
                if reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                    response(200, "", &initial)
                } else {
                    next.clone()
                }
            })
            .await;
            let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
            let url = guard.stream_url("http://8.8.8.8/media").unwrap();
            request(&url, "").await;
            assert_eq!(request(&url, "").await.0, expected);
            guard.shutdown().await;
        }
    }

    #[tokio::test]
    async fn full_playlist_range_retry_cannot_mask_a_refusal() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let forward =
            fixture(
                move |_| match reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed) {
                    0 => response(200, "", live_media()),
                    1 => response(206, "", live_media()),
                    _ => response(403, "", "refused"),
                },
            )
            .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/media").unwrap();
        request(&url, "").await;
        let refused = request(&url, "").await;
        assert_eq!((refused.0, refused.2.as_str()), (403, "refused"));
        assert_eq!(
            guard.signals().read().upstream,
            Some((403, "refused".into()))
        );
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn redirected_extensionless_media_retains_safe_resolved_base() {
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failed = fail.clone();
        let forward = fixture(move |request| {
            if request.contains("/start ") {
                response(302, "Location: /nested/media\r\n", "")
            } else if request.contains("/nested/segment.ts ") {
                response(200, "", "guarded media")
            } else if failed.load(std::sync::atomic::Ordering::Relaxed) {
                response(503, "", "offline")
            } else {
                response(200, "", live_media())
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/start").unwrap();
        let original = request(&url, "").await;
        fail.store(true, std::sync::atomic::Ordering::Relaxed);
        let cached = request(&url, "").await;
        assert_eq!((cached.0, cached.2), (original.0, original.2.clone()));
        let child = original
            .2
            .lines()
            .find(|line| line.starts_with("http://"))
            .unwrap();
        assert!(child.contains("8.8.8.8%2Fnested%2Fsegment.ts"));
        assert_eq!(request(child, "").await.2, "guarded media");
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn whole_refresh_deadline_cancels_headers_body_and_drips() {
        for kind in ["headers", "body", "drip", "reset"] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let proxy = format!("http://{}", listener.local_addr().unwrap());
            let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let ended = closed.clone();
            let task = tokio::spawn(async move {
                let mut tasks = JoinSet::new();
                let mut reads = 0;
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let first = reads == 0;
                    reads += 1;
                    let ended = ended.clone();
                    tasks.spawn(async move {
                        let mut request = Vec::new(); let mut byte=[0];
                        while !request.ends_with(b"\r\n\r\n") { if socket.read(&mut byte).await.unwrap_or(0)==0 { return; } request.push(byte[0]); }
                        if first { socket.write_all(response(200,"",live_media()).as_bytes()).await.unwrap(); return; }
                        if kind == "reset" { return; }
                        if kind != "headers" { socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n#EXTM3U\n#EXT-X-TARGETDURATION:3\n").await.unwrap(); }
                        loop {
                            tokio::select! {
                                read = socket.read(&mut byte) => { if read.unwrap_or(0)==0 { ended.store(true,std::sync::atomic::Ordering::Relaxed); break; } }
                                _ = tokio::time::sleep(std::time::Duration::from_millis(100)), if kind == "drip" => { if socket.write_all(b"# waiting\n").await.is_err() { break; } }
                            }
                        }
                    });
                }
            });
            let guard = UpstreamGuard::start(false, &proxy).await.unwrap();
            let url = guard.stream_url("http://8.8.8.8/media").unwrap();
            let original = request(&url, "").await;
            let begun = std::time::Instant::now();
            let cached = request(&url, "").await;
            assert_eq!((cached.0, cached.2), (original.0, original.2));
            if kind != "reset" {
                assert!(begun.elapsed() >= std::time::Duration::from_millis(1900));
                assert!(begun.elapsed() < std::time::Duration::from_millis(2900));
                tokio::time::timeout(std::time::Duration::from_secs(1), async {
                    while !closed.load(std::sync::atomic::Ordering::Relaxed) {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
            }
            assert!(guard.failure().is_none());
            assert_eq!(guard.signals().read().protected_refreshes, 1);
            guard.shutdown().await;
            assert!(cached_manifest(&guard.state, "http://8.8.8.8/media").is_none());
            task.abort();
        }
    }

    #[tokio::test]
    async fn seeded_cache_does_not_hide_malformed_missing_or_loop_redirects() {
        for next in [
            response(302, "Location: http://[broken\r\n", ""),
            response(302, "", ""),
            response(302, "Location: /loop\r\n", ""),
        ] {
            let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let forward = fixture(move |_| {
                if reads.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                    response(200, "", live_media())
                } else {
                    next.clone()
                }
            })
            .await;
            let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
            let url = guard.stream_url("http://8.8.8.8/media").unwrap();
            request(&url, "").await;
            assert_eq!(request(&url, "").await.0, 502);
            assert_eq!(
                guard.failure().unwrap().diagnostic,
                "invalid upstream redirect"
            );
            assert_eq!(guard.signals().read().protected_refreshes, 0);
            guard.shutdown().await;
        }
    }

    #[tokio::test]
    async fn protected_http_response_never_replaces_an_existing_failure() {
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mode = failed.clone();
        let forward = fixture(move |request| {
            if request.contains("/failed.ts ") {
                response(403, "", "refused")
            } else if mode.load(std::sync::atomic::Ordering::Relaxed) {
                response(503, "", "offline")
            } else {
                response(200, "", live_media())
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/media").unwrap();
        let original = request(&url, "").await;
        assert_eq!(
            request(&guard.stream_url("http://8.8.8.8/failed.ts").unwrap(), "")
                .await
                .0,
            403
        );
        failed.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(request(&url, "").await.2, original.2);
        assert_eq!(
            guard.signals().read().upstream,
            Some((403, "refused".into()))
        );
        assert_eq!(guard.signals().read().protected_refreshes, 1);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn protection_keeps_newer_unresolved_failures_and_never_invents_a_connection() {
        let guard = UpstreamGuard::start(true, "").await.unwrap();
        protected_refresh(&guard.state, 4, 504);
        let seen = guard.signals().read();
        assert_eq!(seen.guard, None);
        assert_eq!(seen.upstream, None);
        assert!(!seen.connected);
        assert_eq!(seen.protected_refreshes, 1);
        record_failure(
            &guard.state,
            6,
            Some((403, "refused".into())),
            Some(GuardFailureInfo::forbidden("private upstream destination")),
        );
        protected_refresh(&guard.state, 7, 504);
        record_connected(&guard.state, 5);
        assert_eq!(
            guard.signals().read().upstream,
            Some((403, "refused".into()))
        );
        assert_eq!(guard.failure().unwrap().status, 403);
        assert!(guard.failed());
        record_connected(&guard.state, 8);
        assert_eq!(guard.signals().read().upstream, None);
        assert_eq!(guard.failure(), None);
        assert!(guard.signals().read().connected);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn late_active_response_failure_survives_a_newer_connection() {
        let guard = UpstreamGuard::start(true, "").await.unwrap();
        record_connected(&guard.state, 12);
        record_failure(&guard.state, 10, Some((403, "refused".into())), None);
        record_guard(&guard.state, 10, GuardFailureInfo::connection());
        assert!(guard.failed());
        assert_eq!(guard.failure().unwrap().status, 502);
        assert_eq!(
            guard.signals().read().upstream,
            Some((403, "refused".into()))
        );
        record_guard(
            &guard.state,
            11,
            GuardFailureInfo::forbidden("private upstream destination"),
        );
        record_guard(&guard.state, 10, GuardFailureInfo::connection());
        assert_eq!(guard.failure().unwrap().status, 403);
        record_connected(&guard.state, 11);
        assert!(guard.failed());
        record_connected(&guard.state, 13);
        assert!(!guard.failed());
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn initial_inactivity_eof_is_not_cache_admission_and_inflight_expiry_is_final() {
        for initial_incomplete in [true, false] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let provider = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let mut tasks = JoinSet::new();
                let mut reads = 0;
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let first = reads == 0;
                    reads += 1;
                    tasks.spawn(async move {
                        let mut header = Vec::new();
                        let mut byte = [0];
                        while !header.ends_with(b"\r\n\r\n") {
                            if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                                return;
                            }
                            header.push(byte[0]);
                        }
                        if (first && initial_incomplete) || (!first && !initial_incomplete) {
                            socket
                                .write_all(
                                    format!(
                                        "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\n{}",
                                        live_media()
                                    )
                                    .as_bytes(),
                                )
                                .await
                                .unwrap();
                            let _ = socket.read(&mut byte).await;
                        } else {
                            socket
                                .write_all(
                                    response(
                                        if first { 200 } else { 503 },
                                        "",
                                        if first { live_media() } else { "offline" },
                                    )
                                    .as_bytes(),
                                )
                                .await
                                .unwrap();
                        }
                    });
                }
            });
            let guard = UpstreamGuard::start(true, "").await.unwrap();
            let key = format!("{provider}/media");
            let url = guard.stream_url(&key).unwrap();
            let initial = request(&url, "").await;
            assert_eq!(initial.0, 200);
            if initial_incomplete {
                assert!(!guard.observed_hls());
                assert!(cached_manifest(&guard.state, &key).is_none());
                assert_eq!(request(&url, "").await.0, 503);
            } else {
                assert!(guard.observed_hls());
                guard.state.manifest_cache.lock().unwrap().put(
                    &key,
                    &initial.2,
                    1,
                    std::time::Instant::now() - std::time::Duration::from_secs(29),
                );
                assert_eq!(request(&url, "").await.0, 504);
                assert!(cached_manifest(&guard.state, &key).is_none());
            }
            assert_eq!(guard.signals().read().protected_refreshes, 0);
            guard.shutdown().await;
            task.abort();
        }
    }

    #[tokio::test]
    async fn cached_key_map_and_byte_ranges_keep_guarded_credential_context() {
        let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mode = failed.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let captured = seen.clone();
        let body = live_media().replace("#EXTINF:3,", "#EXT-X-KEY:METHOD=AES-128,URI=\"key?grant=owned\"\n#EXT-X-MAP:URI=\"init.mp4?grant=owned\"\n#EXTINF:3,\n#EXT-X-BYTERANGE:4@0");
        let forward = fixture(move |request| {
            if request.contains("/start ") {
                response(302, "Location: /nested/media\r\n", "")
            } else if request.contains("/nested/media ")
                && !mode.load(std::sync::atomic::Ordering::Relaxed)
            {
                response(200, "Set-Cookie: session=owned; Path=/nested\r\n", &body)
            } else if request.contains("/nested/media ") {
                response(503, "", "offline")
            } else {
                captured.lock().unwrap().push(request.to_owned());
                response(206, "Content-Range: bytes 0-3/8\r\n", "abcd")
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://user:pass@8.8.8.8/start").unwrap();
        let original = request(&url, "").await;
        failed.store(true, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(request(&url, "").await.2, original.2);
        let mut uris = Vec::new();
        for line in original.2.lines() {
            if let Some((_, value)) = line.split_once("URI=\"") {
                uris.push(value.split('"').next().unwrap().to_owned());
            } else if line.starts_with("http://") {
                uris.push(line.to_owned());
            }
        }
        assert_eq!(uris.len(), 3);
        for uri in uris {
            let result = request(&uri, "Range: bytes=0-3\r\n").await;
            assert_eq!((result.0, result.2.as_str()), (206, "abcd"));
        }
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3);
        for request in seen {
            assert!(request.to_ascii_lowercase().contains("range: bytes=0-3"));
            assert!(request.contains("session=owned"));
            assert!(request.contains("Basic dXNlcjpwYXNz"));
        }
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn hls_observation_uses_successful_bodies_and_is_per_ingest() {
        let forward = fixture(|request| {
            if request.contains("/redirect ") {
                response(302, "Location: /master\r\n", "")
            } else if request.contains("/master ") {
                response(
                    200,
                    "",
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nvariant\n",
                )
            } else if request.contains("/variant ") {
                response(200, "", "#EXTM3U\n#EXTINF:3,\nsegment.ts\n")
            } else if request.contains("/error ") {
                response(503, "", "#EXTM3U\n#EXTINF:3,\nsegment.ts\n")
            } else if request.contains("/malformed ") {
                response(200, "", "#EXTM3U\n#EXT-X-KEY:URI=unquoted\n")
            } else {
                response(200, "", "raw transport stream payload")
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        assert!(!guard.observed_hls());
        for path in ["guess.m3u8", "error", "malformed"] {
            request(
                &guard.stream_url(&format!("http://8.8.8.8/{path}")).unwrap(),
                "",
            )
            .await;
        }
        assert!(!guard.observed_hls());
        let master = request(&guard.stream_url("http://8.8.8.8/redirect").unwrap(), "").await;
        assert!(guard.observed_hls());
        let variant = request(
            master
                .2
                .lines()
                .find(|line| line.starts_with("http://"))
                .unwrap(),
            "",
        )
        .await;
        request(
            variant
                .2
                .lines()
                .find(|line| line.starts_with("http://"))
                .unwrap(),
            "",
        )
        .await;
        assert!(guard.observed_hls());
        guard.shutdown().await;
        let fresh = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        assert!(!fresh.observed_hls());
        fresh.shutdown().await;
    }

    #[test]
    fn complete_answer_sets_and_embedded_addresses_are_checked() {
        let public = "8.8.8.8".parse().unwrap();
        let private = "127.0.0.1".parse().unwrap();
        assert_eq!(
            checked_address(&[public, private], false)
                .unwrap_err()
                .status,
            403
        );
        assert_eq!(checked_address(&[public, private], true).unwrap(), public);
        assert!(checked_address(&[], false).is_err());
        for address in [
            "::",
            "::1",
            "::ffff:8.8.8.8",
            "64:ff9b::127.0.0.1",
            "64:ff9b:1::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "ff00::1",
            "100.64.0.1",
            "198.18.0.1",
        ] {
            assert!(private_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "64:ff9b::8.8.8.8", "2001:4860:4860::8888"] {
            assert!(!private_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn hls_children_keys_maps_and_malformed_attributes() {
        let base = Url::parse("https://example.org/live/channel.m3u8").unwrap();
        let output = rewrite_playlist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key\"\n#EXT-X-MAP:URI=\"init.mp4\"\nsegment.ts\n",&base,"http://127.0.0.1:1234").unwrap();
        assert!(output.contains("upstream.mp4?url="));
        assert!(output.contains("upstream.ts?url="));
        assert!(output.contains("example.org%2Flive%2Fkey"));
        for line in [
            "#EXT-X-KEY:URI=unquoted",
            "#EXT-X-MAP:URI=\"h\\ttp://internal/\"",
            "#EXT-X-KEY:URI=\"unterminated",
        ] {
            assert_eq!(
                rewrite_playlist(line, &base, "http://127.0.0.1:1")
                    .unwrap_err()
                    .status,
                403
            );
        }
    }

    #[tokio::test]
    async fn direct_scope_and_private_destinations_fail_closed() {
        let guard = UpstreamGuard::start(false, "").await.unwrap();
        let blocked = request(&guard.stream_url("http://127.0.0.1:1/secret").unwrap(), "").await;
        assert_eq!(blocked.0, 403);
        assert_eq!(
            guard.failure().unwrap().diagnostic,
            "private upstream destination"
        );
        for scheme in ["tcp", "tls", "file", "rtsp"] {
            assert!(
                guard
                    .stream_url(&format!("{scheme}://127.0.0.1/a"))
                    .is_err()
            );
        }
        assert!(
            validate_direct_input("rtsp://127.0.0.1/s", false)
                .await
                .is_err()
        );
        assert!(
            validate_direct_input("rtsp://127.0.0.1/s", true)
                .await
                .is_ok()
        );
        assert!(
            validate_direct_input("rtmp://127.0.0.1/s", true)
                .await
                .is_ok()
        );
        assert!(validate_direct_input("file:///a", true).await.is_err());
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn rtsp_requires_explicit_private_network_opt_in() {
        // Even a public literal can redirect FFmpeg to a private destination.
        // Reject before DNS resolution or spawning either ffprobe or FFmpeg.
        for url in [
            "rtsp://8.8.8.8:8554/live",
            "rtsp://[2001:4860:4860::8888]/live",
            "rtsp://unresolvable.invalid/live",
            "rtsp://127.0.0.1/live",
        ] {
            assert_eq!(
                validate_direct_input(url, false).await.unwrap_err(),
                "RTSP requires LIVETV_ALLOW_PRIVATE_URLS because FFmpeg follows unchecked redirects"
            );
            assert_eq!(validate_direct_input(url, true).await.unwrap(), url);
        }
    }

    #[tokio::test]
    async fn direct_rtmp_inputs_connect_to_the_checked_address() {
        assert_eq!(
            validate_direct_input("rtmp://localhost:1935/live/key", true)
                .await
                .unwrap(),
            "rtmp://localhost:1935/live/key"
        );
        assert_eq!(
            validate_direct_input("rtmp://localhost:1935/live/key", false)
                .await
                .unwrap_err(),
            "private upstream destination"
        );
        assert_eq!(
            validate_direct_input("rtmp://8.8.8.8/live/key", false)
                .await
                .unwrap(),
            "rtmp://8.8.8.8/live/key"
        );
        let url = Url::parse("rtmp://user:p%40ss@provider.example:1935/live?x=1").unwrap();
        assert_eq!(
            pinned_url(url.clone(), "8.8.8.8".parse().unwrap()).unwrap(),
            "rtmp://user:p%40ss@8.8.8.8:1935/live?x=1"
        );
        assert_eq!(
            pinned_url(url, "2001:4860:4860::8888".parse().unwrap()).unwrap(),
            "rtmp://user:p%40ss@[2001:4860:4860::8888]:1935/live?x=1"
        );
    }

    #[tokio::test]
    async fn relay_serves_only_urls_carrying_its_token() {
        let seen = Arc::new(Mutex::new(0));
        let counted = seen.clone();
        let forward = fixture(move |_| {
            *counted.lock().unwrap() += 1;
            response(200, "", "#EXTM3U\n#EXTINF:1,\nsegment.ts\n")
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/live.m3u8").unwrap();
        let origin = Url::parse(&guard.state.origin).unwrap();
        let token = origin.path().strip_prefix("/r/").unwrap();
        assert_eq!(token.len(), 32);
        assert!(url.starts_with(&format!("{}/upstream.m3u8?url=", guard.state.origin)));
        let bare = url.replace(&format!("/r/{token}"), "");
        let wrong = url.replace(token, &"0".repeat(32));
        for unauthorized in [bare, wrong] {
            assert_eq!(request(&unauthorized, "").await.0, 404);
        }
        assert_eq!(*seen.lock().unwrap(), 0);
        assert!(!guard.failed());
        let playlist = request(&url, "").await;
        assert_eq!(playlist.0, 200);
        let child = playlist
            .2
            .lines()
            .find(|line| line.starts_with("http://"))
            .unwrap();
        assert!(child.starts_with(&format!("{}/upstream.ts?url=", guard.state.origin)));
        assert_eq!(request(child, "").await.0, 200);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn error_answers_are_recorded_with_a_bounded_snippet_and_forwarded_unchanged() {
        let body = format!("Max connections reached{}", "x".repeat(600));
        let error_body = body.clone();
        let forward = fixture(move |request| {
            if request.contains("/refused.ts ") {
                response(403, "Content-Type: text/plain\r\n", &error_body)
            } else {
                response(
                    200,
                    "Content-Type: video/mp2t\r\n",
                    "transport-stream-bytes",
                )
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let signals = guard.signals();
        assert_eq!(signals.read(), RelaySignals::default());
        let refused = request(&guard.stream_url("http://8.8.8.8/refused.ts").unwrap(), "").await;
        assert_eq!((refused.0, refused.2.as_str()), (403, body.as_str()));
        let seen = signals.read();
        assert_eq!(seen.upstream, Some((403, body[..512].to_owned())));
        assert!(!seen.connected);
        assert_eq!(seen.guard, None);
        let live = request(&guard.stream_url("http://8.8.8.8/live.ts").unwrap(), "").await;
        assert_eq!(live.0, 200);
        // A later answer with data is the last word.
        assert_eq!(
            signals.read(),
            RelaySignals {
                upstream: None,
                guard: None,
                connected: true,
                protected_refreshes: 0,
            }
        );
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn real_http_rewrites_and_blocks_private_redirects_and_children() {
        let forward = fixture(|request| {
            if request.contains("/redirect ") {
                response(302, "Location: http://127.0.0.1:1/internal\r\n", "")
            } else {
                response(
                    200,
                    "Content-Type: application/octet-stream\r\n",
                    "#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:1/internal.ts\n",
                )
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        assert_eq!(
            request(&guard.stream_url("http://8.8.8.8/redirect").unwrap(), "")
                .await
                .0,
            403
        );
        let playlist = request(&guard.stream_url("http://8.8.8.8/live.m3u8").unwrap(), "").await;
        assert_eq!(playlist.0, 200);
        let child = playlist
            .2
            .lines()
            .find(|line| line.starts_with("http://"))
            .unwrap();
        assert_eq!(request(child, "").await.0, 403);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn pinned_proxy_authority_host_auth_and_scoped_cookies() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let observed = seen.clone();
        let forward = fixture(move |request| {
            observed.lock().unwrap().push(request.to_owned());
            response(
                200,
                "Set-Cookie: session=secret; Path=/\r\n",
                "media segment payload",
            )
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let one = guard
            .stream_url("http://name:p%40ss@8.8.8.8/live.ts")
            .unwrap();
        assert_eq!(
            request(
                &one,
                "Authorization: stolen\r\nCookie: stolen=yes\r\nProxy-Authorization: stolen\r\n"
            )
            .await
            .0,
            200
        );
        request(&guard.stream_url("http://8.8.8.8/child.ts").unwrap(), "").await;
        request(&guard.stream_url("http://1.1.1.1/child.ts").unwrap(), "").await;
        let seen = seen.lock().unwrap().clone();
        assert!(seen[0].starts_with("GET http://8.8.8.8/live.ts HTTP/1.1"));
        assert!(seen[0].to_ascii_lowercase().contains("host: 8.8.8.8\r\n"));
        assert!(seen[0].contains("Basic bmFtZTpwQHNz"));
        assert!(!seen[0].contains("stolen"));
        assert!(seen[1].contains("session=secret"));
        assert!(!seen[2].contains("session=secret"));
        drop(seen);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn playlist_ranges_retry_but_media_ranges_survive() {
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let captured = ranges.clone();
        let forward = fixture(move |request| {
            let ranged = request.to_ascii_lowercase().contains("range: bytes=");
            captured.lock().unwrap().push(ranged);
            if request.contains("/live.m3u8 ") {
                if ranged {
                    response(
                        206,
                        "Content-Range: bytes 0-19/50\r\n",
                        "#EXTM3U\n#EXTINF:1,\n",
                    )
                } else {
                    response(200, "", "#EXTM3U\n#EXTINF:1,\nsegment.ts\n")
                }
            } else {
                response(206, "Content-Range: bytes 0-15/32\r\n", "segment payload!")
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let url = guard.stream_url("http://8.8.8.8/live.m3u8").unwrap();
        let playlist = request(&url, "Range: bytes=0-\r\n").await;
        assert_eq!(playlist.0, 200);
        assert!(!playlist.1.to_ascii_lowercase().contains("content-range"));
        request(&url, "Range: bytes=9-\r\n").await;
        let child = playlist
            .2
            .lines()
            .find(|line| line.starts_with("http://"))
            .unwrap();
        assert_eq!(request(child, "Range: bytes=0-15\r\n").await.0, 206);
        assert_eq!(*ranges.lock().unwrap(), vec![true, false, false, true]);
        guard.shutdown().await;
    }

    #[tokio::test]
    async fn redirect_limit_compression_and_shutdown_are_bounded() {
        let forward = fixture(|request| {
            if request.contains("/compressed ") {
                response(200, "Content-Encoding: gzip\r\n", "not identity")
            } else {
                response(302, "Location: /again\r\n", "")
            }
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        assert_eq!(
            request(&guard.stream_url("http://8.8.8.8/again").unwrap(), "")
                .await
                .0,
            502
        );
        assert_eq!(
            request(&guard.stream_url("http://8.8.8.8/compressed").unwrap(), "")
                .await
                .0,
            502
        );
        // Shutdown joins the accept task that owns the listener, so the socket is closed when
        // it returns. Probing the old port instead would race with any process on a shared
        // runner that is handed the same ephemeral port next.
        timeout(std::time::Duration::from_secs(30), guard.shutdown())
            .await
            .unwrap();
        assert!(guard.server.lock().unwrap().is_none());
        assert!(*guard.state.shutdown.borrow());
    }

    #[tokio::test]
    async fn disconnect_and_shutdown_cancel_requests_before_headers() {
        for shutdown in [false, true] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let proxy = format!("http://{}", listener.local_addr().unwrap());
            let (begun, started) = tokio::sync::oneshot::channel();
            let (closed, ended) = tokio::sync::oneshot::channel();
            let upstream = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    if socket.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    request.push(byte[0]);
                }
                let _ = begun.send(());
                let read = socket.read(&mut byte).await.unwrap_or(0);
                assert_eq!(read, 0);
                let _ = closed.send(());
            });
            let guard = UpstreamGuard::start(false, &proxy).await.unwrap();
            let url = Url::parse(&guard.stream_url("http://8.8.8.8/stalled").unwrap()).unwrap();
            let mut client =
                tokio::net::TcpStream::connect((url.host_str().unwrap(), url.port().unwrap()))
                    .await
                    .unwrap();
            client
                .write_all(
                    format!(
                        "GET {}?{} HTTP/1.1\r\nHost: localhost\r\n\r\n",
                        url.path(),
                        url.query().unwrap()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            timeout(DEADLINE, started).await.unwrap().unwrap();
            if shutdown {
                guard.shutdown().await;
            } else {
                drop(client);
            }
            timeout(std::time::Duration::from_secs(2), ended)
                .await
                .unwrap()
                .unwrap();
            assert!(
                !guard.failed(),
                "normal downstream cancellation must not become an upstream error"
            );
            guard.shutdown().await;
            upstream.await.unwrap();
        }
    }

    #[tokio::test]
    async fn oversized_playlist_is_rejected_before_any_rewritten_bytes() {
        let forward = fixture(|_| {
            response(
                200,
                "",
                &format!("#EXTM3U\n{}", "a".repeat(MAX_PLAYLIST_BYTES)),
            )
        })
        .await;
        let guard = UpstreamGuard::start(false, &forward.origin).await.unwrap();
        let result = request(&guard.stream_url("http://8.8.8.8/live.m3u8").unwrap(), "").await;
        assert_eq!(result.0, 502);
        assert!(result.2.is_empty());
        guard.shutdown().await;
    }
}
