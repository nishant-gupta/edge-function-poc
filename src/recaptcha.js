import { CONTACT_BACKEND_TIMEOUTS, errorType, failureReason } from "./lib/contact-http.js";

const RECAPTCHA_ERROR_CODES = [
  "missing-input-secret", "invalid-input-secret", "missing-input-response",
  "invalid-input-response", "bad-request", "timeout-or-duplicate",
];

export async function validateRecaptcha(token, { secret, allowedHostnames, fetch: send = fetch, logEvent }) {
  let verification;
  let captchaStage = "request";
  const startedAt = Date.now();
  logEvent("log", "captcha.started", {
    method: "POST", endpoint: "https://www.google.com/recaptcha/api/siteverify",
    timeoutsMs: CONTACT_BACKEND_TIMEOUTS,
  });
  try {
    const result = await send(new Request("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token.trim() }).toString(),
      redirect: "error",
    }));
    logEvent("log", "captcha.response", { status: result.status, durationMs: Date.now() - startedAt });
    if (!result.ok) {
      logEvent("error", "captcha.http_failure", { status: result.status });
      return { success: false, status: 502, message: "Unable to verify reCAPTCHA. Please try again." };
    }
    captchaStage = "response_body";
    verification = await result.json();
    captchaStage = "response_validation";
    if (!verification || typeof verification.success !== "boolean") {
      throw new Error("Invalid verification response");
    }
  } catch (error) {
    logEvent("error", "captcha.failed", {
      errorType: errorType(error),
      failureStage: captchaStage,
      failureReason: captchaStage === "response_validation" ? "invalid_response" : failureReason(error),
      durationMs: Date.now() - startedAt,
    });
    return { success: false, status: 502, message: "Unable to verify reCAPTCHA. Please try again." };
  }

  const hostnameMatched = allowedHostnames.some((hostname) => hostname.trim() === verification.hostname);
  logEvent("log", "captcha.validated", {
    success: verification.success,
    hostnameMatched,
    errorCodes: Array.isArray(verification["error-codes"])
      ? verification["error-codes"].slice(0, 8).map((code) => RECAPTCHA_ERROR_CODES.includes(code) ? code : "unknown")
      : [],
    durationMs: Date.now() - startedAt,
  });
  if (verification.success !== true || !hostnameMatched) {
    const errors = verification["error-codes"];
    if (Array.isArray(errors) && errors.some((code) => ["missing-input-secret", "invalid-input-secret"].includes(code))) {
      logEvent("error", "captcha.configuration_rejected");
      return { success: false, status: 503, message: "Contact form is not configured. Please try again later." };
    }
    logEvent("warn", "captcha.rejected");
    return { success: false, status: 403, message: "reCAPTCHA validation failed. Complete a new challenge and try again." };
  }

  return { success: true };
}
