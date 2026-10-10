use std::time::Duration;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{
        DefaultBodyLimit, Path, Request, State,
        rejection::JsonRejection,
        ws::{Message, WebSocket, WebSocketUpgrade, rejection::WebSocketUpgradeRejection},
    },
    http::{HeaderMap, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use crate::{
    auth::Auth,
    model::{ChangeEvent, DeleteRequest, PublishRequest},
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
    auth: Auth,
    port: u16,
}

pub fn router(service: AppService, auth: Auth, port: u16) -> Router {
    let state = HttpState {
        service: service.clone(),
        auth: auth.with_port(port),
        port,
    };
    Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({"status": "ok"})) }),
        )
        .route("/api/launch", post(launch))
        .route("/api/session", post(session))
        .route("/api/explanations", get(list))
        .route(
            "/api/explanations/{id}",
            get(fetch).put(publish).delete(delete),
        )
        .route("/ws", get(websocket))
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
    let bearer_only = path == "/api/launch" || path == "/mcp" || path.starts_with("/mcp/");
    let protected = bearer_only
        || path == "/ws"
        || (path.starts_with("/api/") && path != "/api/health" && path != "/api/session");
    if (bearer_only && !state.auth.bearer_authorized(request.headers()))
        || (protected && !bearer_only && !state.auth.authorized(request.headers()))
    {
        return error(StatusCode::UNAUTHORIZED, "authentication required");
    }
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

async fn launch(State(state): State<HttpState>, headers: HeaderMap) -> Json<serde_json::Value> {
    let host = headers.get(header::HOST).unwrap().to_str().unwrap();
    Json(json!({"url": format!("http://{host}/#launch={}", state.auth.launch_code())}))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRequest {
    code: String,
}

async fn session(
    State(state): State<HttpState>,
    payload: Result<Json<SessionRequest>, JsonRejection>,
) -> Response {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid session request"),
    };
    let Some(session) = state.auth.exchange(&payload.code) else {
        return error(StatusCode::UNAUTHORIZED, "invalid or expired launch code");
    };
    let mut response = Json(json!({"status": "ok"})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "{}={session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
            state.auth.cookie_name()
        )
        .parse()
        .unwrap(),
    );
    response
}

async fn list(State(state): State<HttpState>) -> Response {
    service_response(state.service.list().await)
}

async fn fetch(State(state): State<HttpState>, Path(id): Path<String>) -> Response {
    service_response(state.service.get(&id).await)
}

async fn publish(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    payload: Result<Json<PublishRequest>, JsonRejection>,
) -> Response {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid publish request"),
    };
    service_response(state.service.publish(&id, payload).await)
}

async fn delete(
    State(state): State<HttpState>,
    Path(id): Path<String>,
    payload: Result<Json<DeleteRequest>, JsonRejection>,
) -> Response {
    let Json(payload) = match payload {
        Ok(payload) => payload,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid delete request"),
    };
    service_response(state.service.delete(&id, payload).await)
}

fn service_response<T: serde::Serialize>(result: Result<T, ServiceError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(ServiceError::Invalid(message)) => error(StatusCode::BAD_REQUEST, &message),
        Err(ServiceError::NotFound) => error(StatusCode::NOT_FOUND, "explanation not found"),
        Err(ServiceError::Conflict) => error(StatusCode::CONFLICT, "revision conflict"),
        Err(ServiceError::Storage(_)) => error(StatusCode::INTERNAL_SERVER_ERROR, "storage error"),
    }
}

async fn websocket(
    State(state): State<HttpState>,
    headers: HeaderMap,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let upgrade = match upgrade {
        Ok(upgrade) => upgrade,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid WebSocket upgrade"),
    };
    let changes = state.service.subscribe();
    upgrade
        .on_upgrade(move |socket| invalidations(socket, changes, state.auth, headers))
        .into_response()
}

async fn send(socket: &mut WebSocket, message: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(5), socket.send(message)).await,
        Ok(Ok(()))
    )
}

async fn invalidations(
    mut socket: WebSocket,
    mut changes: broadcast::Receiver<ChangeEvent>,
    auth: Auth,
    headers: HeaderMap,
) {
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
                if !auth.authorized(&headers) || !send(&mut socket, Message::Ping(Vec::new().into())).await { break; }
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
