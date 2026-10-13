//! Browser page served at `/`, for devices without the app. It reuses the
//! app's reader page when it was embedded at build time (see build.rs).

use axum::extract::Path;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

include!(concat!(env!("OUT_DIR"), "/reader_assets.rs"));

pub const INDEX_HTML: &str = include_str!("../web/index.html");

/// Static reader files (no secrets, so no auth).
pub async fn asset(Path(name): Path<String>) -> Response {
    let gzipped = format!("{name}.gz");
    let found = READER_ASSETS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, b)| (*b, false))
        .or_else(|| {
            READER_ASSETS
                .iter()
                .find(|(n, _)| *n == gzipped)
                .map(|(_, b)| (*b, true))
        });
    let Some((bytes, is_gzip)) = found else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = match name.rsplit('.').next() {
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    };
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    if is_gzip {
        // Every browser accepts gzip; only Mermaid is stored this way.
        h.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    }
    res
}
