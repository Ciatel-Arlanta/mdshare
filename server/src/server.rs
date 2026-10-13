//! HTTP API.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{Path as AxPath, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tower_http::cors::CorsLayer;

use crate::net::Addr;
use crate::share::{Share, ShareKind};

pub const API_VERSION: u32 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PAIR_FAILURES: u32 = 10;
const COOKIE: &str = "mdshare_t";

#[derive(Clone, Debug, Serialize)]
pub struct ChangeEvent {
    /// Files whose contents changed, relative to the share root.
    pub paths: Vec<String>,
    /// Whether files or folders were added or removed, so the tree is stale.
    pub tree: bool,
}

pub struct AppState {
    pub share: Share,
    pub token: String,
    pub pair_code: String,
    pub hostname: String,
    pub port: u16,
    pub addrs: Vec<Addr>,
    pub expires_at: Option<u64>,
    pub events: broadcast::Sender<ChangeEvent>,
    pair_failures: AtomicU32,
    /// Unix seconds of the last authenticated request.
    pub last_activity: AtomicU64,
    /// Open live-reload streams; a phone with the app open counts as active.
    pub live_streams: AtomicUsize,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        share: Share,
        token: String,
        pair_code: String,
        hostname: String,
        port: u16,
        addrs: Vec<Addr>,
        expires_at: Option<u64>,
        events: broadcast::Sender<ChangeEvent>,
    ) -> Self {
        Self {
            share,
            token,
            pair_code,
            hostname,
            port,
            addrs,
            expires_at,
            events,
            pair_failures: AtomicU32::new(0),
            last_activity: AtomicU64::new(now_secs()),
            live_streams: AtomicUsize::new(0),
        }
    }
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

type AppRef = Arc<AppState>;

pub fn router(state: AppRef) -> Router {
    let authed = Router::new()
        .route("/api/info", get(info))
        .route("/api/tree", get(tree))
        .route("/api/file", get(file_by_query))
        .route("/api/search", get(search))
        .route("/api/events", get(events))
        .route("/raw/{*path}", get(file_by_path))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));

    Router::new()
        .route("/", get(index))
        .route("/api/ping", get(ping))
        .route("/api/pair", post(pair))
        .merge(authed)
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// Constant-time comparison so response timing doesn't leak the token.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The token from the `Authorization` header, a `t` query parameter (for
/// `<img src>` and browser links), or the cookie the web page sets.
fn presented_token<'a>(headers: &'a HeaderMap, query: Option<&'a str>) -> Option<&'a str> {
    if let Some(v) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        && let Some(t) = v.strip_prefix("Bearer ")
    {
        return Some(t.trim());
    }
    if let Some(t) = query.and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("t="))) {
        return Some(t);
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| kv.trim().strip_prefix(&format!("{COOKIE}=")[..]))
}

async fn require_token(State(state): State<AppRef>, req: Request, next: Next) -> Response {
    let ok =
        presented_token(req.headers(), req.uri().query()).is_some_and(|t| same(t, &state.token));
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    state.last_activity.store(now_secs(), Ordering::Relaxed);
    next.run(req).await
}

#[derive(Serialize)]
struct Ping<'a> {
    app: &'static str,
    version: u32,
    name: &'a str,
    host: &'a str,
}

/// Unauthenticated probe so the app can find which address answers.
async fn ping(State(state): State<AppRef>) -> impl IntoResponse {
    Json(Ping {
        app: "mdshare",
        version: API_VERSION,
        name: &state.share.name,
        host: &state.hostname,
    })
    .into_response()
}

#[derive(Deserialize)]
struct PairRequest {
    code: String,
}

/// Exchanges the 6-digit code shown in the terminal for the token, so a phone
/// that found the share over mDNS can connect without scanning the QR code.
async fn pair(State(state): State<AppRef>, Json(req): Json<PairRequest>) -> Response {
    if state.pair_failures.load(Ordering::Relaxed) >= MAX_PAIR_FAILURES {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({ "error": "pairing locked; scan the QR code instead" })),
        )
            .into_response();
    }
    if same(req.code.trim(), &state.pair_code) {
        return Json(serde_json::json!({ "token": state.token })).into_response();
    }
    state.pair_failures.fetch_add(1, Ordering::Relaxed);
    tokio::time::sleep(Duration::from_millis(400)).await;
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({ "error": "wrong code" })),
    )
        .into_response()
}

#[derive(Serialize)]
struct Info<'a> {
    app: &'static str,
    version: u32,
    name: &'a str,
    kind: ShareKind,
    /// For a single-file share, the path of that file.
    entry: Option<&'a str>,
    host: &'a str,
    port: u16,
    addrs: &'a [Addr],
    expires_at: Option<u64>,
}

async fn info(State(state): State<AppRef>) -> impl IntoResponse {
    Json(Info {
        app: "mdshare",
        version: API_VERSION,
        name: &state.share.name,
        kind: state.share.kind,
        entry: state.share.entry.as_deref(),
        host: &state.hostname,
        port: state.port,
        addrs: &state.addrs,
        expires_at: state.expires_at,
    })
    .into_response()
}

async fn tree(State(state): State<AppRef>) -> Response {
    let state2 = state.clone();
    match tokio::task::spawn_blocking(move || state2.share.tree()).await {
        Ok(tree) => Json(tree).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
struct FileQuery {
    path: String,
}

async fn file_by_query(
    State(state): State<AppRef>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
) -> Response {
    serve_file(&state, &q.path, &headers).await
}

async fn file_by_path(
    State(state): State<AppRef>,
    AxPath(path): AxPath<String>,
    headers: HeaderMap,
) -> Response {
    serve_file(&state, &path, &headers).await
}

async fn serve_file(state: &AppState, rel: &str, headers: &HeaderMap) -> Response {
    let not_found = || {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "not found" })),
        )
            .into_response()
    };
    let Some(full) = state.share.resolve(rel) else {
        return not_found();
    };
    let Ok(meta) = tokio::fs::metadata(&full).await else {
        return not_found();
    };
    if meta.len() > MAX_FILE_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }

    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    let etag = format!("\"{:x}-{:x}\"", meta.len(), modified);
    let fresh = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|t| t.trim() == etag));
    if fresh {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }

    let Ok(bytes) = tokio::fs::read(&full).await else {
        return not_found();
    };
    let content_type = if crate::share::is_markdown(&full) {
        "text/markdown; charset=utf-8".to_string()
    } else {
        mime_guess::from_path(&full)
            .first_or_octet_stream()
            .to_string()
    };
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type).unwrap(),
    );
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if content_type.starts_with("image/svg") {
        // SVGs can carry script; never let one run with the page's origin.
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'"),
        );
    }
    res
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<usize>,
}

async fn search(State(state): State<AppRef>, Query(q): Query<SearchQuery>) -> Response {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let state2 = state.clone();
    match tokio::task::spawn_blocking(move || state2.share.search(&q.q, limit)).await {
        Ok(hits) => Json(serde_json::json!({ "hits": hits })).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// Decrements the live-stream count when the SSE stream is dropped.
struct StreamGuard(AppRef);

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.0.live_streams.fetch_sub(1, Ordering::Relaxed);
        self.0.last_activity.store(now_secs(), Ordering::Relaxed);
    }
}

async fn events(State(state): State<AppRef>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    state.live_streams.fetch_add(1, Ordering::Relaxed);
    let guard = StreamGuard(state.clone());
    let hello = futures_util::stream::once(async {
        Ok(Event::default()
            .event("hello")
            .data(API_VERSION.to_string()))
    });
    let changes = BroadcastStream::new(state.events.subscribe()).filter_map(move |msg| {
        let _keep = &guard;
        let event = match msg {
            Ok(change) => Event::default().event("change").json_data(change).ok(),
            // Fell behind: tell the client to refresh everything.
            Err(_) => Event::default()
                .event("change")
                .json_data(ChangeEvent {
                    paths: Vec::new(),
                    tree: true,
                })
                .ok(),
        };
        std::future::ready(event.map(Ok))
    });
    Sse::new(hello.chain(changes)).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// Minimal browser fallback: sets the auth cookie and shows the file list.
async fn index(State(state): State<AppRef>, req: Request) -> Response {
    let headers = req.headers();
    let Some(t) = presented_token(headers, req.uri().query()).filter(|t| same(t, &state.token))
    else {
        return (
            StatusCode::UNAUTHORIZED,
            Html("<!doctype html><meta name=viewport content='width=device-width'>\
                  <body style='font-family:system-ui;padding:2rem'>\
                  <h2>mdshare</h2><p>Open the link from the terminal, or scan its QR code in the mdshare app.</p>"),
        )
            .into_response();
    };
    let cookie = format!("{COOKIE}={t}; Path=/; HttpOnly; SameSite=Strict");
    let mut res = Html(crate::web::INDEX_HTML).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).unwrap());
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_sources() {
        let mut h = HeaderMap::new();
        assert_eq!(presented_token(&h, Some("a=1&t=abc")), Some("abc"));
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("x=1; mdshare_t=fromcookie"),
        );
        assert_eq!(presented_token(&h, None), Some("fromcookie"));
        h.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer hdr"),
        );
        assert_eq!(presented_token(&h, Some("t=q")), Some("hdr"));
    }

    #[test]
    fn constant_time_eq() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }
}
