import assert from "node:assert/strict";
import { contactFormHandler } from "../src/contact-form.js";

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
    getSecret: async (key) => ({
      RECAPTCHA_SECRET_KEY: "test-recaptcha-secret",
      WEB3FORMS_ACCESS_KEY: "test-access-key",
    })[key],
    getConfig: () => "dev.nishikagupta.com",
    fetch: async (req) => {
      calls.push(req);
      return calls.length === 1
        ? json({ success: true, hostname: "dev.nishikagupta.com" })
        : json({ success: true });
    },
    ...overrides,
  };
}

describe("Contact form", function () {
  let originalError;
  let originalWarn;
  let logs;

  beforeEach(function () {
    originalError = console.error;
    originalWarn = console.warn;
    logs = [];
    console.error = (...args) => logs.push(args.join(" "));
    console.warn = (...args) => logs.push(args.join(" "));
  });

  afterEach(function () {
    console.error = originalError;
    console.warn = originalWarn;
  });

  it("verifies reCAPTCHA before forwarding only contact fields with the server access key", async function () {
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
    assert.equal(deps.calls[1].url, "https://api.web3forms.com/submit");
    assert.equal(deps.calls[1].method, "POST");
    assert.equal(deps.calls[1].redirect, "error");
    assert.deepEqual(await deps.calls[1].json(), {
      firstName: "Asha",
      lastName: "Gupta",
      email: "asha@example.com",
      comment: "Please contact me.",
      access_key: "test-access-key",
    });
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

  it("trims contact fields and accepts configured comma-separated hostnames", async function () {
    const deps = dependencies({ getConfig: () => "example.com, dev.nishikagupta.com " });
    const result = await contactFormHandler(request({ ...validFields, firstName: " Asha " }), deps);
    assert.equal(result.status, 200);
    assert.equal((await deps.calls[1].json()).firstName, "Asha");
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
    { getSecret: async () => { throw new Error("secret failure"); } },
    { getSecret: async () => "" },
    { getConfig: () => null },
    { getConfig: () => " , " },
    { getConfig: () => { throw new Error("config failure"); } },
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

  for (const [upstream, status] of [
    [async () => json({ success: false }), 502],
    [async () => json({ success: "true" }), 502],
    [async () => json({ access_key: "test-access-key" }, 400), 502],
    [async () => json({}, 500), 502],
    [async () => json({}, 429), 429],
    [async () => new Response("not JSON"), 502],
    [async () => { throw new Error("network failure: test-access-key"); }, 502],
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
      assert.doesNotMatch(await response.text(), /test-access-key|test-recaptcha-secret|asha@example/);
      assert.ok(logs.length);
      assert.doesNotMatch(logs.join(" "), /test-access-key|test-recaptcha-secret|asha@example|test-token/);
    });
  }
});
