use std::error::Error as StdError;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model_name: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

fn reqwest_error_details(error: &reqwest::Error, url: &str) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_request() {
        "request"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else {
        "unknown"
    };

    let mut parts = vec![
        format!("type={category}"),
        format!("url={url}"),
        format!("message={error}"),
    ];

    if let Some(status) = error.status() {
        parts.push(format!("status={status}"));
    }

    if let Some(error_url) = error.url() {
        parts.push(format!("reqwest_url={error_url}"));
    }

    let mut sources = Vec::new();
    let mut current = error.source();
    while let Some(source) = current {
        sources.push(source.to_string());
        current = source.source();
    }
    if !sources.is_empty() {
        parts.push(format!("sources={}", sources.join(" | ")));
    }

    parts.join("; ")
}

fn should_retry_with_access_token(status: reqwest::StatusCode, body: &str, api_key: &str) -> bool {
    if status != reqwest::StatusCode::UNAUTHORIZED || api_key.trim().is_empty() {
        return false;
    }

    let lowered = body.to_ascii_lowercase();
    lowered.contains("access_token")
        || lowered.contains("missing access token")
        || lowered.contains("invalid access token")
}

fn should_bypass_system_proxy(url: &str) -> bool {
    let Ok(parsed_url) = reqwest::Url::parse(url) else {
        return false;
    };

    let Some(host) = parsed_url.host_str() else {
        return false;
    };

    host == "chat.ecnu.edu.cn" || host.ends_with(".ecnu.edu.cn")
}

fn request_with_bearer_auth(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
    request: &ChatRequest,
) -> Result<reqwest::blocking::Response, reqwest::Error> {
    client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(request)
        .send()
}

fn request_with_access_token(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
    request: &ChatRequest,
) -> Result<reqwest::blocking::Response, String> {
    let mut parsed_url =
        reqwest::Url::parse(url).map_err(|error| format!("Invalid LLM API URL '{url}': {error}"))?;
    parsed_url
        .query_pairs_mut()
        .append_pair("access_token", api_key);

    client
        .post(parsed_url)
        .header("Content-Type", "application/json")
        .json(request)
        .send()
        .map_err(|error| format!("LLM request failed: {}", reqwest_error_details(&error, url)))
}

fn flatten_content_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(text.clone()),
                    Value::Object(map) => map
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .or_else(|| {
                            map.get("content")
                                .and_then(Value::as_str)
                                .map(ToOwned::to_owned)
                        }),
                    _ => None,
                })
                .collect::<Vec<_>>();

            if parts.is_empty() {
                None
            } else {
                Some(parts.join(""))
            }
        }
        _ => None,
    }
}

fn extract_message_content(choice: &Value) -> Option<String> {
    let message = choice.get("message")?;

    message
        .get("content")
        .and_then(flatten_content_value)
        .or_else(|| {
            message
                .get("reasoning_content")
                .and_then(flatten_content_value)
        })
        .or_else(|| choice.get("text").and_then(flatten_content_value))
        .map(|content| content.trim().to_string())
        .filter(|content| !content.is_empty())
}

fn parse_llm_response(body: &str) -> Result<String, String> {
    let response: Value =
        serde_json::from_str(body).map_err(|error| format!("Failed to parse LLM response JSON: {error}"))?;
    let choices = response
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "LLM response did not contain a valid choices array.".to_string())?;

    choices
        .iter()
        .find_map(extract_message_content)
        .ok_or_else(|| "No response content found in LLM response.".to_string())
}

fn send_chat_request(
    client: &reqwest::blocking::Client,
    url: &str,
    api_key: &str,
    request: &ChatRequest,
) -> Result<String, String> {
    let mut response = request_with_bearer_auth(client, url, api_key, request)
        .map_err(|error| format!("LLM request failed: {}", reqwest_error_details(&error, url)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();

        if should_retry_with_access_token(status, &body, api_key) {
            response = request_with_access_token(client, url, api_key, request)?;
        } else {
            return Err(format!("LLM API error ({}): {}", status, body));
        }
    }

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, body));
    }

    response
        .text()
        .map_err(|error| format!("Failed to read LLM response body: {}", reqwest_error_details(&error, url)))
}

pub fn call_llm(config: &LlmConfig, system_prompt: &str, user_prompt: &str) -> Result<String, String> {
    let url = format!(
        "{}/v1/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let mut client_builder = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .http1_only()
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")));
    if should_bypass_system_proxy(&url) {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
        .build()
        .map_err(|error| format!("Failed to build LLM HTTP client: {}", reqwest_error_details(&error, &url)))?;

    let primary_system_prompt = if system_prompt.is_empty() {
        String::new()
    } else {
        system_prompt.to_string()
    };
    let mut messages = Vec::new();
    if !primary_system_prompt.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: primary_system_prompt,
        });
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_prompt.to_string(),
    });

    let request = ChatRequest {
        model: config.model_name.clone(),
        messages,
    };
    let body = send_chat_request(&client, &url, &config.api_key, &request)?;

    match parse_llm_response(&body) {
        Ok(content) => Ok(content),
        Err(error) if error.contains("No response content found") => {
            let retry_system_prompt = if system_prompt.is_empty() {
                "Return a non-empty plain text answer in message.content. Do not call tools and do not leave content null.".to_string()
            } else {
                format!(
                    "{system_prompt}\n\nReturn a non-empty plain text answer in message.content. Do not call tools and do not leave content null."
                )
            };
            let retry_request = ChatRequest {
                model: config.model_name.clone(),
                messages: vec![
                    ChatMessage {
                        role: "system".to_string(),
                        content: retry_system_prompt,
                    },
                    ChatMessage {
                        role: "user".to_string(),
                        content: user_prompt.to_string(),
                    },
                ],
            };
            let retry_body = send_chat_request(&client, &url, &config.api_key, &retry_request)?;
            parse_llm_response(&retry_body).map_err(|retry_error| {
                format!(
                    "{retry_error} The model returned an empty completion twice. Retry body: {retry_body}"
                )
            })
        }
        Err(error) => Err(format!("{error} Body: {body}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_llm_response, should_bypass_system_proxy, should_retry_with_access_token};

    #[test]
    fn retries_when_service_reports_missing_access_token() {
        assert!(should_retry_with_access_token(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"detail":"缺少 access_token"}"#,
            "test-key",
        ));
    }

    #[test]
    fn does_not_retry_without_api_key() {
        assert!(!should_retry_with_access_token(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"detail":"缺少 access_token"}"#,
            "",
        ));
    }

    #[test]
    fn parses_standard_content_string() {
        let body = r#"{"choices":[{"message":{"content":"hello"}}]}"#;
        assert_eq!(parse_llm_response(body).expect("response should parse"), "hello");
    }

    #[test]
    fn parses_when_content_is_null_but_text_exists() {
        let body = r#"{"choices":[{"message":{"content":null},"text":"hello"}]}"#;
        assert_eq!(parse_llm_response(body).expect("response should parse"), "hello");
    }

    #[test]
    fn parses_content_parts_array() {
        let body = r#"{"choices":[{"message":{"content":[{"type":"text","text":"hel"},{"type":"text","text":"lo"}]}}]}"#;
        assert_eq!(parse_llm_response(body).expect("response should parse"), "hello");
    }

    #[test]
    fn bypasses_proxy_for_ecnu_host() {
        assert!(should_bypass_system_proxy(
            "https://chat.ecnu.edu.cn/open/api/v1/chat/completions"
        ));
    }

    #[test]
    fn keeps_proxy_for_other_hosts() {
        assert!(!should_bypass_system_proxy(
            "https://api.openai.com/v1/chat/completions"
        ));
    }
}
