import { CONTACT_BACKEND_TIMEOUTS, errorType, failureReason, readBody } from "./lib/contact-http.js";

const SLACK_RESPONSE_CODES = [
  "ok", "invalid_payload", "invalid_blocks", "no_text", "invalid_token", "token_revoked",
  "no_active_hooks", "no_service", "no_service_id", "no_team", "no_team_id",
  "channel_not_found", "channel_is_archived", "action_prohibited",
  "posting_to_general_channel_denied", "too_many_attachments", "user_not_found",
  "team_disabled", "rollup_error", "rate_limited",
];

export function parseSlackWebhook(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:"
      && ["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      return url;
    }
  } catch {
    return null;
  }
  return null;
}

function slackMessage({ firstName, lastName, email, comment }) {
  const sections = [];
  let chunk = "";
  for (const character of comment) {
    if (chunk.length + character.length > 2900) {
      sections.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) sections.push(chunk);
  return {
    text: "New contact form submission",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "New contact form submission" } },
      {
        type: "section",
        fields: [
          { type: "plain_text", text: `Name:\n${firstName} ${lastName}` },
          { type: "plain_text", text: `Email:\n${email}` },
        ],
      },
      ...sections.map((text, index) => ({
        type: "section",
        text: {
          type: "plain_text",
          text: `${index === 0 ? "Message" : "Message (continued)"}:\n${text}`,
        },
      })),
    ],
  };
}

export async function sendToSlack(payload, { webhook, fetch: send = fetch, logEvent }) {
  const startedAt = Date.now();
  logEvent("log", "slack.started", {
    method: "POST", endpoint: `${webhook.origin}/services/[REDACTED]`,
    contentType: "application/json", fields: ["text", "blocks"],
    webhookConfigured: true,
    timeoutsMs: CONTACT_BACKEND_TIMEOUTS,
  });
  try {
    const result = await send(new Request(webhook.href, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/plain" },
      body: JSON.stringify(slackMessage(payload)),
      redirect: "error",
    }));
    logEvent("log", "slack.response", {
      status: result.status, durationMs: Date.now() - startedAt,
    });
    let resultText;
    try {
      resultText = (await readBody(result)).trim();
    } catch (error) {
      logEvent("warn", "slack.invalid_response_body", {
        errorType: errorType(error), failureStage: "response_body", failureReason: failureReason(error),
      });
    }
    logEvent("log", "slack.result", {
      providerSuccess: result.ok && resultText === "ok",
      providerCode: SLACK_RESPONSE_CODES.includes(resultText) ? resultText : "unrecognized_response",
      durationMs: Date.now() - startedAt,
    });
    if (result.status === 429) {
      logEvent("warn", "slack.rate_limited");
      return { success: false, status: 429, message: "Too many submissions. Please try again later." };
    }
    if (!result.ok) {
      logEvent("error", "slack.http_failure", { status: result.status });
      return { success: false, status: 502, message: "Unable to submit the contact form. Please try again later." };
    }
    if (resultText !== "ok") {
      logEvent("error", "slack.submission_rejected");
      return { success: false, status: 502, message: "Unable to submit the contact form. Please try again later." };
    }
    return { success: true, status: 200, message: "Your message was submitted successfully." };
  } catch (error) {
    logEvent("error", "slack.failed", {
      errorType: errorType(error), failureStage: "request", failureReason: failureReason(error),
      durationMs: Date.now() - startedAt,
    });
    return { success: false, status: 502, message: "Unable to submit the contact form. Please try again later." };
  }
}
