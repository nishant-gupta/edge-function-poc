const MAX_BODY_BYTES = 16 * 1024;
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

async function readBody(req) {
  const reader = req.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("Form body exceeds limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function contactFormHandler(req, { getSecret, getConfig, fetch: send = fetch }) {
  if (req.method !== "POST") {
    return jsonResponse(405, false, "Use POST to submit the contact form.", { Allow: "POST" });
  }

  const contentType = req.headers.get("Content-Type") || "";
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!["application/json", "application/x-www-form-urlencoded", "multipart/form-data"].includes(mediaType)) {
    return jsonResponse(415, false, "Use JSON, URL-encoded, or multipart form data.");
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
        console.warn("Contact form rejected: duplicate form fields");
        return jsonResponse(400, false, "Duplicate form fields are not allowed.");
      }
    }
  } catch (error) {
    console.warn("Contact form rejected: invalid or oversized request body");
    return error instanceof RangeError
      ? jsonResponse(413, false, "Form body must not exceed 16 KiB.")
      : jsonResponse(400, false, "Invalid form body.");
  }

  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return jsonResponse(400, false, "Expected a form object.");
  }

  const payload = {};
  for (const [name, limit] of Object.entries(FIELD_LIMITS)) {
    if (typeof fields[name] !== "string" || !fields[name].trim() || fields[name].length > limit) {
      return jsonResponse(400, false, `${name} is required and must not exceed ${limit} characters.`);
    }
    payload[name] = fields[name].trim();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    return jsonResponse(400, false, "Enter a valid email address.");
  }
  const token = fields["g-recaptcha-response"];
  if (typeof token !== "string" || !token.trim() || token.length > 4096) {
    return jsonResponse(400, false, "A reCAPTCHA response token is required.");
  }

  let recaptchaSecret;
  let accessKey;
  let allowedHostnames;
  try {
    [recaptchaSecret, accessKey] = await Promise.all([
      getSecret("RECAPTCHA_SECRET_KEY"),
      getSecret("WEB3FORMS_ACCESS_KEY"),
    ]);
    const hostnames = getConfig("RECAPTCHA_ALLOWED_HOSTNAMES");
    allowedHostnames = typeof hostnames === "string"
      ? hostnames.split(",").map((hostname) => hostname.trim()).filter(Boolean)
      : [];
    if (typeof recaptchaSecret !== "string" || !recaptchaSecret.trim()
      || typeof accessKey !== "string" || !accessKey.trim() || !allowedHostnames.length) {
      throw new Error("Missing contact form configuration");
    }
  } catch {
    console.error("Contact form configuration unavailable");
    return jsonResponse(503, false, "Contact form is not configured. Please try again later.");
  }

  let verification;
  try {
    const result = await send(new Request("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: recaptchaSecret, response: token.trim() }).toString(),
      redirect: "error",
    }));
    if (!result.ok) {
      console.error(`reCAPTCHA verification HTTP failure: ${result.status}`);
      return jsonResponse(502, false, "Unable to verify reCAPTCHA. Please try again.");
    }
    verification = await result.json();
    if (!verification || typeof verification.success !== "boolean") {
      throw new Error("Invalid verification response");
    }
  } catch {
    console.error("reCAPTCHA verification request or response failed");
    return jsonResponse(502, false, "Unable to verify reCAPTCHA. Please try again.");
  }

  if (verification.success !== true || !allowedHostnames.includes(verification.hostname)) {
    const errors = verification["error-codes"];
    if (Array.isArray(errors) && errors.some((code) => ["missing-input-secret", "invalid-input-secret"].includes(code))) {
      console.error("reCAPTCHA secret configuration rejected");
      return jsonResponse(503, false, "Contact form is not configured. Please try again later.");
    }
    console.warn("Contact form rejected: reCAPTCHA failed or hostname was not allowed");
    return jsonResponse(403, false, "reCAPTCHA validation failed. Complete a new challenge and try again.");
  }

  try {
    const result = await send(new Request("https://api.web3forms.com/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...payload, access_key: accessKey }),
      redirect: "error",
    }));
    if (result.status === 429) {
      console.warn("Web3Forms submission rate limited");
      return jsonResponse(429, false, "Too many submissions. Please try again later.");
    }
    if (!result.ok) {
      console.error(`Web3Forms submission HTTP failure: ${result.status}`);
      return jsonResponse(502, false, "Unable to submit the contact form. Please try again later.");
    }
    const resultBody = await result.json();
    if (resultBody?.success !== true) {
      console.error("Web3Forms did not confirm successful submission");
      return jsonResponse(502, false, "Unable to submit the contact form. Please try again later.");
    }
    return jsonResponse(200, true, "Your message was submitted successfully.");
  } catch {
    console.error("Web3Forms submission request or response failed");
    return jsonResponse(502, false, "Unable to submit the contact form. Please try again later.");
  }
}
