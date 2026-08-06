export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly type: string;

  constructor(status: number, code: string, message: string, type = "invalid_request_error") {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

export class UpstreamError extends AppError {
  readonly upstreamStatus: number;
  readonly upstreamRequestId?: string;

  constructor(status: number, message: string, upstreamRequestId?: string) {
    super(status, "upstream_error", message, "upstream_error");
    this.name = "UpstreamError";
    this.upstreamStatus = status;
    this.upstreamRequestId = upstreamRequestId;
  }
}

export function badRequest(code: string, message: string): AppError {
  return new AppError(400, code, message);
}

export function unauthorized(message = "Invalid API key"): AppError {
  return new AppError(401, "invalid_api_key", message, "authentication_error");
}

export function forbidden(message = "Forbidden"): AppError {
  return new AppError(403, "forbidden", message, "permission_error");
}

export function notFound(message = "Not found"): AppError {
  return new AppError(404, "not_found", message, "invalid_request_error");
}

export function methodNotAllowed(message = "Method not allowed"): AppError {
  return new AppError(405, "method_not_allowed", message, "invalid_request_error");
}

export function internalError(message = "Internal server error"): AppError {
  return new AppError(500, "internal_error", message, "server_error");
}

