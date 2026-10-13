use std::time::Duration;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        DefaultBodyLimit, Path, Query, Request, State,
        rejection::{JsonRejection, QueryRejection},
        ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use rust_embed::RustEmbed;
use serde_json::json;
use tokio::sync::broadcast;

use crate::{
    chart_export::{ExportError, ExportOptions, ExportTarget},
    model::{ChangeEvent, PublishRequest},
    service::{AppService, ServiceError},
};

const BODY_LIMIT: usize = 2 * 1024 * 1024 + 64 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(RustEmbed)]
#[folder = "frontend/dist/"]
struct Frontend;

#[derive(Clone)]
struct HttpState {
    service: AppService,
    port: u16,
}

pub fn router(service: AppService, port: u16) -> Router {
    let state = HttpState {
        service: service.clone(),
        port,
    };
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status": "ok"})) }),
        )
        .route("/api/explanations", get(list))
        .route(
            "/api/explanations/{id}",
            get(fetch).put(publish).delete(delete),
        )
        .route("/ws", get(websocket))
        .route(
            "/api/explanations/{id}/diagrams/{diagram_id}/export",
            get(export_diagram),
        )
        .route("/api/explanations/{id}/domain/export", get(export_domain))
        .merge(crate::mcp::router(service).with_state(()))
        .fallback(static_asset)
        .with_state(state.clone())
        .layer(DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(state, guard))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

async fn guard(State(state): State<HttpState>, request: Request, next: Next) -> Response {
    if !local_request(&request, state.port) {
        return error(
            StatusCode::FORBIDDEN,
            "loopback host and same-origin request required",
        );
    }
    let path = request.uri().path();
    let is_mcp = path == "/mcp" || path.starts_with("/mcp/");
    let (parts, body) = request.into_parts();
    let body = match tokio::time::timeout(BODY_TIMEOUT, to_bytes(body, BODY_LIMIT)).await {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "request body too large"),
        Err(_) => return error(StatusCode::REQUEST_TIMEOUT, "request body read timed out"),
    };
    let mut response = next.run(Request::from_parts(parts, Body::from(body))).await;
    if !is_mcp && response.status() == StatusCode::METHOD_NOT_ALLOWED {
        response = error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
}

fn local_request(request: &Request, port: u16) -> bool {
    let headers = request.headers();
    if headers.get_all(header::HOST).iter().count() != 1
        || headers.get_all(header::ORIGIN).iter().count() > 1
    {
        return false;
    }
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return false;
    }
    if request
        .uri()
        .authority()
        .is_some_and(|authority| authority.as_str() != host)
    {
        return false;
    }
    headers.get(header::ORIGIN).is_none_or(|origin| {
        origin
            .to_str()
            .is_ok_and(|origin| origin == format!("http://{host}"))
    })
}

async fn list(State(state): State<HttpState>) -> Response {
    service_response(state.service.list().await)
}

async fn fetch(State(state): State<HttpState>, Path(id): Path<String>) -> Response {
    service_response(state.service.get(&id).await)
}

async fn export_diagram(
    State(state): State<HttpState>,
    Path((id, diagram_id)): Path<(String, String)>,
    options: Result<Query<ExportOptions>, QueryRejection>,
) -> Response {
    export_response(state, id, ExportTarget::Diagram(diagram_id), options).await
}

async fn export_domain(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    options: Result<Query<ExportOptions>, QueryRejection>,
) -> Response {
    export_response(state, id, ExportTarget::Domain, options).await
}

async fn export_response(
    state: HttpState,
    id: String,
    target: ExportTarget,
    options: Result<Query<ExportOptions>, QueryRejection>,
) -> Response {
    let Query(options) = match options {
        Ok(options) => options,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid export options"),
    };
    let base_url = format!("http://127.0.0.1:{}", state.port);
    match state
        .service
        .export_chart(&id, target, options, &base_url)
        .await
    {
        Ok(download) => {
            let filename = percent_encoding::utf8_percent_encode(
                &download.filename,
                percent_encoding::NON_ALPHANUMERIC,
            );
            let fallback: String = download
                .filename
                .chars()
                .map(|character| {
                    if character.is_ascii_graphic() && !['"', '\\'].contains(&character)
                        || character == ' '
                    {
                        character
                    } else {
                        '_'
                    }
                })
                .collect();
            let disposition =
                format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{filename}");
            (
                [
                    (header::CONTENT_TYPE, download.mime_type.to_owned()),
                    (header::CONTENT_DISPOSITION, disposition),
                ],
                download.bytes,
            )
                .into_response()
        }
        Err(ExportError::Service(error)) => service_response::<()>(Err(error)),
        Err(ExportError::Invalid(message)) => error(StatusCode::BAD_REQUEST, &message),
        Err(ExportError::Missing(kind)) => {
            error(StatusCode::NOT_FOUND, &format!("{kind} not found"))
        }
        Err(ExportError::Unavailable(message)) => error(StatusCode::SERVICE_UNAVAILABLE, message),
        Err(ExportError::Render(cause)) => {
            tracing::warn!(error = %cause, "chart export failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, "chart export failed")
        }
    }
}

async fn publish(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<PublishRequest>, JsonRejection>,
) -> Response {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid publish request"),
    };
    let revision = match expected_revision(&headers) {
        Ok(revision) => revision,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    service_response(
        state
            .service
            .publish_with_revision(&id, payload, revision)
            .await,
    )
}

async fn delete(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let revision = match expected_revision(&headers) {
        Ok(revision) => revision,
        Err(message) => return error(StatusCode::BAD_REQUEST, message),
    };
    service_response(state.service.delete_with_revision(&id, revision).await)
}

fn expected_revision(headers: &HeaderMap) -> Result<Option<u64>, &'static str> {
    let values = headers.get_all(header::IF_MATCH);
    let mut values = values.iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    let revision = value
        .to_str()
        .ok()
        .and_then(|value| value.strip_prefix('"')?.strip_suffix('"'))
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|revision| *revision > 0 && *revision <= i64::MAX as u64);
    if values.next().is_some() || revision.is_none() {
        return Err("If-Match must contain one quoted positive revision");
    }
    Ok(revision)
}

fn service_response<T: serde::Serialize>(result: Result<T, ServiceError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(ServiceError::Invalid(message)) => error(StatusCode::BAD_REQUEST, &message),
        Err(ServiceError::NotFound) => error(StatusCode::NOT_FOUND, "explanation not found"),
        Err(ServiceError::Conflict) => error(
            StatusCode::PRECONDITION_FAILED,
            "explanation changed; refresh the library before trying again",
        ),
        Err(ServiceError::Storage(_)) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage error"),
    }
}

async fn websocket(
    State(state): State<HttpState>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid WebSocket upgrade"),
    };
    let changes = state.service.subscribe();
    upgrade
        .on_upgrade(move |socket| invalidations(socket, changes))
        .into_response()
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn invalidations(mut socket: WebSocket, mut changes: broadcast::Receiver<ChangeEvent>) {
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            change = changes.recv() => {
                let text = match change {
                    Ok(change) => serde_json::to_string(&change).expect("change event serializes"),
                    Err(broadcast::error::RecvError::Lagged(_)) => json!({"type": "refetch"}).to_string(),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if !send(&mut socket, Message::Text(text.into())).await { break; }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(bytes))) => {
                        if !send(&mut socket, Message::Pong(bytes)).await { break; }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                }
            }
            _ = heartbeat.tick() => {
                if !send(&mut socket, Message::Ping(Vec::new().into())).await { break; }
            }
        }
    }
    let _ = send(&mut socket, Message::Close(None)).await;
}

async fn static_asset(request: Request) -> Response {
    if request.method() != axum::http::Method::GET && request.method() != axum::http::Method::HEAD {
        return error(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
    }
    let path = request.uri().path().trim_start_matches('/');
    if path == "api"
        || path.starts_with("api/")
        || path.starts_with("mcp")
        || path.starts_with("ws/")
    {
        return error(StatusCode::NOT_FOUND, "route not found");
    }
    let file = if path.is_empty() { "index.html" } else { path };
    let asset = Frontend::get(file).or_else(|| {
        (!path.contains('.'))
            .then(|| Frontend::get("index.html"))
            .flatten()
    });
    let Some(asset) = asset else {
        return error(StatusCode::NOT_FOUND, "asset not found");
    };
    let mime = if Frontend::get(file).is_some() {
        mime_guess::from_path(file)
            .first_or_octet_stream()
            .to_string()
    } else {
        "text/html".into()
    };
    ([(header::CONTENT_TYPE, mime)], asset.data.into_owned()).into_response()
}
