import { AppError } from "./errors";

export function requestId(request: Request): string {
  const incoming = request.headers.get("x-request-id");
  if (incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)) {
    return incoming;
  }
  return crypto.randomUUID();
}

export function jsonResponse(
  value: unknown,
  status = 200,
  requestIdValue?: string,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  if (requestIdValue) headers.set("x-request-id", requestIdValue);
  return new Response(JSON.stringify(value), { status, headers });
}

export function errorResponse(error: unknown, id: string): Response {
  const appError = error instanceof AppError
    ? error
    : new AppError(500, "internal_error", "Internal server error", "server_error");

  return jsonResponse(
    {
      error: {
        message: appError.message,
        type: appError.type,
        code: appError.code,
      },
    },
    appError.status,
    id,
  );
}

export function withRequestId(response: Response, id: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", id);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

export function timingSafeEqual(left: string | null, right: string | undefined): boolean {
  if (!left || !right) return false;
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function isAuthorized(request: Request, expectedKey: string | undefined): boolean {
  return timingSafeEqual(getBearerToken(request), expectedKey);
}

export async function readJsonObject(request: Request, maxBytes = 2_000_000): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new AppError(413, "request_too_large", "Request body is too large");
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new AppError(400, "invalid_body", "Unable to read request body");
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new AppError(413, "request_too_large", "Request body is too large");
  }

  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be a JSON object");
  }
}

export function safeHeaderSubset(source: Headers, names: string[]): Headers {
  const output = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value) output.set(name, value);
  }
  return output;
}

