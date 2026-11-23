//! The HTTP server: the web UI, the reference docs, and the JSON API.
//!
//! The UI and docs are compiled into the binary. API requests are handled
//! one at a time, so dry-run plan changes never interleave. POSTs must be
//! JSON from the same origin (a cross-site form cannot send JSON), and off
//! loopback every API request must carry the token printed with the URL.

use std::net::ToSocketAddrs;

use serde_json::Value;
use serde_json::json;
use tiny_http::Header;
use tiny_http::Method;
use tiny_http::Request;
use tiny_http::Response;
use tiny_http::Server;

use crate::app::App;
use crate::app::Query;
use crate::error::AppError;

/// A file compiled into the binary.
struct Asset {
    path: &'static str,
    mime: &'static str,
    data: &'static [u8],
}

const ASSETS: &[Asset] = &[
    Asset {
        path: "index.html",
        mime: "text/html; charset=utf-8",
        data: include_bytes!("../../../public/index.html"),
    },
    Asset {
        path: "app.js",
        mime: "text/javascript; charset=utf-8",
        data: include_bytes!("../../../public/app.js"),
    },
    Asset {
        path: "layout.js",
        mime: "text/javascript; charset=utf-8",
        data: include_bytes!("../../../public/layout.js"),
    },
    Asset {
        path: "style.css",
        mime: "text/css; charset=utf-8",
        data: include_bytes!("../../../public/style.css"),
    },
];

const DOCS: &[Asset] = &[
    Asset {
        path: "index.html",
        mime: "text/html; charset=utf-8",
        data: include_bytes!("../../../docs/index.html"),
    },
    Asset {
        path: "HACKER_NEWS_POST.md",
        mime: "text/markdown; charset=utf-8",
        data: include_bytes!("../../../docs/HACKER_NEWS_POST.md"),
    },
];

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

/// Decode `application/x-www-form-urlencoded` text (`+` is a space).
fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let byte = bytes
                    .get(i + 1..i + 3)
                    .and_then(|hex| std::str::from_utf8(hex).ok())
                    .and_then(|hex| u8::from_str_radix(hex, 16).ok());
                match byte {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Split a request URL into its path and query parameters (first value wins).
pub fn parse_url(url: &str) -> (String, Query) {
    let url = url.split('#').next().unwrap_or_default();
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let mut params = Query::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        params.entry(decode(k)).or_insert_with(|| decode(v));
    }
    (decode(path), params)
}

fn json_response(status: u16, body: &Value) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(serde_json::to_vec(body).unwrap_or_default())
        .with_status_code(status)
        .with_header(header("content-type", "application/json"))
        .with_header(header("cache-control", "no-store"))
}

fn file_response(asset: &Asset) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_data(asset.data.to_vec())
        .with_status_code(200)
        .with_header(header("content-type", asset.mime))
        .with_header(header("cache-control", "no-store"))
}

fn request_header<'a>(req: &'a Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

/// The host (`name:port`) of an origin URL.
fn origin_host(origin: &str) -> Option<&str> {
    let rest = origin.split_once("://")?.1;
    Some(rest.split(['/', '?', '#']).next().unwrap_or(rest))
}

/// Answer an API request.
fn api(
    app: &mut App,
    req: &mut Request,
    path: &str,
    query: &Query,
    token: Option<&str>,
) -> Result<Value, AppError> {
    if let Some(token) = token
        && request_header(req, "x-jj-graph-token") != Some(token)
    {
        return Err(AppError::new(401, "Missing or wrong token."));
    }
    let method = req.method().as_str().to_owned();
    let mut body = None;
    if *req.method() == Method::Post {
        // Only same-origin pages may mutate: a cross-site form cannot send JSON.
        if !request_header(req, "content-type")
            .unwrap_or("")
            .starts_with("application/json")
        {
            return Err(AppError::new(415, "Expected JSON."));
        }
        if let Some(origin) = request_header(req, "origin")
            && origin_host(origin) != request_header(req, "host")
        {
            return Err(AppError::new(403, "Cross-origin request refused."));
        }
        let mut text = String::new();
        req.as_reader()
            .read_to_string(&mut text)
            .map_err(|err| AppError::new(500, err.to_string()))?;
        let text = if text.trim().is_empty() {
            "{}"
        } else {
            text.as_str()
        };
        body = Some(
            serde_json::from_str::<Value>(text)
                .map_err(|err| AppError::new(500, err.to_string()))?,
        );
    }
    app.handle(&method, path, query, body.as_ref())
}

/// Listen on `addr` (port 0 picks a free port; see `Server::server_addr`).
pub fn bind(addr: impl ToSocketAddrs) -> std::io::Result<Server> {
    Server::http(addr).map_err(std::io::Error::other)
}

/// Serve `app` on `addr` until the process ends.
pub fn serve(app: &mut App, addr: impl ToSocketAddrs, token: Option<&str>) -> std::io::Result<()> {
    serve_on(&bind(addr)?, app, token);
    Ok(())
}

/// Serve `app` on a bound server until it stops.
pub fn serve_on(server: &Server, app: &mut App, token: Option<&str>) {
    for mut req in server.incoming_requests() {
        let (path, query) = parse_url(req.url());
        let response = if path.starts_with("/api/") {
            match api(app, &mut req, &path, &query, token) {
                Ok(value) => json_response(200, &value),
                Err(err) => json_response(err.status, &json!({ "error": err.message })),
            }
        } else if path == "/docs" || path.starts_with("/docs/") {
            let sub = match path.as_str() {
                "/docs" | "/docs/" => "index.html",
                p => &p["/docs/".len()..],
            };
            match DOCS.iter().find(|a| a.path == sub) {
                Some(asset) => file_response(asset),
                None => json_response(404, &json!({ "error": "Not found." })),
            }
        } else {
            let rel = if path == "/" {
                "index.html"
            } else {
                &path[1..]
            };
            match ASSETS.iter().find(|a| a.path == rel) {
                Some(asset) => file_response(asset),
                None => json_response(404, &json!({ "error": "Not found." })),
            }
        };
        let _ = req.respond(response);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let (path, q) = parse_url("/api/state?revset=all()%20%7C%20@&at=&x=a+b#frag");
        assert_eq!(path, "/api/state");
        assert_eq!(q.get("revset").map(String::as_str), Some("all() | @"));
        assert_eq!(q.get("at").map(String::as_str), Some(""));
        assert_eq!(q.get("x").map(String::as_str), Some("a b"));
        assert_eq!(origin_host("http://127.0.0.1:7777"), Some("127.0.0.1:7777"));
        assert_eq!(decode("100%"), "100%");
    }
}
