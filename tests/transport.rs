use std::{
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use lain::{auth::Auth, http, service::AppService};
use reqwest::{Client, Response, StatusCode};
use serde_json::{Value, json};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

const TOKEN: &str = "test-bearer-credential-not-for-public-output";

struct Server {
    base: String,
    client: Client,
    task: tokio::task::JoinHandle<()>,
    _home: tempfile::TempDir,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn start() -> Self {
        let home = tempfile::tempdir().unwrap();
        let service = AppService::open(&home.path().join("test.sqlite"))
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let router = http::router(service, Auth::new(TOKEN.into()), port);
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            base: format!("http://127.0.0.1:{port}"),
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            task,
            _home: home,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    async fn mcp(&self, message: Value) -> Response {
        let response = self
            .client
            .post(self.url("/mcp"))
            .bearer_auth(TOKEN)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-03-26")
            .json(&message)
            .send()
            .await
            .unwrap();
        assert!(
            response.status().is_success(),
            "MCP status: {}",
            response.status()
        );
        response
    }

    async fn browser_cookie(&self) -> String {
        let launch: Value = self
            .client
            .post(self.url("/api/launch"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let code = launch["url"]
            .as_str()
            .unwrap()
            .split("#launch=")
            .nth(1)
            .unwrap();
        let response = self
            .client
            .post(self.url("/api/session"))
            .json(&json!({"code": code}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned()
    }
}

fn document() -> Value {
    json!({
        "schemaVersion": 1, "title": "Transport example", "description": "Captured traversal",
        "domain": {"entities": [], "relationships": []},
        "diagrams": [{"id": "flow", "title": "Flow", "kind": "flow", "nodes": [
            {"id": "start", "label": "Start", "entityIds": []}
        ], "edges": []}],
        "scenarios": [{"id": "run", "title": "Run", "diagramId": "flow", "occurrences": [{
            "id": "visit-1", "nodeId": "start", "incomingEdgeId": null, "trigger": null,
            "narration": "Start observed", "before": {"instances": [], "links": []},
            "after": {"instances": [], "links": []}
        }]}]
    })
}

fn sequence_document() -> Value {
    let mut value = document();
    value["diagrams"][0]["kind"] = json!("sequence");
    value["diagrams"][0]["sequence"] = json!({
        "participants": [{"id": "client", "label": "<script>Client</script>"}],
        "messages": [{"nodeId": "start", "fromParticipantId": "client", "toParticipantId": "client"}],
        "body": [{"kind": "message", "nodeId": "start"}]
    });
    value
}

async fn rpc_response(mut response: Response) -> Value {
    if response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("application/json")
    {
        return response.json().await.unwrap();
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.unwrap() {
        bytes.extend_from_slice(&chunk);
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines() {
            if let Some(data) = line
                .strip_prefix("data: ")
                .or_else(|| line.strip_prefix("data:"))
                && let Ok(value) = serde_json::from_str::<Value>(data)
                && value.get("id").is_some()
            {
                return value;
            }
        }
    }
    panic!("MCP stream ended without a response")
}

fn tool_value(response: &Value) -> Value {
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn public_shell_and_assets_never_expose_authenticated_data() {
    let server = Server::start().await;
    let health: Value = server
        .client
        .get(server.url("/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health, json!({"status": "ok"}));
    let shell = server.client.get(server.url("/")).send().await.unwrap();
    assert_eq!(shell.status(), StatusCode::OK);
    assert!(
        shell.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html")
    );
    let shell = shell.text().await.unwrap();
    assert!(!shell.contains(TOKEN));
    let asset = shell
        .split("src=\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let asset = server.client.get(server.url(asset)).send().await.unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert!(!asset.text().await.unwrap().contains(TOKEN));
    for path in [
        "/api/explanations",
        "/api/explanations/example",
        "/api/launch",
        "/mcp",
        "/ws",
    ] {
        let response = server.client.get(server.url(path)).send().await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({"error": "authentication required"})
        );
    }
    let response = server
        .client
        .delete(server.url("/api/explanations/example"))
        .json(&json!({"expectedRevision": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn host_and_origin_must_match_exact_loopback_authority_even_for_assets() {
    let server = Server::start().await;
    let port = server.base.rsplit(':').next().unwrap();
    for host in [
        "evil.example".to_owned(),
        format!("127.0.0.2:{port}"),
        "localhost".into(),
        format!("127.0.0.1:{port}.evil"),
    ] {
        let response = server
            .client
            .get(server.url("/"))
            .header("Host", host)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    for origin in [
        "null".to_owned(),
        "https://evil.example".into(),
        format!("http://localhost:{port}"),
        format!("{}/", server.base),
        format!("{}#fragment", server.base),
    ] {
        let response = server
            .client
            .get(server.url("/api/health"))
            .header("Origin", &origin)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response.json::<Value>().await.unwrap()["error"].is_string());
        let response = server
            .client
            .delete(server.url("/api/explanations/example"))
            .bearer_auth(TOKEN)
            .header("Origin", origin)
            .json(&json!({"expectedRevision": 1}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = server
        .client
        .get(server.url("/api/health"))
        .header("Origin", &server.base)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = server
        .client
        .get(server.url("/api/health"))
        .header("Host", format!("localhost:{port}"))
        .header("Origin", format!("http://localhost:{port}"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn launch_exchange_sets_single_use_cookie_but_mcp_and_launch_require_bearer() {
    let server = Server::start().await;
    let launch: Value = server
        .client
        .post(server.url("/api/launch"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let url = launch["url"].as_str().unwrap();
    assert!(!url.contains(TOKEN));
    assert!(url.starts_with(&format!("{}/#launch=", server.base)));
    let code = url.split("#launch=").nth(1).unwrap();
    let exchange = server
        .client
        .post(server.url("/api/session"))
        .json(&json!({"code": code}))
        .send()
        .await
        .unwrap();
    assert_eq!(exchange.status(), StatusCode::OK);
    let cookie = exchange.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .to_owned();
    for flag in ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200"] {
        assert!(cookie.contains(flag));
    }
    let cookie = cookie.split(';').next().unwrap();
    let port = server.base.rsplit(':').next().unwrap();
    assert!(cookie.starts_with(&format!("lain_session_{port}=")));
    let response = server
        .client
        .get(server.url("/api/explanations"))
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json::<Value>().await.unwrap(), json!([]));
    for path in ["/mcp", "/api/launch"] {
        let response = server
            .client
            .post(server.url(path))
            .header("Cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let replay = server
        .client
        .post(server.url("/api/session"))
        .json(&json!({"code": code}))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    let query = server
        .client
        .get(format!("{}?token={TOKEN}", server.url("/api/explanations")))
        .send()
        .await
        .unwrap();
    assert_eq!(query.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn browser_sessions_use_port_scoped_cookie_names() {
    let first = Server::start().await;
    let second = Server::start().await;
    let first_cookie = first.browser_cookie().await;
    let second_cookie = second.browser_cookie().await;
    let (first_name, first_session) = first_cookie.split_once('=').unwrap();
    let (second_name, second_session) = second_cookie.split_once('=').unwrap();
    assert_eq!(
        first_name,
        format!("lain_session_{}", first.base.rsplit(':').next().unwrap())
    );
    assert_eq!(
        second_name,
        format!("lain_session_{}", second.base.rsplit(':').next().unwrap())
    );
    assert_ne!(first_name, second_name);
    let browser_cookies = format!("{first_cookie}; {second_cookie}");
    for server in [&first, &second] {
        let response = server
            .client
            .get(server.url("/api/explanations"))
            .header("Cookie", &browser_cookies)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.json::<Value>().await.unwrap(), json!([]));
    }
    for (server, foreign_cookie, wrong_name_cookie) in [
        (
            &first,
            &second_cookie,
            format!("{second_name}={first_session}"),
        ),
        (
            &second,
            &first_cookie,
            format!("{first_name}={second_session}"),
        ),
    ] {
        for cookie in [foreign_cookie, &wrong_name_cookie] {
            let response = server
                .client
                .get(server.url("/api/explanations"))
                .header("Cookie", cookie)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
    }
}

#[tokio::test]
async fn stalled_uploads_receive_json_timeout_without_finishing_the_body() {
    let server = Server::start().await;
    let authority = server.base.strip_prefix("http://").unwrap().to_owned();
    let response = tokio::task::spawn_blocking(move || {
        let mut socket = TcpStream::connect(&authority).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        socket.set_write_timeout(Some(Duration::from_secs(8))).unwrap();
        let request = format!(
            "PUT /api/explanations/stalled HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{{"
        );
        socket.write_all(request.as_bytes()).unwrap();
        let mut response = Vec::new();
        let mut chunk = [0_u8; 1024];
        loop {
            let length = socket.read(&mut chunk).unwrap();
            assert_ne!(length, 0, "connection closed before the JSON timeout response");
            response.extend_from_slice(&chunk[..length]);
            let text = String::from_utf8_lossy(&response);
            if let Some((headers, body)) = text.split_once("\r\n\r\n")
                && let Ok(body) = serde_json::from_str::<Value>(body)
            {
                return (headers.to_owned(), body);
            }
        }
    })
    .await
    .unwrap();
    assert!(response.0.starts_with("HTTP/1.1 408 Request Timeout\r\n"));
    assert!(
        response
            .0
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
    assert_eq!(response.1, json!({"error": "request body read timed out"}));
    let health = server
        .client
        .get(server.url("/api/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
}

#[tokio::test]
async fn rest_reports_invalid_missing_conflicting_and_oversized_requests_as_json() {
    let server = Server::start().await;
    let response = server
        .client
        .get(server.url("/api/explanations/missing"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error": "explanation not found"})
    );
    let response = server
        .client
        .put(server.url("/api/explanations/example"))
        .bearer_auth(TOKEN)
        .json(&json!({"bad": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response.json::<Value>().await.unwrap()["error"].is_string());
    let payload = json!({"expectedRevision": 0, "document": sequence_document()});
    let response = server
        .client
        .put(server.url("/api/explanations/example"))
        .bearer_auth(TOKEN)
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stored = response.json::<Value>().await.unwrap();
    assert_eq!(stored["revision"], 1);
    assert_eq!(stored["document"], sequence_document());
    let response = server
        .client
        .put(server.url("/api/explanations/example"))
        .bearer_auth(TOKEN)
        .json(&payload)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error": "revision conflict"})
    );
    let response = server
        .client
        .put(server.url("/api/explanations/example"))
        .bearer_auth(TOKEN)
        .header("Content-Type", "application/json")
        .body("x".repeat(3 * 1024 * 1024))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"error": "request body too large"})
    );
    for (id, payload, status) in [
        ("example", json!({}), StatusCode::BAD_REQUEST),
        (
            "example",
            json!({"expectedRevision": 0}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "example",
            json!({"expectedRevision": i64::MAX as u64}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "example",
            json!({"expectedRevision": 1, "extra": true}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "missing",
            json!({"expectedRevision": 1}),
            StatusCode::NOT_FOUND,
        ),
        (
            "example",
            json!({"expectedRevision": 2}),
            StatusCode::CONFLICT,
        ),
    ] {
        let response = server
            .client
            .delete(server.url(&format!("/api/explanations/{id}")))
            .bearer_auth(TOKEN)
            .json(&payload)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert!(response.json::<Value>().await.unwrap()["error"].is_string());
    }
    let response = server
        .client
        .delete(server.url("/api/explanations/example"))
        .header("Cookie", server.browser_cookie().await)
        .json(&json!({"expectedRevision": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({"id": "example", "revision": 2, "deleted": true})
    );
    let response = server
        .client
        .get(server.url("/api/explanations/example"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn streamable_http_initializes_discovers_schema_and_calls_shared_service_tools() {
    let server = Server::start().await;
    let initialize = server.mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "transport-test", "version": "1"}
    }})).await;
    let initialize = rpc_response(initialize).await;
    assert!(initialize["result"]["capabilities"]["tools"].is_object());
    assert!(
        initialize["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("Redact")
    );
    assert!(!initialize.to_string().contains(TOKEN));
    let initialized = server
        .mcp(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
        .await;
    assert_eq!(initialized.status(), StatusCode::ACCEPTED);
    let listed = rpc_response(
        server
            .mcp(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}))
            .await,
    )
    .await;
    let tools = listed["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 4);
    for name in [
        "list_explanations",
        "get_explanation",
        "publish_explanation",
        "delete_explanation",
    ] {
        assert!(tools.iter().any(|tool| tool["name"] == name));
    }
    let publish = tools
        .iter()
        .find(|tool| tool["name"] == "publish_explanation")
        .unwrap();
    assert!(publish["inputSchema"]["properties"]["document"].is_object());
    assert!(publish["inputSchema"].to_string().contains("occurrences"));
    let definitions = &publish["inputSchema"]["$defs"];
    assert_eq!(
        definitions["DiagramKind"]["enum"],
        json!(["flow", "state", "process", "sequence"])
    );
    assert!(definitions["Diagram"]["properties"]["sequence"].is_object());
    assert!(
        !definitions["Diagram"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("sequence"))
    );
    assert_eq!(
        definitions["SequenceParticipant"]["additionalProperties"],
        false
    );
    assert_eq!(
        definitions["SequenceMessage"]["additionalProperties"],
        false
    );
    assert!(
        definitions["Sequence"]["required"]
            .as_array()
            .unwrap()
            .contains(&json!("body"))
    );
    let variants = definitions["SequenceStep"]["oneOf"].as_array().unwrap();
    assert_eq!(variants.len(), 4);
    assert!(
        variants
            .iter()
            .all(|variant| variant["additionalProperties"] == false)
    );
    for kind in ["message", "alt", "opt", "loop"] {
        assert!(
            variants
                .iter()
                .any(|variant| variant["properties"]["kind"]["const"] == kind)
        );
    }
    for field in ["incomingEdgeId", "trigger"] {
        assert!(
            definitions["Occurrence"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!(field))
        );
        assert_eq!(
            definitions["Occurrence"]["properties"][field]["$ref"],
            "#/$defs/NullableString"
        );
    }
    assert!(
        definitions["NullableString"]["anyOf"]
            .as_array()
            .unwrap()
            .iter()
            .any(|variant| variant.get("const") == Some(&Value::Null))
    );
    let published = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
        "name": "publish_explanation", "arguments": {"id": "mcp-example", "expectedRevision": 0, "document": sequence_document()}
    }})).await).await;
    assert_eq!(tool_value(&published)["revision"], 1);
    let fetched = rpc_response(
        server
            .mcp(
                json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
                    "name": "get_explanation", "arguments": {"id": "mcp-example"}
                }}),
            )
            .await,
    )
    .await;
    assert_eq!(tool_value(&fetched)["document"], sequence_document());
    let listed = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "list_explanations", "arguments": {}}})).await).await;
    assert_eq!(tool_value(&listed)[0]["id"], "mcp-example");
    let conflict = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {
        "name": "publish_explanation", "arguments": {"id": "mcp-example", "expectedRevision": 0, "document": document()}
    }})).await).await;
    assert_eq!(conflict["result"]["isError"], true);
    assert!(
        conflict["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("revision conflict")
    );
    let rest: Value = server
        .client
        .get(server.url("/api/explanations/mcp-example"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(rest, tool_value(&fetched));
    for revision in [0, 2, i64::MAX as u64] {
        let rejected = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "delete_explanation", "arguments": {"id": "mcp-example", "expectedRevision": revision}
        }})).await).await;
        assert_eq!(rejected["result"]["isError"], true);
    }
    let deleted = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {
        "name": "delete_explanation", "arguments": {"id": "mcp-example", "expectedRevision": 1}
    }})).await).await;
    assert_eq!(
        tool_value(&deleted),
        json!({"id": "mcp-example", "revision": 2, "deleted": true})
    );
    let missing = rpc_response(
        server
            .mcp(
                json!({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {
                    "name": "get_explanation", "arguments": {"id": "mcp-example"}
                }}),
            )
            .await,
    )
    .await;
    assert_eq!(missing["result"]["isError"], true);
    assert_eq!(
        missing["result"]["content"][0]["text"],
        "explanation not found"
    );
    let recreated = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {
        "name": "publish_explanation", "arguments": {"id": "mcp-example", "expectedRevision": 0, "document": sequence_document()}
    }})).await).await;
    assert_eq!(tool_value(&recreated)["revision"], 3);
}

#[tokio::test]
async fn rest_and_mcp_reject_traces_outside_the_shared_sequence_without_replacing_it() {
    let server = Server::start().await;
    let document: Value =
        serde_json::from_str(include_str!("../examples/order-lifecycle.json")).unwrap();
    let published = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "publish_explanation", "arguments": {"id": "shared-sequence", "expectedRevision": 0, "document": document}
    }})).await).await;
    assert_eq!(published["result"]["isError"], false);
    assert_eq!(tool_value(&published)["document"], document);
    let mut invalid = document.clone();
    invalid["diagrams"][2]["sequence"]["body"][2]["operands"][0]["body"]
        .as_array_mut()
        .unwrap()
        .reverse();
    let response = server
        .client
        .put(server.url("/api/explanations/shared-sequence"))
        .bearer_auth(TOKEN)
        .json(&json!({"expectedRevision": 1, "document": invalid}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(
        response.json::<Value>().await.unwrap()["error"]
            .as_str()
            .unwrap()
            .contains("shared sequence ordering")
    );
    let rejected = rpc_response(server.mcp(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
        "name": "publish_explanation", "arguments": {"id": "shared-sequence", "expectedRevision": 1, "document": invalid}
    }})).await).await;
    assert_eq!(rejected["result"]["isError"], true);
    assert!(
        rejected["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("shared sequence ordering")
    );
    let saved: Value = server
        .client
        .get(server.url("/api/explanations/shared-sequence"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["document"], document);
}

#[tokio::test]
async fn websocket_validates_origin_handles_ping_and_reports_committed_publication() {
    let server = Server::start().await;
    let ws_url = server.url("/ws").replacen("http://", "ws://", 1);
    let mut foreign = ws_url.clone().into_client_request().unwrap();
    foreign
        .headers_mut()
        .insert("Origin", "http://evil.example".parse().unwrap());
    foreign
        .headers_mut()
        .insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let rejected = connect_async(foreign).await.unwrap_err();
    match rejected {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status().as_u16(), 403)
        }
        error => panic!("unexpected WebSocket error: {error}"),
    }
    let mut request = ws_url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("Origin", server.base.parse().unwrap());
    request
        .headers_mut()
        .insert("Authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    socket
        .send(Message::Ping(b"client-ping".to_vec().into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Pong(bytes) if bytes.as_ref() == b"client-ping" => break,
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    let publish = server
        .client
        .put(server.url("/api/explanations/ws-example"))
        .bearer_auth(TOKEN)
        .json(&json!({"expectedRevision": 0, "document": document()}))
        .send()
        .await
        .unwrap();
    assert_eq!(publish.status(), StatusCode::OK);
    let change = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => break serde_json::from_str::<Value>(&text).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(change, json!({"id": "ws-example", "revision": 1}));
    let response = server
        .client
        .delete(server.url("/api/explanations/ws-example"))
        .bearer_auth(TOKEN)
        .json(&json!({"expectedRevision": 1}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let change = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match socket.next().await.unwrap().unwrap() {
                Message::Text(text) => break serde_json::from_str::<Value>(&text).unwrap(),
                Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        change,
        json!({"id": "ws-example", "revision": 2, "deleted": true})
    );
    socket.close(None).await.unwrap();
}
