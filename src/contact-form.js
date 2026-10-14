import { errorType, readBody } from "./lib/contact-http.js";
import { validateRecaptcha } from "./recaptcha.js";
import { parseSlackWebhook, sendToSlack } from "./slack.js";

const FIELD_LIMITS = { firstName: 100, lastName: 100, email: 254, comment: 5000 };

function jsonResponse(status, success, message, headers = {}) {
  return new Response(JSON.stringify({ success, message }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export async function contactFormHandler(req, { config, fetch: send = fetch } = {}) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const logEvent = (level, event, details = {}) => console[level](JSON.stringify({
    component: "contact-form", requestId, event, ...details,
  }));
  const respond = (...args) => {
    const response = jsonResponse(...args);
    response.headers.set("X-Request-ID", requestId);
    logEvent("log", "request.completed", { status: response.status, durationMs: Date.now() - startedAt });
    return response;
  };
  logEvent("log", "request.received", { method: req.method, path: "/api/form/contact-form" });
  if (req.method !== "POST") {
    return respond(405, false, "Use POST to submit the contact form.", { Allow: "POST" });
  }

  const contentType = req.headers.get("Content-Type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!["application/json", "application/x-www-form-urlencoded", "multipart/form-data"].includes(mediaType)) {
    logEvent("warn", "request.rejected", { reason: "unsupported_content_type" });
    return respond(415, false, "Use JSON, URL-encoded, or multipart form data.");
  }

  let fields;
  try {
    const text = await readBody(req);
    if (mediaType === "application/json") {
      fields = JSON.parse(text);
    } else {
      const form = mediaType === "application/x-www-form-urlencoded"
        ? new URLSearchParams(text)
        : await new Response(text, { headers: { "Content-Type": contentType } }).formData();
      fields = Object.fromEntries(form);
      if (Array.from(form.keys()).length !== Object.keys(fields).length) {
        logEvent("warn", "request.rejected", { reason: "duplicate_fields" });
        return respond(400, false, "Duplicate form fields are not allowed.");
      }
    }
  } catch (error) {
    logEvent("warn", "request.rejected", {
      reason: error instanceof RangeError ? "body_too_large" : "invalid_body",
      errorType: errorType(error),
    });
    return error instanceof RangeError
      ? respond(413, false, "Form body must not exceed 16 KiB.")
      : respond(400, false, "Invalid form body.");
  }

  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    logEvent("warn", "request.rejected", { reason: "invalid_form_object" });
    return respond(400, false, "Expected a form object.");
  }

  const payload = {};
  for (const [name, limit] of Object.entries(FIELD_LIMITS)) {
    if (typeof fields[name] !== "string" || !fields[name].trim() || fields[name].length > limit) {
      logEvent("warn", "request.rejected", { reason: "invalid_field", field: name, limit });
      return respond(400, false, `${name} is required and must not exceed ${limit} characters.`);
    }
    payload[name] = fields[name].trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    logEvent("warn", "request.rejected", { reason: "invalid_email" });
    return respond(400, false, "Enter a valid email address.");
  }
  const token = fields["g-recaptcha-response"];
  if (typeof token !== "string" || !token.trim() || token.length > 4096) {
    logEvent("warn", "request.rejected", { reason: "invalid_captcha_token" });
    return respond(400, false, "A reCAPTCHA response token is required.");
  }
  logEvent("log", "request.validated", {
    contentType: mediaType,
    fieldLengths: Object.fromEntries(Object.entries(payload).map(([name, value]) => [name, value.length])),
    captchaTokenPresent: true,
  });

  const recaptchaSecret = config?.recaptchaSecretKey;
  const webhook = parseSlackWebhook(config?.slackWebhookUrl);
  const allowedHostnames = config?.allowedHostnames;
  if (typeof recaptchaSecret !== "string" || !recaptchaSecret.trim()
    || !webhook
    || !Array.isArray(allowedHostnames) || !allowedHostnames.length
    || allowedHostnames.some((hostname) => typeof hostname !== "string" || !hostname.trim())) {
    logEvent("error", "configuration.unavailable", {
      recaptchaKeyPresent: typeof recaptchaSecret === "string" && !!recaptchaSecret.trim(),
      slackWebhookConfigured: !!webhook,
      hostnameCount: Array.isArray(allowedHostnames) ? allowedHostnames.length : 0,
    });
    return respond(503, false, "Contact form is not configured. Please try again later.");
  }

  const verification = await validateRecaptcha(token, {
    secret: recaptchaSecret, allowedHostnames, fetch: send, logEvent,
  });
  if (!verification.success) {
    return respond(verification.status, false, verification.message);
  }

  const submission = await sendToSlack(payload, { webhook, fetch: send, logEvent });
  return respond(submission.status, submission.success, submission.message);
}
