import { UpstreamError } from "./errors";
import type { Env, StoredCredential } from "./types";
import { DEFAULT_CLI_PROXY_BASE_URL, validateBaseUrl } from "./credentials";

export type UpstreamKind = "text" | "media";

export function getTextBaseUrl(env: Env, credential: StoredCredential): string {
  if (env.TEXT_UPSTREAM_PROFILE === "cli-proxy") {
    return validateBaseUrl(env.CLI_PROXY_BASE_URL || DEFAULT_CLI_PROXY_BASE_URL, "CLI_PROXY_BASE_URL");
  }
  return credential.baseUrl;
}

export function getMediaBaseUrl(env: Env, credential: StoredCredential): string {
  return env.MEDIA_BASE_URL
    ? validateBaseUrl(env.MEDIA_BASE_URL, "MEDIA_BASE_URL")
    : credential.baseUrl;
}

function buildUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");
  return `${baseUrl.replace(/\/+$/, "")}/${normalizedPath}`;
}

export function buildUpstreamHeaders(
  credential: StoredCredential,
  env: Env,
  options: {
    accept?: string;
    contentType?: string;
    conversationId?: string;
    kind?: UpstreamKind;
  } = {},
): Headers {
  const headers = new Headers();
  headers.set("authorization", `${credential.tokenType} ${credential.accessToken}`);
  headers.set("accept", options.accept || "application/json");
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.conversationId) headers.set("x-grok-conv-id", options.conversationId);

  if (options.kind === "text" && env.TEXT_UPSTREAM_PROFILE === "cli-proxy") {
    const clientVersion = env.CLI_PROXY_CLIENT_VERSION || "0.2.120";
    headers.set("x-xai-token-auth", "xai-grok-cli");
    headers.set("x-grok-client-version", clientVersion);
    headers.set("user-agent", `xai-grok-workspace/${clientVersion}`);
    headers.set("x-grok-client-identifier", "grok-shell");
    headers.set("x-authenticateresponse", "authenticate-response");
  }
  return headers;
}

export async function fetchUpstream(
  env: Env,
  credential: StoredCredential,
  path: string,
  init: {
    method: string;
    body?: BodyInit | null;
    accept?: string;
    contentType?: string;
    conversationId?: string;
    kind?: UpstreamKind;
    fetchImpl?: typeof fetch;
  },
): Promise<Response> {
  const baseUrl = init.kind === "media" ? getMediaBaseUrl(env, credential) : getTextBaseUrl(env, credential);
  const headers = buildUpstreamHeaders(credential, env, {
    accept: init.accept,
    contentType: init.contentType,
    conversationId: init.conversationId,
    kind: init.kind,
  });
  const fetchImpl = init.fetchImpl || fetch;

  let response: Response;
  try {
    response = await fetchImpl(buildUrl(baseUrl, path), {
      method: init.method,
      headers,
      body: init.body,
    });
  } catch {
    throw new UpstreamError(502, "The upstream xAI service could not be reached");
  }

  if (!response.ok) {
    const upstreamRequestId = response.headers.get("x-request-id") || response.headers.get("request-id") || undefined;
    throw new UpstreamError(502, "The upstream xAI service rejected the request", upstreamRequestId);
  }
  return response;
}
