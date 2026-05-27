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

    let client = reqwest::blocking::Client::new();
    let response = client
        .post(&url)
        .header(
            "Authorization",
            format!("Bearer {}", config.api_key),
        )
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .map_err(|e| format!("LLM request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("LLM API error ({}): {}", status, body));
    }

    let chat_response: ChatResponse = response
        .json()
        .map_err(|e| format!("Failed to parse LLM response: {e}"))?;

    chat_response
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "No response from LLM".to_string())
}
