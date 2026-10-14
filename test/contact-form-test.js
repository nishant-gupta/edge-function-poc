import assert from "node:assert/strict";
import { contactBackendOptions } from "../src/lib/contact-http.js";
import { contactFormHandler } from "../src/contact-form.js";
import { CONTACT_FORM_CONFIG } from "../src/contact-form-config.example.js";
import { validateRecaptcha } from "../src/recaptcha.js";
import { parseSlackWebhook, sendToSlack } from "../src/slack.js";

const SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/TEST_TEAM/TEST_CHANNEL/test-webhook-token";
const validFields = {
  firstName: "Asha",
  lastName: "Gupta",
  email: "asha@example.com",
  comment: "Please contact me.",
  "g-recaptcha-response": "test-token",
};

function request(fields = validFields) {
  return new Request("https://dev.nishikagupta.com/api/form/contact-form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function dependencies(overrides = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (req) => {
      calls.push(req);
      return calls.length === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response("ok");
    },
    ...overrides,
    config: overrides.config === null ? null : {
      recaptchaSecretKey: "test-recaptcha-secret",
      slackWebhookUrl: SLACK_WEBHOOK_URL,
      allowedHostnames: ["dev.nishikagupta.com"],
      ...overrides.config,
    },
  };
}

describe("Contact form", function () {
  let originalError;
  let originalWarn;
  let originalLog;
  let logs;

  beforeEach(function () {
    originalError = console.error;
    originalWarn = console.warn;
    originalLog = console.log;
    logs = [];
    console.error = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
    console.log = (...args) => logs.push(args.join(" "));
  });

  afterEach(function () {
    console.error = originalError;
    console.warn = originalWarn;
    console.log = originalLog;
  });

  it("allows reCAPTCHA validation to be used independently of the form handler", async function () {
    const events = [];
    const result = await validateRecaptcha("test-token", {
      secret: "test-recaptcha-secret",
      allowedHostnames: ["dev.nishikagupta.com"],
      fetch: async (req) => {
        assert.equal(req.url, "https://www.google.com/recaptcha/api/siteverify");
        assert.equal(new URLSearchParams(await req.text()).get("response"), "test-token");
        return json({ success: true, hostname: "dev.nishikagupta.com" });
      },
      logEvent: (level, event) => events.push(event),
    });
    assert.deepEqual(result, { success: true });
    assert.deepEqual(events, ["captcha.started", "captcha.response", "captcha.validated"]);
  });

  it("allows Slack messaging to be used independently of the form handler", async function () {
    const events = [];
    const result = await sendToSlack(validFields, {
      webhook: parseSlackWebhook(SLACK_WEBHOOK_URL),
      fetch: async (req) => {
        assert.equal(req.url, SLACK_WEBHOOK_URL);
        const message = await req.json();
        assert.equal(message.blocks[1].fields[0].text, "Name:\nAsha Gupta");
        assert.equal(message.blocks[2].text.text, "Message:\nPlease contact me.");
        assert.ok(!JSON.stringify(message).includes("test-token"));
        return new Response("ok");
      },
      logEvent: (level, event) => events.push(event),
    });
    assert.deepEqual(result, { success: true, status: 200, message: "Your message was submitted successfully." });
    assert.deepEqual(events, ["slack.started", "slack.response", "slack.result"]);
  });

  for (const url of ["https://www.google.com/recaptcha/api/siteverify", SLACK_WEBHOOK_URL]) {
    it("configures contact backends with a ten-second connection timeout and verified TLS", function () {
      const hostname = new URL(url).hostname;
      assert.deepEqual(contactBackendOptions(url), {
        name: `contact-${hostname}`,
        target: hostname,
        hostOverride: hostname,
        useSSL: true,
        sniHostname: hostname,
        certificateHostname: hostname,
        connectTimeout: 10_000,
        firstByteTimeout: 15_000,
        betweenBytesTimeout: 10_000,
      });
      assert.doesNotMatch(JSON.stringify(contactBackendOptions(url)), /test-webhook-token|\/services\//);
    });
  }

  it("verifies reCAPTCHA before posting the contact fields as Slack blocks", async function () {
    const deps = dependencies();
    const response = await contactFormHandler(request({
      ...validFields,
      access_key: "untrusted-key",
      redirect: "https://example.com/",
      webhook: "https://example.com/",
    }), deps);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(response.headers.get("Content-Type"), /application\/json/);
    assert.equal((await response.json()).success, true);
    assert.equal(deps.calls.length, 2);
    assert.equal(deps.calls[0].url, "https://www.google.com/recaptcha/api/siteverify");
    assert.equal(deps.calls[0].method, "POST");
    assert.equal(deps.calls[0].redirect, "error");
    assert.deepEqual(Object.fromEntries(new URLSearchParams(await deps.calls[0].text())), {
      secret: "test-recaptcha-secret",
      response: "test-token",
    });
    assert.equal(deps.calls[1].url, SLACK_WEBHOOK_URL);
    assert.equal(deps.calls[1].method, "POST");
    assert.equal(deps.calls[1].redirect, "error");
    assert.equal(deps.calls[1].headers.get("Content-Type"), "application/json");
    assert.equal(deps.calls[1].headers.get("Accept"), "text/plain");
    assert.deepEqual(await deps.calls[1].json(), {
      text: "New contact form submission",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "New contact form submission" } },
        {
          type: "section",
          fields: [
            { type: "plain_text", text: "Name:\nAsha Gupta" },
            { type: "plain_text", text: "Email:\nasha@example.com" },
          ],
        },
        { type: "section", text: { type: "plain_text", text: "Message:\nPlease contact me." } },
      ],
    });
    const records = logs.map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.event), [
      "request.received", "request.validated", "captcha.started", "captcha.response",
      "captcha.validated", "slack.started", "slack.response", "slack.result",
      "request.completed",
    ]);
    const requestId = response.headers.get("X-Request-ID");
    assert.match(requestId, /^[a-f0-9-]{36}$/);
    assert.ok(records.every((record) => record.requestId === requestId && record.component === "contact-form"));
    assert.deepEqual(records[1].fieldLengths, { firstName: 4, lastName: 5, email: 16, comment: 18 });
    assert.equal(records[4].hostnameMatched, true);
    assert.deepEqual(records[2].timeoutsMs, {
      connectTimeout: 10_000, firstByteTimeout: 15_000, betweenBytesTimeout: 10_000,
    });
    assert.deepEqual(records[5].timeoutsMs, records[2].timeoutsMs);
    assert.equal(records[6].status, 200);
    assert.equal(records.at(-1).status, 200);
    for (const record of records.filter((record) => "durationMs" in record)) {
      assert.ok(record.durationMs >= 0);
    }
    for (const value of [...Object.values(validFields), SLACK_WEBHOOK_URL, "test-webhook-token", "test-recaptcha-secret", "untrusted-key"]) {
      assert.ok(!logs.join("\n").includes(value));
    }
  });

  it("logs correlated input rejection and completion without CAPTCHA or submission", async function () {
    const response = await contactFormHandler(request({ ...validFields, email: "invalid" }), dependencies());
    const records = logs.map((line) => JSON.parse(line));
    assert.deepEqual(records.map((record) => record.event), [
      "request.received", "request.rejected", "request.completed",
    ]);
    assert.equal(records[1].reason, "invalid_email");
    assert.equal(records[2].status, 400);
    assert.equal(records[2].requestId, response.headers.get("X-Request-ID"));
  });

  it("logs known CAPTCHA error codes without unknown provider data", async function () {
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => json({ success: false, hostname: "test-token", "error-codes": [
        "timeout-or-duplicate", "test-recaptcha-secret",
      ] }),
    }));
    assert.equal(response.status, 403);
    const records = logs.map((line) => JSON.parse(line));
    const validation = records.find((record) => record.event === "captcha.validated");
    assert.deepEqual(validation.errorCodes, ["timeout-or-duplicate", "unknown"]);
    assert.equal(validation.hostnameMatched, false);
    assert.ok(!records.some((record) => record.event === "slack.started"));
    assert.doesNotMatch(logs.join("\n"), /test-token|test-recaptcha-secret/);
  });

  it("logs the Slack HTTP status and recognized plain-text error code", async function () {
    let calls = 0;
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => ++calls === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response("action_prohibited", { status: 403 }),
    }));
    assert.equal(response.status, 502);
    const records = logs.map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.event === "slack.response").status, 403);
    const result = records.find((record) => record.event === "slack.result");
    assert.equal(result.providerCode, "action_prohibited");
    assert.equal(result.providerSuccess, false);
    assert.doesNotMatch(await response.text(), /action_prohibited|test-webhook-token/);
  });

  it("does not log arbitrary Slack response text containing credentials or contact data", async function () {
    let calls = 0;
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => ++calls === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response(`${SLACK_WEBHOOK_URL} test-recaptcha-secret ${JSON.stringify(validFields)}`, { status: 403 }),
    }));
    assert.equal(response.status, 502);
    const result = logs.map((line) => JSON.parse(line)).find((record) => record.event === "slack.result");
    assert.equal(result.providerCode, "unrecognized_response");
    for (const value of [...Object.values(validFields), SLACK_WEBHOOK_URL, "test-webhook-token", "test-recaptcha-secret"]) {
      assert.ok(!logs.join("\n").includes(value));
    }
  });

  it("reports HTML provider failures without logging raw response bodies", async function () {
    let calls = 0;
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => ++calls === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response("<html>test-webhook-token asha@example.com</html>", { status: 403 }),
    }));
    assert.equal(response.status, 502);
    const records = logs.map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.event === "slack.result").providerCode, "unrecognized_response");
    assert.doesNotMatch(logs.join("\n"), /test-webhook-token|asha@example/);
  });

  it("bounds provider response logging and preserves upstream HTTP failure status", async function () {
    let calls = 0;
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => ++calls === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response("x".repeat(20 * 1024), { status: 403 }),
    }));
    assert.equal(response.status, 502);
    const records = logs.map((line) => JSON.parse(line));
    assert.equal(records.find((record) => record.event === "slack.invalid_response_body").errorType, "RangeError");
    assert.equal(records.find((record) => record.event === "slack.http_failure").status, 403);
    assert.ok(logs.join("\n").length < 5000);
  });

  it("splits maximum-length comments into Slack sections without losing text", async function () {
    const comment = "x".repeat(5000);
    const deps = dependencies();
    assert.equal((await contactFormHandler(request({ ...validFields, comment }), deps)).status, 200);
    const message = await deps.calls[1].json();
    const sections = message.blocks.slice(2);
    assert.equal(sections.length, 2);
    assert.ok(message.blocks[0].text.text.length <= 150);
    assert.ok(message.blocks[1].fields.every((field) => field.text.length <= 2000));
    assert.ok(sections.every((section) => section.text.text.length <= 3000));
    assert.equal(sections.map((section) => section.text.text.split("\n").slice(1).join("\n")).join(""), comment);
  });

  it("preserves emoji at Slack section boundaries", async function () {
    const comment = `${"x".repeat(2899)}\u{1f600}${"y".repeat(2099)}`;
    const deps = dependencies();
    assert.equal(comment.length, 5000);
    assert.equal((await contactFormHandler(request({ ...validFields, comment }), deps)).status, 200);
    const sections = (await deps.calls[1].json()).blocks.slice(2);
    assert.ok(sections.every((section) => section.text.text.length <= 3000));
    const chunks = sections.map((section) => section.text.text.split("\n").slice(1).join("\n"));
    assert.ok(!/[\uD800-\uDBFF]$/.test(chunks[0]));
    assert.equal(chunks.join(""), comment);
  });

  it("renders submitted markup and mentions as plain text", async function () {
    const deps = dependencies();
    const comment = "<!channel> <@U123> *bold* & <https://example.com|click>";
    const firstName = "<!here>";
    assert.equal((await contactFormHandler(request({ ...validFields, firstName, comment }), deps)).status, 200);
    const message = await deps.calls[1].json();
    assert.equal(message.blocks[1].fields[0].type, "plain_text");
    assert.equal(message.blocks[1].fields[0].text, `Name:\n${firstName} Gupta`);
    assert.equal(message.blocks[2].text.type, "plain_text");
    assert.equal(message.blocks[2].text.text, `Message:\n${comment}`);
    assert.equal(message.text, "New contact form submission");
  });

  it("accepts Slack's plain-text acknowledgement with surrounding whitespace", async function () {
    let calls = 0;
    const deps = dependencies({
      fetch: async () => ++calls === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : new Response("ok\n"),
    });
    assert.equal((await contactFormHandler(request(), deps)).status, 200);
  });

  it("supports Slack Gov incoming webhooks without logging the credential path", async function () {
    const url = SLACK_WEBHOOK_URL.replace("hooks.slack.com", "hooks.slack-gov.com");
    const deps = dependencies({ config: { slackWebhookUrl: url } });
    assert.equal((await contactFormHandler(request(), deps)).status, 200);
    assert.equal(deps.calls[1].url, url);
    const started = logs.map((line) => JSON.parse(line)).find((record) => record.event === "slack.started");
    assert.equal(started.endpoint, "https://hooks.slack-gov.com/services/[REDACTED]");
    assert.ok(!logs.join("\n").includes(url));
  });

  for (const encoding of ["urlencoded", "multipart"]) {
    it(`accepts ${encoding} browser form data`, async function () {
      const form = encoding === "multipart" ? new FormData() : new URLSearchParams();
      for (const [key, value] of Object.entries(validFields)) form.append(key, value);
      const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", {
        method: "POST",
        body: form,
      });
      assert.equal((await contactFormHandler(req, dependencies())).status, 200);
    });

    it(`rejects duplicate ${encoding} fields without contacting either service`, async function () {
      const form = encoding === "multipart" ? new FormData() : new URLSearchParams();
      for (const [key, value] of Object.entries(validFields)) form.append(key, value);
      form.append("email", "other@example.com");
      const deps = dependencies();
      const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", {
        method: "POST",
        body: form,
      });
      assert.equal((await contactFormHandler(req, deps)).status, 400);
      assert.equal(deps.calls.length, 0);
    });
  }

  it("trims contact fields and accepts configured hostnames", async function () {
    const deps = dependencies({ config: { allowedHostnames: ["example.com", " dev.nishikagupta.com "] } });
    const result = await contactFormHandler(request({ ...validFields, firstName: " Asha " }), deps);
    assert.equal(result.status, 200);
    assert.equal((await deps.calls[1].json()).blocks[1].fields[0].text, "Name:\nAsha Gupta");
  });

  it("fails closed with the blank example constants", async function () {
    const deps = dependencies({ config: CONTACT_FORM_CONFIG });
    assert.equal((await contactFormHandler(request(), deps)).status, 503);
    assert.equal(deps.calls.length, 0);
  });

  it("fails closed when no configuration is supplied", async function () {
    assert.equal((await contactFormHandler(request())).status, 503);
  });

  for (const method of ["GET", "PUT", "OPTIONS", "DELETE"]) {
    it(`rejects ${method} with Allow: POST`, async function () {
      const deps = dependencies();
      const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", { method });
      const response = await contactFormHandler(req, deps);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "POST");
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(deps.calls.length, 0);
    });
  }

  it("rejects unsupported content types", async function () {
    const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", {
      method: "POST", body: "text",
    });
    assert.equal((await contactFormHandler(req, dependencies())).status, 415);
  });

  for (const body of ["{", "null", "[]", '"text"']) {
    it(`rejects malformed or non-object JSON: ${body}`, async function () {
      const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      const deps = dependencies();
      assert.equal((await contactFormHandler(req, deps)).status, 400);
      assert.equal(deps.calls.length, 0);
    });
  }

  for (const [field, value] of [
    ["firstName", ""], ["lastName", " "], ["email", "bad-email"],
    ["comment", null], ["firstName", 42], ["comment", "x".repeat(5001)],
    ["email", "x".repeat(255)], ["firstName", "x".repeat(101)],
    ["lastName", "x".repeat(101)], ["g-recaptcha-response", ""],
    ["g-recaptcha-response", "x".repeat(4097)],
  ]) {
    it(`rejects invalid ${field} without external requests (${String(value).length} characters)`, async function () {
      const deps = dependencies();
      const response = await contactFormHandler(request({ ...validFields, [field]: value }), deps);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).success, false);
      assert.equal(deps.calls.length, 0);
    });
  }

  it("enforces the body byte limit even without Content-Length", async function () {
    const deps = dependencies();
    const response = await contactFormHandler(request({
      ...validFields, ignored: "\u00e9".repeat(8192),
    }), deps);
    assert.equal(response.status, 413);
    assert.equal(deps.calls.length, 0);
  });

  it("accepts a request exactly at the body byte limit", async function () {
    const fields = { ...validFields, ignored: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(fields)).byteLength;
    fields.ignored = "x".repeat(16 * 1024 - overhead);
    assert.equal((await contactFormHandler(request(fields), dependencies())).status, 200);
  });

  it("rejects a file in place of a text contact field", async function () {
    const form = new FormData();
    for (const [key, value] of Object.entries(validFields)) form.append(key, value);
    form.set("comment", new Blob(["file"]), "comment.txt");
    const req = new Request("https://dev.nishikagupta.com/api/form/contact-form", {
      method: "POST", body: form,
    });
    assert.equal((await contactFormHandler(req, dependencies())).status, 400);
  });

  for (const overrides of [
    { config: null },
    { config: { recaptchaSecretKey: "" } },
    { config: { slackWebhookUrl: "" } },
    { config: { slackWebhookUrl: "not-a-url" } },
    { config: { slackWebhookUrl: SLACK_WEBHOOK_URL.replace("https:", "http:") } },
    { config: { slackWebhookUrl: SLACK_WEBHOOK_URL.replace("hooks.slack.com", "attacker.example") } },
    { config: { slackWebhookUrl: SLACK_WEBHOOK_URL.replace("hooks.slack.com", "hooks.slack.com.attacker.example") } },
    { config: { slackWebhookUrl: SLACK_WEBHOOK_URL.replace("https://", "https://user:password@") } },
    { config: { slackWebhookUrl: `${SLACK_WEBHOOK_URL}?token=secret` } },
    { config: { slackWebhookUrl: `${SLACK_WEBHOOK_URL}#fragment` } },
    { config: { slackWebhookUrl: "https://hooks.slack.com/invalid/path" } },
    { config: { allowedHostnames: null } },
    { config: { allowedHostnames: [] } },
    { config: { allowedHostnames: [" "] } },
    { config: { allowedHostnames: [42] } },
  ]) {
    it("fails closed when contact form configuration is unavailable", async function () {
      const deps = dependencies(overrides);
      const response = await contactFormHandler(request(), deps);
      assert.equal(response.status, 503);
      assert.equal(deps.calls.length, 0);
      assert.ok(logs.length);
    });
  }

  for (const [verification, status] of [
    [{ success: false, "error-codes": ["timeout-or-duplicate"] }, 403],
    [{ success: true, hostname: "attacker.example" }, 403],
    [{ success: true }, 403],
    [{ success: false, "error-codes": ["invalid-input-secret"] }, 503],
    [{ success: false, "error-codes": ["missing-input-secret"] }, 503],
    [{ success: "true", hostname: "dev.nishikagupta.com" }, 502],
    [null, 502],
  ]) {
    it(`does not submit after rejected or malformed verification: ${JSON.stringify(verification)}`, async function () {
      const calls = [];
      const deps = dependencies({
        fetch: async (req) => { calls.push(req); return json(verification); },
      });
      const response = await contactFormHandler(request(), deps);
      assert.equal(response.status, status);
      assert.equal(calls.length, 1);
      assert.ok(logs.length);
    });
  }

  for (const failure of [
    async () => { throw new Error("network failure"); },
    async () => json({}, 503),
    async () => new Response("not JSON"),
  ]) {
    it("reports verification service failures without submitting", async function () {
      let calls = 0;
      const deps = dependencies({ fetch: async () => { calls++; return failure(); } });
      assert.equal((await contactFormHandler(request(), deps)).status, 502);
      assert.equal(calls, 1);
      assert.ok(logs.length);
    });
  }

  for (const [message, reason] of [
    ["HTTP response timeout", "timeout"],
    ["DNS resolution failed", "dns"],
    ["TLS certificate validation failed", "tls"],
    ["Redirect is not allowed", "redirect"],
    ["Could not find a backend named google", "backend_unavailable"],
    ["Connection reset by peer", "connection"],
    ["Network request failed", "network"],
    ["Unspecified upstream failure", "unknown"],
  ]) {
    it(`categorizes CAPTCHA request failures as ${reason} without logging exception contents`, async function () {
      let calls = 0;
      const response = await contactFormHandler(request(), dependencies({
        fetch: async () => {
          calls++;
          throw new Error(`${message}: test-recaptcha-secret test-token asha@example.com`);
        },
      }));
      assert.equal(response.status, 502);
      assert.equal(calls, 1);
      const failure = logs.map((line) => JSON.parse(line)).find((record) => record.event === "captcha.failed");
      assert.equal(failure.failureStage, "request");
      assert.equal(failure.failureReason, reason);
      assert.doesNotMatch(logs.join("\n"), /test-recaptcha-secret|test-token|asha@example/);
    });
  }

  it("distinguishes CAPTCHA response parsing from request failures", async function () {
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => new Response("not-json"),
    }));
    assert.equal(response.status, 502);
    const failure = logs.map((line) => JSON.parse(line)).find((record) => record.event === "captcha.failed");
    assert.equal(failure.failureStage, "response_body");
    assert.equal(failure.failureReason, "invalid_response");
  });

  it("identifies invalid CAPTCHA response shape separately from network failures", async function () {
    const response = await contactFormHandler(request(), dependencies({
      fetch: async () => json({ unexpected: true }),
    }));
    assert.equal(response.status, 502);
    const failure = logs.map((line) => JSON.parse(line)).find((record) => record.event === "captcha.failed");
    assert.equal(failure.failureStage, "response_validation");
    assert.equal(failure.failureReason, "invalid_response");
  });

  for (const [upstream, status] of [
    [async () => json({ success: true }), 502],
    [async () => new Response(""), 502],
    [async () => new Response("OK"), 502],
    [async () => new Response("invalid_payload", { status: 400 }), 502],
    [async () => new Response("no_service", { status: 404 }), 502],
    [async () => new Response("ok", { status: 403 }), 502],
    [async () => new Response("rollup_error", { status: 500 }), 502],
    [async () => new Response("rate_limited", { status: 429 }), 429],
    [async () => { throw new Error(`network failure: ${SLACK_WEBHOOK_URL}`); }, 502],
  ]) {
    it(`reports submission failures with ${status} without leaking secrets or retrying`, async function () {
      let calls = 0;
      const deps = dependencies({
        fetch: async () => ++calls === 1
          ? json({ success: true, hostname: "dev.nishikagupta.com" })
          : upstream(),
      });
      const response = await contactFormHandler(request(), deps);
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(calls, 2);
      assert.doesNotMatch(await response.text(), /test-webhook-token|test-recaptcha-secret|asha@example/);
      assert.ok(logs.length);
      assert.doesNotMatch(logs.join(" "), /test-webhook-token|test-recaptcha-secret|asha@example|test-token/);
    });
  }
});
