const MAX_BODY_BYTES = 16 * 1024;

export const CONTACT_BACKEND_TIMEOUTS = Object.freeze({
  connectTimeout: 10_000,
  firstByteTimeout: 15_000,
  betweenBytesTimeout: 10_000,
});

export function contactBackendOptions(requestUrl) {
  const url = new URL(requestUrl);
  return {
    // The installed runtime requires a name despite the SDK's optional type.
    name: `contact-${url.hostname}`,
    target: url.host,
    hostOverride: url.hostname,
    useSSL: true,
    sniHostname: url.hostname,
    certificateHostname: url.hostname,
    ...CONTACT_BACKEND_TIMEOUTS,
  };
}

export function errorType(error) {
  return ["TypeError", "SyntaxError", "RangeError"].includes(error?.name)
    ? error.name : "Error";
}

export function failureReason(error) {
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/dns|name resolution|resolve.*host/.test(message)) return "dns";
  if (/tls|ssl|certificate/.test(message)) return "tls";
  if (/redirect/.test(message)) return "redirect";
  if (/backend.*(not found|does not exist)|find.*backend/.test(message)) return "backend_unavailable";
  if (/connection|connect|socket/.test(message)) return "connection";
  if (/network|fetch/.test(message)) return "network";
  if (error?.name === "SyntaxError") return "invalid_response";
  if (error?.name === "RangeError") return "body_limit";
  return "unknown";
}

export async function readBody(req) {
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
