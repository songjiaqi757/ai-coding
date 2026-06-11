use std::error::Error as StdError;
use std::time::Duration;

use serde::{Deserialize, Serialize};

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

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
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

pub fn call_llm(config: &LlmConfig, system_prompt: &str, user_prompt: &str) -> Result<String, String> {
    let url = format!(
        "{}/v1/chat/completions",
        config.base_url.trim_end_matches('/')
    );

    let mut messages = Vec::new();
    if !system_prompt.is_empty() {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: system_prompt.to_string(),
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

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .http1_only()
        .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Failed to build LLM HTTP client: {}", reqwest_error_details(&error, &url)))?;
    let response = client
        .post(&url)
        .header(
            "Authorization",
            format!("Bearer {}", config.api_key),
        )
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .map_err(|error| format!("LLM request failed: {}", reqwest_error_details(&error, &url)))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, body));
    }

    let chat_response: ChatResponse = response
        .json()
        .map_err(|error| format!("Failed to parse LLM response: {}", reqwest_error_details(&error, &url)))?;

    chat_response
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "No response from LLM".to_string())
}
