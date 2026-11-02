// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

use super::{GuardFailureInfo, resolve_address};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{body::Incoming, client::conn::http1};
use hyper_util::rt::TokioIo;
use std::{
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    task::{AbortHandle, JoinSet},
    time::timeout,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{self, pki_types::ServerName},
};
use url::Url;

pub(crate) const DEADLINE: Duration = Duration::from_secs(10);

pub(crate) trait AsyncIo: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncIo for T {}

/// Dropping a response or an interrupted request always closes its owned socket.
struct Driver(AbortHandle);
impl Drop for Driver {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) struct UpstreamResponse {
    pub(crate) status: StatusCode,
    pub(crate) headers: HeaderMap,
    /// A clean body EOF, distinct from the existing inactivity-as-EOF behavior.
    pub(crate) clean_end: bool,
    body: Incoming,
    _driver: Driver,
}

impl UpstreamResponse {
    pub(crate) async fn next(&mut self) -> Result<Option<Bytes>, GuardFailureInfo> {
        loop {
            // A provider that goes silent after its headers ends the body, like the TS
            // relay: no relay failure is recorded, FFmpeg sees the stream end, and the
            // ingest classifies the stall from its segments (upstream_stalled), or a start
            // that never produced one (channel_offline).
            let Ok(frame) = timeout(DEADLINE, self.body.frame()).await else {
                return Ok(None);
            };
            match frame {
                Some(Ok(frame)) => {
                    if let Ok(bytes) = frame.into_data() {
                        return Ok(Some(bytes));
                    }
                }
                Some(Err(_)) => return Err(GuardFailureInfo::connection()),
                None => {
                    self.clean_end = true;
                    return Ok(None);
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) type TestResolver = Arc<dyn Fn(&str) -> Vec<IpAddr> + Send + Sync>;

#[derive(Clone)]
pub(crate) struct Transport {
    pub(crate) allow_private: bool,
    pub(crate) proxy: Option<Url>,
    pub(crate) tls: Arc<rustls::ClientConfig>,
    drivers: Arc<Mutex<JoinSet<()>>>,
    /// Test seam: replaces the system resolver; answers still get the address checks.
    #[cfg(test)]
    pub(crate) resolver: Option<TestResolver>,
}

impl Transport {
    pub(crate) fn new(allow_private: bool, proxy: &str) -> Result<Self, String> {
        let proxy = if proxy.is_empty() {
            None
        } else {
            let parsed = Url::parse(proxy).map_err(|_| "invalid upstream proxy")?;
            if parsed.scheme() != "http" || parsed.host_str().is_none() {
                return Err("Live TV upstream proxy must use http:".into());
            }
            Some(parsed)
        };
        let roots =
            rustls::RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            allow_private,
            proxy,
            tls: Arc::new(tls),
            drivers: Arc::new(Mutex::new(JoinSet::new())),
            #[cfg(test)]
            resolver: None,
        })
    }

    fn driver(&self, future: impl std::future::Future<Output = ()> + Send + 'static) -> Driver {
        let mut drivers = self.drivers.lock().unwrap_or_else(|e| e.into_inner());
        while drivers.try_join_next().is_some() {}
        Driver(drivers.spawn(future))
    }

    pub(crate) fn abort_all(&self) {
        self.drivers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .abort_all();
    }

    pub(crate) async fn shutdown(&self) {
        let mut drivers =
            std::mem::take(&mut *self.drivers.lock().unwrap_or_else(|e| e.into_inner()));
        drivers.abort_all();
        while drivers.join_next().await.is_some() {}
    }

    pub(crate) async fn request(
        &self,
        target: &Url,
        method: &Method,
        headers: HeaderMap,
    ) -> Result<UpstreamResponse, GuardFailureInfo> {
        if !matches!(target.scheme(), "http" | "https") {
            return Err(GuardFailureInfo::forbidden("unsupported upstream protocol"));
        }
        #[cfg(test)]
        let address = match &self.resolver {
            Some(resolver) => super::checked_address(
                &resolver(target.host_str().unwrap_or("").trim_matches(['[', ']'])),
                self.allow_private,
            )?,
            None => resolve_address(target, self.allow_private).await?,
        };
        #[cfg(not(test))]
        let address = resolve_address(target, self.allow_private).await?;
        timeout(
            DEADLINE,
            self.connect_and_request(target, address, method, headers),
        )
        .await
        .map_err(|_| GuardFailureInfo::timeout("upstream response timeout"))?
    }

    async fn connect_and_request(
        &self,
        target: &Url,
        address: IpAddr,
        method: &Method,
        mut headers: HeaderMap,
    ) -> Result<UpstreamResponse, GuardFailureInfo> {
        let secure = target.scheme() == "https";
        let port = target
            .port_or_known_default()
            .ok_or_else(GuardFailureInfo::connection)?;
        let socket = match &self.proxy {
            Some(proxy) => {
                TcpStream::connect((
                    proxy.host_str().unwrap_or("").trim_matches(['[', ']']),
                    proxy.port_or_known_default().unwrap_or(80),
                ))
                .await
            }
            None => TcpStream::connect(SocketAddr::new(address, port)).await,
        }
        .map_err(|_| GuardFailureInfo::connection())?;
        let _ = socket.set_nodelay(true);
        let mut io: Box<dyn AsyncIo> = Box::new(socket);
        if secure {
            if let Some(proxy) = &self.proxy {
                let (mut sender, conn) = http1::handshake::<_, Empty<Bytes>>(TokioIo::new(io))
                    .await
                    .map_err(|_| GuardFailureInfo::connection())?;
                let driver = self.driver(async move {
                    let _ = conn.with_upgrades().await;
                });
                let authority = SocketAddr::new(address, port).to_string();
                let mut request = Request::builder()
                    .method(Method::CONNECT)
                    .uri(&authority)
                    .header("host", &authority);
                if let Some(auth) = basic_auth(proxy)? {
                    request = request.header("proxy-authorization", auth);
                }
                let request = request
                    .body(Empty::<Bytes>::new())
                    .map_err(|_| GuardFailureInfo::connection())?;
                let response = sender
                    .send_request(request)
                    .await
                    .map_err(|_| GuardFailureInfo::connection())?;
                if response.status() != StatusCode::OK {
                    return Err(GuardFailureInfo::connection());
                }
                let upgraded = hyper::upgrade::on(response)
                    .await
                    .map_err(|_| GuardFailureInfo::connection())?;
                drop(driver);
                io = Box::new(TokioIo::new(upgraded));
            }
            let host = target
                .host_str()
                .ok_or_else(GuardFailureInfo::connection)?
                .trim_matches(['[', ']'])
                .to_owned();
            let name = ServerName::try_from(host).map_err(|_| GuardFailureInfo::connection())?;
            io = Box::new(
                TlsConnector::from(self.tls.clone())
                    .connect(name, io)
                    .await
                    .map_err(|_| GuardFailureInfo::connection())?,
            );
        }
        let (mut sender, connection) = http1::handshake::<_, Empty<Bytes>>(TokioIo::new(io))
            .await
            .map_err(|_| GuardFailureInfo::connection())?;
        let driver = self.driver(async move {
            let _ = connection.await;
        });
        let uri = if !secure && self.proxy.is_some() {
            let mut pinned = target.clone();
            pinned
                .set_ip_host(address)
                .map_err(|_| GuardFailureInfo::connection())?;
            let _ = pinned.set_username("");
            let _ = pinned.set_password(None);
            pinned.set_fragment(None);
            pinned.to_string()
        } else {
            format!(
                "{}{}",
                target.path(),
                target.query().map_or(String::new(), |q| format!("?{q}"))
            )
        };
        headers.insert(
            "host",
            HeaderValue::from_str(&authority(target))
                .map_err(|_| GuardFailureInfo::connection())?,
        );
        if let Some(auth) = basic_auth(target)? {
            headers.insert("authorization", auth);
        }
        if !secure
            && let Some(proxy) = &self.proxy
            && let Some(auth) = basic_auth(proxy)?
        {
            headers.insert("proxy-authorization", auth);
        }
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .body(Empty::<Bytes>::new())
            .map_err(|_| GuardFailureInfo::connection())?;
        *request.headers_mut() = headers;
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| GuardFailureInfo::connection())?;
        let (parts, body) = response.into_parts();
        Ok(UpstreamResponse {
            status: parts.status,
            headers: parts.headers,
            clean_end: false,
            body,
            _driver: driver,
        })
    }
}

fn authority(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    url.port()
        .map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"))
}

fn basic_auth(url: &Url) -> Result<Option<HeaderValue>, GuardFailureInfo> {
    if url.username().is_empty() {
        return Ok(None);
    }
    let username = percent_encoding::percent_decode_str(url.username())
        .decode_utf8()
        .map_err(|_| GuardFailureInfo::connection())?;
    let password = percent_encoding::percent_decode_str(url.password().unwrap_or(""))
        .decode_utf8()
        .map_err(|_| GuardFailureInfo::connection())?;
    let mut value = HeaderValue::from_str(&format!(
        "Basic {}",
        STANDARD.encode(format!("{username}:{password}"))
    ))
    .map_err(|_| GuardFailureInfo::connection())?;
    value.set_sensitive(true);
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    use tokio_rustls::{
        TlsAcceptor,
        rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    };

    fn pem(input: &str) -> Vec<u8> {
        STANDARD
            .decode(
                input
                    .lines()
                    .filter(|line| !line.starts_with("---"))
                    .collect::<String>(),
            )
            .unwrap()
    }

    async fn tls_roundtrip(
        proxy: bool,
        name: &str,
    ) -> (Result<String, GuardFailureInfo>, Option<String>) {
        let ca = CertificateDer::from(pem(include_str!("../tests/fixtures/tls/upstream.crt")));
        // Proper CA:false server leaf signed by the existing public test CA/key.
        // Rustls intentionally rejects using the Node fixture's CA:true as a leaf.
        let cert = CertificateDer::from(pem(
            "-----BEGIN CERTIFICATE-----\nMIIC/TCCAeWgAwIBAgIBAjANBgkqhkiG9w0BAQsFADAZMRcwFQYDVQQDDA5wdWJs\naWMuZXhhbXBsZTAeFw0yNjEwMTgxMzIzMzFaFw0zNjEwMTUxMzIzMzFaMBkxFzAV\nBgNVBAMMDnB1YmxpYy5leGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIB\nCgKCAQEAyKjX0HcFH5mh/MitS4lmRWMqpCXiM5ybhBVDuKA3Y8t7ndigM9GSuzqp\n2Xz5B21lMtTAMrCrflQlBHSN0+dWmbcG+uuoSF3qIijUMRNpJ6U60t8VFKaiyIys\n+4tlIE9Tjog0C4ie5cFW8qNeGhodx4xYWJ2E8ApNB8e17RT834LzNhkqf7sG5Uti\nCEzyI6w6QGyU9jlt+uaHrmyM/qtwL8RqKXH7IDmOgXlBJdfWsO0XbHpEEuMr3ZMT\nMSUcHq/5MSTM9x54CciW9yfRNfL2sNBCYbZDmOkjd7ifz/5MJwKd9kCKk+L8dOU4\nchWcLNLWTNXdZEwPEK6Fth7LdiPWIQIDAQABo1AwTjAMBgNVHRMBAf8EAjAAMBkG\nA1UdEQQSMBCCDnB1YmxpYy5leGFtcGxlMA4GA1UdDwEB/wQEAwIFoDATBgNVHSUE\nDDAKBggrBgEFBQcDATANBgkqhkiG9w0BAQsFAAOCAQEAlpJRvm5Gh5FybeB+IKU9\nXMiuecEW722h5LSo5XNGBxkIQy8Tqp44D5ynBGtxmWIuDbkGMQaONZHHjZA3zOq8\nSe9SqrtGaVICel1HlYfdJhFkWmRcVnWYSt/0RmxmoOF+sw7xUpdUcC3DMkEG5zOx\nqh42OsdtDnMXxUWw1ohoeCsLccAjrReN2Zz4RoiH/9lDUXZr5IXnzUWoYSHKTUB5\nGJYGDxNnRzd5yptizCVKB3OM4Idoz7s/sNgeTyWZN6fVDNtpUVpZAQbBlJKswsHI\nARvYfhRP/r10CZJ/X+EF8x4bJPMbrX/QlinF5j03QqySST1ipkdOzFkMuJR4wlVX\ngQ==\n-----END CERTIFICATE-----",
        ));
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pem(include_str!(
            "../tests/fixtures/tls/upstream.key"
        ))));
        let server = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(vec![cert.clone()], key)
            .unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            if let Ok(mut stream) = TlsAcceptor::from(Arc::new(server)).accept(stream).await {
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    request.push(byte[0]);
                }
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nsecure payload").await;
                let _ = stream.shutdown().await;
            }
        });
        let (proxy_url, proxy_task, observed) = if proxy {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let url = format!("http://proxy:password@{}", listener.local_addr().unwrap());
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    request.push(byte[0]);
                }
                let _ = sender.send(String::from_utf8(request).unwrap());
                let mut upstream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let _ = client
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
            (url, Some(task), Some(receiver))
        } else {
            (String::new(), None, None)
        };
        let mut transport = Transport::new(true, &proxy_url).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(ca).unwrap();
        transport.tls = Arc::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let target = Url::parse(&format!("https://{name}:{port}/stream.ts")).unwrap();
        // The address is the checked result; the URL retains the independent TLS name.
        let result = async {
            let mut response = transport
                .connect_and_request(
                    &target,
                    "127.0.0.1".parse().unwrap(),
                    &Method::GET,
                    HeaderMap::new(),
                )
                .await?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response.next().await? {
                bytes.extend_from_slice(&chunk);
            }
            Ok(String::from_utf8(bytes).unwrap())
        }
        .await;
        let observed = match observed {
            Some(receiver) => Some(timeout(DEADLINE, receiver).await.unwrap().unwrap()),
            None => None,
        };
        server_task.abort();
        let _ = server_task.await;
        if let Some(task) = proxy_task {
            task.abort();
            let _ = task.await;
        }
        (result, observed)
    }

    #[tokio::test]
    async fn tls_verifies_original_name_and_proxy_connect_uses_only_pinned_ip() {
        for proxy in [false, true] {
            let (result, observed) = tls_roundtrip(proxy, "public.example").await;
            assert_eq!(result.unwrap(), "secure payload");
            if let Some(observed) = observed {
                assert!(observed.starts_with("CONNECT 127.0.0.1:"));
                assert!(!observed.contains("public.example"));
                assert!(
                    observed
                        .to_ascii_lowercase()
                        .contains("proxy-authorization: basic chjvehk6cgfzc3dvcmq=")
                );
            }
            assert!(tls_roundtrip(proxy, "wrong.example").await.0.is_err());
        }
    }
}
