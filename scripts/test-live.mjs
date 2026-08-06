import { readFile } from "node:fs/promises";

const truthy = (name) => /^(1|true|yes|on)$/i.test(process.env[name] || "");
if (!truthy("LIVE_TEST")) {
  console.error("Live tests are opt-in. Set LIVE_TEST=1 to continue.");
  process.exit(1);
}

const credentialPath = process.env.CPA_CREDENTIAL_PATH;
const workerUrl = process.env.WORKER_URL;
const adminKey = process.env.ADMIN_API_KEY;
const clientKey = process.env.CLIENT_API_KEY;
if (!credentialPath || !workerUrl || !adminKey || !clientKey) {
  console.error("LIVE_TEST requires CPA_CREDENTIAL_PATH, WORKER_URL, ADMIN_API_KEY, and CLIENT_API_KEY.");
  process.exit(1);
}

function endpoint(path) {
  return `${workerUrl.replace(/\/+$/, "")}${path}`;
}

async function call(path, options = {}) {
  const response = await fetch(endpoint(path), options);
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}`);
  }
  return response;
}

const raw = await readFile(credentialPath, "utf8");
let credential;
try {
  credential = JSON.parse(raw);
} catch {
  throw new Error("CPA_CREDENTIAL_PATH is not valid JSON");
}
for (const field of ["type", "auth_kind", "access_token", "refresh_token", "base_url"]) {
  if (!credential || typeof credential[field] !== "string" || !credential[field]) {
    throw new Error(`CPA credential is missing ${field}`);
  }
}

await call("/admin/credentials/import", {
  method: "POST",
  headers: {
    authorization: `Bearer ${adminKey}`,
    "content-type": "application/json",
  },
  body: raw,
});
console.log("CPA credential import: ok (credential values were not printed).");

const modelsResponse = await call("/v1/models", {
  headers: { authorization: `Bearer ${clientKey}` },
});
let modelCount = "unknown";
try {
  const models = await modelsResponse.json();
  if (Array.isArray(models?.data)) modelCount = String(models.data.length);
} catch {
  // The status is enough for this smoke test; do not print upstream content.
}
console.log(`Models request: ok (${modelCount} models reported).`);

const liveModel = process.env.LIVE_MODEL;
if ((truthy("LIVE_RESPONSES") || truthy("LIVE_IMAGE") || truthy("LIVE_SEARCH")) && !liveModel) {
  throw new Error("LIVE_MODEL is required when LIVE_RESPONSES, LIVE_IMAGE, or LIVE_SEARCH is enabled.");
}

if (truthy("LIVE_RESPONSES")) {
  await call("/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: liveModel, input: "Reply with the single word OK.", stream: false }),
  });
  console.log("Minimal Responses request: ok.");
}

if (truthy("LIVE_SEARCH")) {
  await call("/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: liveModel,
      input: "What is the current date? Answer briefly.",
      tools: [{ type: "web_search" }],
      stream: false,
    }),
  });
  console.log("Web search Responses request: ok.");
}

if (truthy("LIVE_IMAGE")) {
  await call("/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${clientKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: liveModel, prompt: "A simple blue square on a white background." }),
  });
  console.log("Image generation request: ok.");
}

