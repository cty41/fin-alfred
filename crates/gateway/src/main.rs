use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use fin_alfred_runtime::Runtime;
use rand::RngCore;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

const ADDRESS: &str = "127.0.0.1:43117";
const SESSION_COOKIE: &str = "fin_alfred_session";

#[derive(Clone)]
struct GatewayState {
    runtime: Arc<Runtime>,
    bootstrap_token: Arc<Mutex<Option<String>>>,
    session_token: String,
    allowed_origin: String,
    allowed_hosts: Vec<String>,
}

#[derive(Deserialize)]
struct SessionRequest {
    token: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let options = Options::parse()?;
    let runtime = Arc::new(Runtime::open_system()?);
    let bootstrap_token =
        std::env::var("FIN_ALFRED_BOOTSTRAP_TOKEN").unwrap_or_else(|_| random_token());
    let session_token = random_token();
    let browser_origin = options
        .ui_url
        .clone()
        .unwrap_or_else(|| format!("http://{ADDRESS}"));
    let browser_host = browser_origin
        .strip_prefix("http://")
        .unwrap_or(&browser_origin)
        .trim_end_matches('/')
        .to_string();
    let state = GatewayState {
        runtime,
        bootstrap_token: Arc::new(Mutex::new(Some(bootstrap_token.clone()))),
        session_token,
        allowed_origin: browser_origin.trim_end_matches('/').to_string(),
        allowed_hosts: vec![ADDRESS.to_string(), browser_host],
    };
    let static_service = ServeDir::new(&options.static_dir)
        .fallback(ServeFile::new(options.static_dir.join("index.html")));
    let app = Router::new()
        .route("/health", get(health))
        .route("/api/v1/session", get(session_status).post(create_session))
        .route("/api/v1/invoke/{command}", post(invoke))
        .route("/mcp", post(mcp))
        .fallback_service(static_service)
        .with_state(state);
    let listener = TcpListener::bind(ADDRESS).await?;
    let url = format!("{browser_origin}/#token={bootstrap_token}");
    println!("fin-alfred gateway listening on http://{ADDRESS}");
    if options.open_browser {
        webbrowser::open(&url)?;
    } else {
        println!("open {url}");
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn health(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    if !valid_host(&state, &headers) {
        return error(StatusCode::BAD_REQUEST, "invalid host");
    }
    Json(json!({"service":"fin-alfred","status":"ok"})).into_response()
}

async fn create_session(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(input): Json<SessionRequest>,
) -> Response {
    if !valid_browser_request(&state, &headers, false) {
        return error(StatusCode::FORBIDDEN, "browser origin rejected");
    }
    let accepted = state
        .bootstrap_token
        .lock()
        .ok()
        .and_then(|mut token| {
            if token.as_deref() == Some(input.token.as_str()) {
                token.take()
            } else {
                None
            }
        })
        .is_some();
    if !accepted {
        return error(
            StatusCode::UNAUTHORIZED,
            "bootstrap token is invalid or already used",
        );
    }
    let mut response = Json(json!({"authenticated":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!(
            "{SESSION_COOKIE}={}; HttpOnly; SameSite=Strict; Path=/",
            state.session_token
        )
        .parse()
        .expect("session cookie is valid"),
    );
    response
}

async fn session_status(State(state): State<GatewayState>, headers: HeaderMap) -> Response {
    if valid_host(&state, &headers)
        && cookie(&headers, SESSION_COOKIE).as_deref() == Some(&state.session_token)
    {
        Json(json!({"authenticated":true})).into_response()
    } else {
        error(
            StatusCode::UNAUTHORIZED,
            "authenticated browser session required",
        )
    }
}

async fn invoke(
    State(state): State<GatewayState>,
    Path(command): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> Response {
    if !valid_browser_request(&state, &headers, true) {
        return error(
            StatusCode::UNAUTHORIZED,
            "authenticated browser session required",
        );
    }
    match state.runtime.invoke(&command, args) {
        Ok(value) => Json(json!({"ok":true,"value":value})).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"ok":false,"error":message})),
        )
            .into_response(),
    }
}

async fn mcp(
    State(state): State<GatewayState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if !valid_host(&state, &headers) {
        return error(StatusCode::UNAUTHORIZED, "valid MCP bearer token required");
    }
    let Some(profile_scope) = valid_mcp_token(&state, &headers) else {
        return error(StatusCode::UNAUTHORIZED, "valid MCP bearer token required");
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion":"2025-03-26",
            "capabilities":{"tools":{"listChanged":false}},
            "serverInfo":{"name":"fin-alfred","version":env!("CARGO_PKG_VERSION")}
        })),
        "tools/list" => Ok(json!({"tools": mcp_tools()})),
        "tools/call" => call_mcp_tool(
            &state.runtime,
            &profile_scope,
            request.get("params").cloned().unwrap_or_default(),
        ),
        "notifications/initialized" => return StatusCode::NO_CONTENT.into_response(),
        _ => Err(format!("unsupported MCP method: {method}")),
    };
    match result {
        Ok(result) => Json(json!({"jsonrpc":"2.0","id":id,"result":result})).into_response(),
        Err(message) => {
            Json(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":message}}))
                .into_response()
        }
    }
}

fn mcp_tools() -> Value {
    json!([
        {"name":"get_overview","description":"读取令牌绑定投资档案的持仓、现金、估值和阶段概览","inputSchema":{"type":"object","required":["profileId"],"properties":{"profileId":{"type":"string"}}}},
        {"name":"get_profile_activity","description":"读取指定档案的账本成交和审计活动","inputSchema":{"type":"object","required":["profileId"],"properties":{"profileId":{"type":"string"}}}},
        {"name":"list_strategies","description":"读取指定档案的策略草稿和历史版本","inputSchema":{"type":"object","required":["profileId"],"properties":{"profileId":{"type":"string"}}}},
        {"name":"create_strategy_draft","description":"创建策略草稿；不能校验或发布","inputSchema":{"type":"object","required":["profileId","draft"],"properties":{"profileId":{"type":"string"},"draft":{"type":"object"}}}},
        {"name":"analyze_with_byok","description":"使用已配置BYOK模型分析并创建研究草稿","inputSchema":{"type":"object","required":["input"],"properties":{"input":{"type":"object"}}}}
    ])
}

fn call_mcp_tool(runtime: &Runtime, profile_scope: &str, params: Value) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("missing tool name")?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let command = match name {
        "get_overview" => "get_overview",
        "get_profile_activity" => "get_profile_activity",
        "list_strategies" => "list_strategies",
        "create_strategy_draft" => "save_strategy_draft",
        "analyze_with_byok" => "send_agent_message",
        _ => return Err("tool is not available to MCP".into()),
    };
    let requested_profile = if name == "analyze_with_byok" {
        arguments
            .get("input")
            .and_then(|input| input.get("profileId"))
            .and_then(Value::as_str)
    } else {
        arguments.get("profileId").and_then(Value::as_str)
    }
    .ok_or("missing profileId")?;
    if requested_profile != profile_scope {
        return Err("MCP token cannot access another profile".into());
    }
    let value = runtime.invoke(command, arguments)?;
    Ok(
        json!({"content":[{"type":"text","text":serde_json::to_string(&value).map_err(|error| error.to_string())?}]}),
    )
}

fn valid_host(state: &GatewayState, headers: &HeaderMap) -> bool {
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| state.allowed_hosts.iter().any(|allowed| allowed == host))
}

fn valid_browser_request(state: &GatewayState, headers: &HeaderMap, require_session: bool) -> bool {
    if !valid_host(state, headers) {
        return false;
    }
    let origin_ok = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| origin == state.allowed_origin);
    if !origin_ok {
        return false;
    }
    !require_session || cookie(headers, SESSION_COOKIE).as_deref() == Some(&state.session_token)
}

fn valid_mcp_token(state: &GatewayState, headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .and_then(|token| state.runtime.verify_mcp_token(token))
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_string()))
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"ok":false,"error":message}))).into_response()
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

struct Options {
    static_dir: PathBuf,
    ui_url: Option<String>,
    open_browser: bool,
}

impl Options {
    fn parse() -> anyhow::Result<Self> {
        let mut static_dir = PathBuf::from("dist");
        let mut ui_url = None;
        let mut open_browser = true;
        let mut args = std::env::args().skip(1);
        while let Some(argument) = args.next() {
            match argument.as_str() {
                "--static-dir" => {
                    static_dir = PathBuf::from(
                        args.next()
                            .ok_or_else(|| anyhow::anyhow!("--static-dir requires a path"))?,
                    )
                }
                "--ui-url" => {
                    ui_url = Some(
                        args.next()
                            .ok_or_else(|| anyhow::anyhow!("--ui-url requires a URL"))?,
                    )
                }
                "--no-open" => open_browser = false,
                _ => anyhow::bail!("unknown argument: {argument}"),
            }
        }
        Ok(Self {
            static_dir,
            ui_url,
            open_browser,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_surface_never_contains_formal_mutations() {
        let tools = mcp_tools().to_string();
        assert!(!tools.contains("publish_strategy"));
        assert!(!tools.contains("accept_decision"));
        assert!(!tools.contains("record_decision_execution"));
    }

    #[test]
    fn cookie_parser_uses_exact_cookie_name() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=x; fin_alfred_session=secret".parse().unwrap(),
        );
        assert_eq!(cookie(&headers, SESSION_COOKIE).as_deref(), Some("secret"));
    }
}
