import { badRequest } from "./errors";
import { normalizeModelName } from "./responses";
import { resolveCredential } from "./coordinator";
import { fetchUpstream } from "./upstream";
import type { Env, JsonObject } from "./types";

type ImageEndpoint = "generations" | "edits";

interface PreparedImageBody {
  body: BodyInit;
  contentType?: string;
}

function requireImageModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest("missing_model", "The image request requires a model");
  }
  return normalizeModelName(value);
}

async function prepareImageBody(request: Request, endpoint: ImageEndpoint): Promise<PreparedImageBody> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw badRequest("invalid_multipart", "Image edit body must be valid multipart form data");
    }
    const model = requireImageModel(form.get("model"));
    form.set("model", model);
    return { body: form };
  }

  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest("invalid_json", "Image request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("invalid_json", "Image request body must be a JSON object");
  }
  const body = { ...(value as JsonObject) };
  body.model = requireImageModel(body.model);
  if (endpoint === "edits" && body.image === undefined) {
    throw badRequest("missing_image", "The image edit request requires image data");
  }
  return { body: JSON.stringify(body), contentType: "application/json" };
}

function responseHeaders(upstream: Response, id: string): Headers {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", id);
  return headers;
}

export async function handleImages(
  request: Request,
  env: Env,
  id: string,
  endpoint: ImageEndpoint,
): Promise<Response> {
  const prepared = await prepareImageBody(request, endpoint);
  const { credential } = await resolveCredential(env);
  const upstream = await fetchUpstream(env, credential, `/images/${endpoint}`, {
    method: "POST",
    body: prepared.body,
    contentType: prepared.contentType,
    accept: "application/json",
    kind: "media",
  });
  return new Response(upstream.body, { status: 200, headers: responseHeaders(upstream, id) });
}
