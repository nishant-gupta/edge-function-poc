# aem-edge-functions-boilerplate

## Introduction

This boilerplate serves as an example of what is possible to achieve with AEM Edge Functions. The repository contains a simple server that exposes multiple endpoints and makes usage of:

- Edge Functions service provisioning
- Configurations usage (ConfigStore)
- Secrets usage (SecretStore)
- KV store usage (KVStore)
- Logging
- Log Tailing

Functions source code can be found under `./src`, tests can be found under `./test` and are executable through `mocha`.
The service configuration is defined in `config/edgeFunctions.yaml` and CDN routing in `config/cdn.yaml`.

## Setup

### Adobe CLI

First install Adobe CLI (aio) with the following command

```
npm install -g @adobe/aio-cli
```

Next install the aio-cli AEM Edge Functions plugin

```
aio plugins:install @adobe/aio-cli-plugin-aem-edge-functions
```

Finally run the following commands to finish setting up the aio AEM Edge Functions plugin.

```
aio login
aio aem edge-functions setup
```

This command will ask you to login and then to select your environment on which you want to use AEM Edge Functions.

Note: You will need to have the **AEM Administrator Product Profile** in order to be able to deploy code to your edge functions

### Boilerplate

Run the following command from the boilerplate project to setup your machine

```
npm install
```

## Create your edge functions

The first step to create your edge functions is to ensure that you have setup a configuration pipeline for your environment in Cloud Manager. If it is not the case, please follow this [documentation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/operations/config-pipeline) to create your configuration pipeline.

In case you are using a RDE, you can deploy your configuration using the command `aio aem:rde:install -t env-config ./config`.

Edge Functions creation is done via configuration file, you will need to create a YAML file (eg. edgeFunctions.yaml) with the following configuration:

```
kind: "EdgeFunctions"
version: "1"
data:
  functions:
    - name: my-edge-function
  # Uncomment to enable secrets
  # secrets:
  #   - key: API_TOKEN
  #     value: ${{ API_TOKEN_SECRET }}
  # Uncomment to enable a KV store
  # kvs: true
```

The configuration is composed of:

- **functions**: contains a list of edge functions, where a function is composed of a **name** and a set of **origins**. The function name must be at most **30 characters** long, start with a lowercase letter, end with a lowercase letter or digit, and contain only lowercase letters, digits, and hyphens. The default limit is 1 function for AEM as a Cloud Service environments and 3 for Edge Delivery Services sites.
- **configs**: contains a key/value configs arrays that will be exposed to all your edge functions
- **secrets**: contains a key/value secrets arrays that will be exposed to all your edge functions
- **kvs**: when set to `true`, provisions an empty KV store named `kv_default` that all your edge functions can read from and write to at runtime

Additionally, you will need to define routing rules in your CDN configuration file (eg. cdn.yaml) using CDN origin selectors rules:

```
kind: 'CDN'
version: '1'
data:
  requestTransformations:
    rules:
      # The /weather response depends on the caller's IP-based geolocation. Fold the
      # client IP into the cache key (as an `ip` query parameter) so the response can be
      # cached per client instead of opting out of caching with skipCache.
      - name: add-client-ip-to-weather
        when: { reqProperty: path, equals: "/weather" }
        actions:
          - type: set
            queryParam: ip
            value: { reqProperty: clientIp }
  originSelectors:
    rules:
      - name: route-weather-to-edge-function
        when: { reqProperty: path, equals: "/weather" }
        action:
          type: selectAemOrigin
          originName: edgefunction-my-edge-function
      - name: route-hello-world-to-edge-function
        when: { reqProperty: path, equals: "/hello-world" }
        action:
          type: selectAemOrigin
          originName: edgefunction-my-edge-function
```

> **Caching:** These routes intentionally do **not** set `skipCache: true`. `skipCache` forces every request through uncached traversal, so for cases like these it is usually better to keep caching enabled and vary the cache key when a response depends on the request. `/hello-world` is static and cached directly; `/weather` is made cacheable by keying the CDN cache on the client IP (the request transformation above) so each client is served a cached response for the duration of its `Cache-Control: max-age`. See [Caching](#caching).

**Note**: If you already have a CDN configuration file, just add the origin selectors rules to your existing configuration

The origin selector rule enables you to route your traffic to your edge functions under your own conditions (such as routing a specific domain or only under a certain path). See [official documentation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-configuring-traffic#origin-selectors) to learn more about Origin Selector.

Once you have created your configuration, you will need to commit your changes to your Git Repository and trigger the configuration pipeline. Once the configuration pipeline succeeds, you should be able to access your edge function endpoints:

- *publish-pXXXXX-eYYYYY.adobeaemcloud.com/weather* or *example.com/weather*
- *publish-pXXXXX-eYYYYY.adobeaemcloud.com/hello-world* or *example.com/hello-world*

where **pXXXXX-eYYYYY** is your environment coordinates.

## Build

The following command will package your edge function code for deployment to your edge function service.

```
aio aem edge-functions build
```

## Deploy

The following command will deploy your package to your edge function. You will have to set the argument function-name to the name you gave your function in the edge function configuration file.

```
aio aem edge-functions deploy <function-name>
```

### GitHub Actions deployment

`.github/workflows/deploy-edge-function.yml` deploys `my-edge-function` to the
EDS site `dev.nishikagupta.com` in program `154435`. It runs on pushes to `main`
and can also be started from **Actions > Deploy edge function > Run workflow**.
Manual runs deploy the selected branch; use `main` to deploy merged code.
Deployments to this target are serialized.

Add these repository secrets under **Settings > Secrets and variables >
Actions** before running the workflow:

| Secret | Value |
| --- | --- |
| `AEM_EDGE_FUNCTIONS_ADC_CLIENT_ID` | Adobe Developer Console OAuth server-to-server client ID |
| `AEM_EDGE_FUNCTIONS_ADC_CLIENT_SECRET` | Client secret for that credential |
| `AEM_EDGE_FUNCTIONS_ADC_SCOPES` | Comma-separated OAuth scopes from the credential |
| `RECAPTCHA_SECRET_KEY` | Server-side reCAPTCHA v2 secret for the target site |
| `SLACK_WEBHOOK_URL` | Incoming webhook URL for the contact-form Slack channel |

The Adobe credential must have the required Cloud Manager API access and
deployment permissions for this program's EDS site. The workflow authenticates
non-interactively using the Edge Functions plugin's environment variables; it
does not run `aio login` or copy a developer's `.aio` file. See the
[Adobe plugin's CI/CD documentation](https://github.com/adobe/aio-cli-plugin-aem-edge-functions#cicd-setup).

The workflow uses Node.js 22, locked npm dependencies, Adobe CLI 11.2.0, and Edge
Functions plugin 1.0.5. It runs tests, creates the ignored
`src/contact-form-config.local.js` from secrets, builds the worker, and deploys
the resulting package. The allowed CAPTCHA hostname is the configured EDS site
domain. Missing secrets fail the workflow explicitly.

**PoC security:** Contact credentials are embedded in the compiled worker and
deployment archive. The workflow does not upload these files as GitHub
artifacts and removes the generated configuration, Wasm binary, and archive
after the job, including on failure. Do not enable shell tracing or print the
generated configuration. Existing sandbox runtime store limitations still
apply; GitHub secrets are supplied at build time, not through Fastly stores.

This workflow deploys **function code only**. Register the function and deploy
`config/*.yaml` separately through the Cloud Manager EDS configuration pipeline.
For EDS, `envTypes: [prod]` is the supported configuration scope even when the
site's custom domain is named `dev.nishikagupta.com`.

## Local run

The following command will run your edge function code locally and exposed a server at `http://127.0.0.1:7676`

```
aio aem edge-functions serve
```

You can learn more about what is supported by Local runtime on [Fastly documentation](https://www.fastly.com/documentation/reference/cli/compute/serve/).

## Test

The following command will execute tests using `mocha`.

```
npm run test
```

## Contact form

The implementation is split by responsibility:

- `src/contact-form.js` parses and validates incoming form data, correlates logs,
  and orchestrates verification followed by delivery.
- `src/recaptcha.js` exports `validateRecaptcha` for Google token/hostname
  verification and CAPTCHA-specific diagnostics.
- `src/slack.js` exports `parseSlackWebhook` and `sendToSlack` for webhook
  validation, message formatting, delivery, and Slack-specific diagnostics.
- `src/lib/contact-http.js` holds shared bounded body reading, backend timeout/TLS
  options, and safe error classification.

The provider functions accept an injected `fetch` and `logEvent` callback so the
form handler can share its named Fastly backends and request-scoped logger.
Neither provider module reads the local credentials file directly.

`POST /api/form/contact-form` accepts JSON, URL-encoded forms, and multipart
forms with these required text fields:

| Field | Maximum length |
| --- | --- |
| `firstName` | 100 characters |
| `lastName` | 100 characters |
| `email` | 254 characters; valid email format |
| `comment` | 5000 characters |
| `g-recaptcha-response` | 4096 characters; token from a reCAPTCHA v2 widget |

The complete request body must not exceed 16 KiB. File uploads and duplicate
form fields are not supported. Only the four contact fields are included in the
Slack message. Client-provided webhook URLs, redirects, and other extra fields
are ignored.

The function verifies the token with Google's `siteverify` endpoint and checks
the returned hostname against `CONTACT_FORM_CONFIG.allowedHostnames`. Only after successful
verification does it POST a JSON message to the configured Slack incoming webhook.
`firstName` and `lastName` are combined into Name, `email` becomes Email, and
`comment` becomes Message. User values use `plain_text` blocks rather than
interpreted Slack markup, so form content cannot trigger Slack mentions. Long
comments are split into sections below Slack's 3000-character section limit,
without truncating the message or splitting emoji.
Only a successful HTTP response with the plain-text body `ok` confirms delivery.
The consumed reCAPTCHA token is not forwarded to Slack:
Google tokens expire after two minutes and can only be verified once.

### Configuration and deployment

Create a **reCAPTCHA v2** site key and secret for `dev.nishikagupta.com`. The public
site key belongs in the browser widget; never put the secret in browser code.
For this sandbox PoC, the contact form uses build-time JavaScript constants rather
than Fastly config and secret stores, which sandbox programs cannot provision.
After cloning the repository, create the local configuration file before building:

```bash
cp src/contact-form-config.example.js src/contact-form-config.local.js
```

Do not overwrite an existing populated local file. Edit the constants in
`src/contact-form-config.local.js`:

| Constant property | Value |
| --- | --- |
| `recaptchaSecretKey` | Google reCAPTCHA v2 server-side secret |
| `slackWebhookUrl` | Secret Slack incoming webhook URL |
| `allowedHostnames` | Array of permitted widget hostnames, initially `["dev.nishikagupta.com"]` |

The local file is git-ignored. The tracked example deliberately has a blank
reCAPTCHA secret and webhook URL; the handler returns 503 until both are populated.
Use hostnames without schemes or paths in `allowedHostnames`.
Do not commit real credentials or copy this module into browser code.

Create a Slack app, enable **Incoming Webhooks**, choose **Add New Webhook to
Workspace**, and authorize the intended contact-form channel. Put the generated
URL in `slackWebhookUrl`. Only HTTPS webhooks on `hooks.slack.com` or
`hooks.slack-gov.com` with a `/services/.../.../...` path are accepted; redirects
are not followed. An existing local PoC file only needs the new `slackWebhookUrl`
property; the former `web3formsAccessKey` is no longer used.
See [Slack's incoming webhook guide](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).

**PoC only:** These values are embedded in the compiled worker. Treat the local
file, Wasm binary, and deployment archive as sensitive; do not publish them as
public CI artifacts. The local file must be supplied separately on each build
machine. Changing a constant requires a rebuild and redeployment. For production,
use a non-sandbox program with secret stores, or a backend with secure secrets.

Deploy `config/cdn.yaml` through the site's Cloud Manager EDS pipeline if the
contact-form route has not already been deployed. The PoC contact form no longer
requires Cloud Manager secret mappings or config-store provisioning.
Build and deploy the worker to the same site:

```bash
npm test
npm run build
aio aem edge-functions deploy my-edge-function \
  --package pkg/aem-edge-functions-boilerplate.tar.gz
```

Local serving uses the same constants file; no contact-form store setup is needed.
The existing example request logger still attempts to read `LOG_LEVEL` from a
config store and may print "No config store found, using default log level" on a
sandbox. That warning is independent of contact-form configuration.

### Browser submission

Render the Google reCAPTCHA v2 widget inside your contact form. It supplies
`g-recaptcha-response` to `FormData` after a successful challenge:

```javascript
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const response = await fetch('/api/form/contact-form', {
      method: 'POST',
      body: new FormData(form),
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.message || 'Contact form submission failed.');
    }
    // Display result.message in your form's success notification.
  } catch (error) {
    // Display error.message in your form's error notification.
    console.error(error.message);
  } finally {
    grecaptcha.reset();
  }
});
```

No CORS headers are enabled: use this as a same-origin endpoint, rather than
posting directly to the generated edge-function debug domain.
Always obtain a new token before retrying. Do not automatically retry a failed
submission: a network failure may occur after Slack accepted the message.

Responses are JSON `{ "success": boolean, "message": string }`, always with
`Cache-Control: no-store`. Successful submissions return 200; invalid inputs 400,
failed CAPTCHA/hostname checks 403, unsupported methods 405, oversized bodies 413,
unsupported content types 415, provider rate limits 429, upstream failures 502,
and missing/invalid server configuration 503. No form contents, tokens, secrets,
or raw provider responses are logged or returned. Apply CDN rate limiting before
enabling a public form if additional abuse protection is needed.

### Diagnostic logs

The handler emits structured JSON logs with `component: "contact-form"` and a
generated `requestId`, also returned in the `X-Request-ID` response header.
Use that ID to correlate one form submission across these events:

| Event | Diagnostic details |
| --- | --- |
| `request.received`, `request.validated` | Method, route, body encoding, contact field lengths, token presence |
| `request.rejected`, `configuration.unavailable` | Validation reason/field or configuration-presence flags |
| `captcha.started`, `captcha.response`, `captcha.validated` | Verification endpoint, HTTP status, success, hostname match, known Google error codes, timing |
| `slack.started`, `slack.response`, `slack.result` | Redacted endpoint, outbound field names, HTTP status, provider success and recognized Slack response code, timing |
| `request.completed` | Final HTTP status and total duration |

Failures also emit stage-specific events such as `captcha.failed`,
`slack.http_failure`, and `slack.invalid_response_body`. Exception logs
include the error type, failure stage, and a categorized reason (timeout, DNS,
TLS, redirect, backend availability, connection, network, invalid response, or
unknown), never the potentially sensitive exception message. These categories
are diagnostic hints based on the runtime's error text, not proof of a root cause.
Google verification requests are not automatically retried because CAPTCHA
tokens are single-use.
The contact route uses explicit Fastly backends for Google and Slack with a
10-second connection timeout, a 15-second first-byte timeout, and a 10-second
between-bytes timeout. Fastly's default connection timeout is only one second;
the explicit setting avoids failing slow connections at that threshold.
`captcha.started` and `slack.started` record the configured values in `timeoutsMs`.
TLS certificate hostname verification remains enabled. These backend settings
apply only to the contact route; the weather example is unchanged.
Only allowlisted Slack response codes such as `ok`, `invalid_payload`,
`action_prohibited`, and `no_service` are logged. Other response bodies are
reported as `unrecognized_response`, not dumped into logs. The webhook's
credential path, form values, secrets, tokens, raw HTML, and response headers are
never logged. Provider response-body reads are limited to 16 KiB.
Keep diagnostic logs access-controlled; this is not a request/payload dump.

## Remote debugging

Adobe Managed CDN only offers remote logging as a way to debug your program. The following command will tail your edge function standard output. You will be able to get runtime console.log from your edge function  directly in your terminal. You will have to set the argument function-name to the name you gave your function in the edge function configuration file.

```
aio aem edge-functions tail-logs <function-name>
```

## List Edge Functions

To list all Edge Functions configured for your environment:

```
aio aem edge-functions list
```

This displays a table with the name, active package ID, and timestamps of all available Edge Functions.

## Configuration

### Origins

Adobe Managed CDN allows edge function to access any origins by default. In case you want to restrict access to only defined origins (see [Fastly Documentation](https://js-compute-reference-docs.edgecompute.app/docs/fastly:backend/enforceExplicitBackends)), you will need to define your origins in your edge functions definition (in the edge function configuration file) as an array of origins similar to the [CDN Origin Selectors feature](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-configuring-traffic#origin-selectors).

Given the following configuration

```
origins:
  - name: my-origin-name
    domain: example.com
```

you will be able to select the origin to use for your request as follow

```
const request = new Request("https://example.com/test");
const response = await fetch(request, { backend: "my-origin-name" });
```

> **Note:** Service stores (`configs`, `secrets`, and `kvs`) are not available in [sandbox programs](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/using-cloud-manager/programs/introduction-sandbox-programs). Edge function services themselves run normally on sandbox environments — only the stores are not provisioned.

### Edge Function Environment Configuration

Adobe Managed CDN allows you to use environment variable in your code through config store. Those environment variables can be defined in the edge functions configuration file under configs as an array of objects containing a key and a value fields.

Given the following configuration

```
configs:
  - key: LOG_LEVEL
    value: DEBUG
```

you will be able to get your environment variable as follow

```
import { ConfigStore } from "fastly:config-store";
...
const config = new ConfigStore('config_default');
const logLevel = config.get('LOG_LEVEL') || 'info';
```

**Notes:**
- The config store will always be named config_default
- key name are case-sensitive
- The config store is shared between all your edge functions

### Edge Function Secrets

Adobe Managed CDN allows you to use secrets in your code through secret store. Those secrets can be defined in the edge functions configuration file under secrets as an array of objects containing a key and a value fields. Note that the value field **does not** contain the secret, but a reference to the secret (${{SECRET_REFERENCE}}). The secret needs to be defined in Cloud Manager as described in this [documentation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/operations/config-pipeline#secret-env-vars).

Given the following configuration

```
secrets:
  - key: API_TOKEN
    value: ${{ API_TOKEN_SECRET }}
```

you will be able to get your secret using the secret manager class available in the boilerplate. Secrets get be retrieved as follow

```
import { SecretStoreManager } from "./lib/config";
...
const apiToken = await SecretStoreManager.getSecret('API_TOKEN');
```

**Notes:**
- The secret store will always be named secret_default
- key name are case-sensitive
- **Secrets are immutable**
- The secret store is shared between all your edge functions

### Edge Function KV Store

Adobe Managed CDN allows you to read and write arbitrary key-value data at runtime through a KV store. To enable it, set `kvs: true` in the edge functions configuration file:

```
kvs: true
```

This provisions an empty KV store named `kv_default`. You can interact with the store from your edge function code using the [Fastly KV Store API](https://js-compute-reference-docs.edgecompute.app/docs/fastly:kv-store/KVStore):

```
import { KVStore } from "fastly:kv-store";
...
const kv = new KVStore('kv_default');

// Read a value
const entry = await kv.get('visit-count');
const count = entry ? Number(await entry.text()) : 0;

// Write a value
await kv.put('visit-count', String(count + 1));
```

**Notes:**
- The KV store will always be named kv_default
- The KV store is empty at provision time; populate it at runtime via the Fastly KV Store API (declarative key/value entries in `edgeFunctions.yaml` are not supported)
- The KV store is shared between all your edge functions

### Logging

AEM Edge Functions is compatible with the [log forwarding feature](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/developing/log-forwarding).

`config/logForwarding.yaml` provides a production-only Splunk forwarding
configuration alongside `edgeFunctions.yaml`:

```yaml
kind: "LogForwarding"
version: "1"
metadata:
  envTypes:
    - prod
data:
  splunk:
    default:
      enabled: true
      host: "prd-p-12f3w.splunkcloud.com"
      token: "${{SPLUNK_TOKEN}}"
      index: "eds_logs"
    cdn:
      enabled: true
      token: "${{SPLUNK_TOKEN}}"
      index: "eds_logs"
    aem:
      enabled: false
```

The configured Splunk HEC host is `prd-p-12f3w.splunkcloud.com`. Configure
`SPLUNK_TOKEN` as a Cloud Manager secret environment variable for the target
environment, and ensure the token can write to the `eds_logs` index. Both the
default and CDN settings reference this secret. Do not put the actual token in
this file.

Deploy this configuration through the Cloud Manager configuration pipeline;
building or deploying the Edge Function package does not apply it. The
`metadata.envTypes` restriction excludes dev and stage. CDN forwarding is
enabled; AEM forwarding is disabled.

Use the named logger in Edge Function code as follows:

```
import { Logger } from "fastly:logger";
...
const logger = new Logger("customerSplunk");
logger.log(JSON.stringify({
  method: event.request.method,
  url: event.request.url
}));
```

## Caching

AEM Edge Functions sit between the CDN and the origin. There are **two distinct caches** in the request flow:

```
Browser → AEM CDN (CDN Cache) → AEM Edge Functions (Fetch Cache) → Origin
```

| Cache | What it caches | Influenced by | How to purge |
|-------|---------------|---------------|--------------|
| **CDN Cache** | The Edge Function's response to the browser | Response headers set by the Edge Function (`Cache-Control`, `Surrogate-Control`, `Surrogate-Key`) | [CDN Cache Purge API](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-cache-purge) |
| **Edge Function Fetch Cache** | The origin's response to `fetch()` calls within the Edge Function, **and** any data stored via the Core Cache API | Origin response headers or [`CacheOverride`](https://js-compute-reference-docs.edgecompute.app/docs/fastly:cache-override/CacheOverride/) on fetch calls; surrogate keys assigned programmatically for Core Cache entries | `aio aem edge-functions purge-cache` CLI command or `purgeSurrogateKey()` |

### CDN Cache (Outer)

The CDN cache sits between the browser and the Edge Function. It caches the Edge Function's **response**. You control its behavior by setting standard HTTP cache headers on your Edge Function responses:

```javascript
return new Response(body, {
  headers: {
    'Surrogate-Key': 'page-home product-123',
    'Cache-Control': 'public, max-age=3600'
  }
});
```

Multiple surrogate keys are separated by spaces. These surrogate keys can be used to purge the CDN cache using the [CDN Cache Purge API](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-cache-purge).

#### Varying the CDN Cache Key

By default the CDN caches a response under its URL, so the same URL returns the same cached content for every visitor. When a response depends on a request attribute — for example the `/weather` example varies by the caller's IP-based location — cache it *per that attribute* rather than disabling caching with `skipCache: true`. Fold the attribute into the URL with a CDN [request transformation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-configuring-traffic#request-transformations) so it becomes part of the cache key:

```yaml
requestTransformations:
  rules:
    - name: add-client-ip-to-weather
      when: { reqProperty: path, equals: "/weather" }
      actions:
        - type: set
          queryParam: ip
          value: { reqProperty: clientIp }
```

The function reads the value from the query parameter (`new URL(req.url).searchParams.get("ip")`) instead of the `X-Forwarded-For` header. Each distinct client IP then gets its own cache entry, so repeat requests are served from the CDN cache for the response's `Cache-Control: max-age` — five minutes for the weather example — without re-invoking the Edge Function.

### Edge Function Fetch Cache (Inner)

The Edge Function fetch cache sits between the Edge Function and the origin. It caches the **origin's response** to `fetch()` calls made within your Edge Function code. It also holds any data your code stores via the **Core Cache API** or **Simple Cache API**.

This cache is influenced by:
- The origin's response headers (e.g., `Cache-Control` returned by the origin)
- The [`CacheOverride`](https://js-compute-reference-docs.edgecompute.app/docs/fastly:cache-override/CacheOverride/) option on your fetch calls
- Surrogate keys assigned programmatically when writing to the Core Cache API

> **Important:** The `Surrogate-Key` header you set on your Edge Function's *outgoing response* to the browser controls the **outer CDN cache**, not this inner cache. Surrogate keys for the inner cache come from the origin's `Surrogate-Key` response header or from keys you assign when writing to the Core Cache API.

To cache origin responses for a specific duration:

```javascript
import { CacheOverride } from "fastly:cache-override";

const response = await fetch(request, {
  backend: "my-origin",
  cacheOverride: new CacheOverride({ ttl: 300 })
});
```

To bypass the fetch cache entirely and always fetch from the origin, use `pass` mode:

```javascript
import { CacheOverride } from "fastly:cache-override";

const response = await fetch(request, {
  backend: "my-origin",
  cacheOverride: new CacheOverride({ mode: "pass" })
});
```

### Purging the Edge Function Fetch Cache

The `purge-cache` CLI command purges the **Edge Function fetch cache** (the origin responses cached within the Edge Function). It does **not** purge the outer CDN cache.

```
# Purge by surrogate key
aio aem edge-functions purge-cache <function-name> --surrogateKey my-page-key

# Purge multiple surrogate keys
aio aem edge-functions purge-cache <function-name> -k key1 -k key2

# Purge all cached content (use with caution)
aio aem edge-functions purge-cache <function-name> --all

# Soft purge (stale content served while revalidating)
aio aem edge-functions purge-cache <function-name> --surrogateKey my-key --soft
```

You can also purge surrogate keys programmatically from within your Edge Function code using the [`purgeSurrogateKey`](https://js-compute-reference-docs.edgecompute.app/docs/fastly:compute/purgeSurrogateKey) function:

```javascript
import { purgeSurrogateKey } from "fastly:compute";

// Hard purge (immediate removal)
purgeSurrogateKey("my-page-key");

// Soft purge (retain stale entries for revalidation)
purgeSurrogateKey("my-page-key", true);
```

### Purging the CDN Cache

To purge the outer CDN cache (the Edge Function's response cached at the CDN layer), use the [CDN Cache Purge API](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-cache-purge). This is the same purge mechanism used for all AEM Cloud Service content cached at the CDN.

In the AEM as a Cloud Service architecture, Edge Functions receive traffic from the CDN via [origin selectors](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/implementing/content-delivery/cdn-configuring-traffic#origin-selectors). The complete request flow is:

```
Client → AEM CDN (VCL) → Origin Selector → Edge Function → Origin
```

The CDN caches the final response returned by the Edge Function. A CDN purge clears **only** that outer cached response — it has no effect on the Edge Function's internal caches. Similarly, the `purge-cache` command clears **only** the Edge Function's internal caches — it does not clear the CDN cache.

> **Coordinating purges across both layers:** Because the Edge Function sits behind the CDN as a backend origin (reachable through origin selectors), these two caches operate independently:
>
> 1. Purging only the CDN cache causes the next request to invoke the Edge Function via the origin selector. If the Edge Function's fetch cache still holds stale data, it will return old content — which the CDN then caches again.
> 2. Purging only the Edge Function cache clears internal state, but the CDN continues serving its previously cached copy until it expires or is separately purged.
>
> **Best practice:** When underlying data changes, purge **both** caches — use the CDN Cache Purge API for the outer layer and `purge-cache` (or `purgeSurrogateKey()`) for the inner Edge Function layer. Using consistent surrogate keys across both layers simplifies coordinated invalidation.

## References

https://www.fastly.com/documentation/guides/compute/