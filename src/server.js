import express from "express";
import { createClient } from "@supabase/supabase-js";

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json({ limit: "2mb" }));

const JOBS_TABLE = "scheduled_api_calls";
const LOGS_TABLE = "scheduled_api_call_logs";

const timers = new Map();

function nowMs() {
  return Date.now();
}

function normalizeMethod(method) {
  return String(method || "GET").toUpperCase();
}

function serializeBody(body) {
  if (body === undefined) return { body: null, bodyIsJson: false };
  if (typeof body === "string") return { body, bodyIsJson: false };
  return { body, bodyIsJson: true };
}

function buildRequestOptions(job) {
  const headers = job.headers ?? {};
  let body = undefined;

  if (job.body != null) {
    if (job.body_is_json) {
      body = JSON.stringify(job.body);
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
    } else {
      body = String(job.body);
    }
  }

  return {
    method: job.method,
    headers,
    body,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptFetch(job) {
  const options = buildRequestOptions(job);
  const response = await fetch(job.url, options);
  return response.status;
}

async function insertRunLog({
  jobId,
  startedAt,
  finishedAt,
  success,
  statusCode,
  errorMessage,
  attemptCount,
}) {
  const { error } = await supabase.from(LOGS_TABLE).insert({
    job_id: jobId,
    started_at: startedAt,
    finished_at: finishedAt,
    success,
    status_code: statusCode,
    error_message: errorMessage,
    attempt_count: attemptCount,
  });

  if (error) {
    console.error("Failed to insert run log", error);
  }
}

async function updateJobSchedule(jobId, lastRunAt, nextRunAt) {
  const { error } = await supabase
    .from(JOBS_TABLE)
    .update({ last_run_at: lastRunAt, next_run_at: nextRunAt })
    .eq("id", jobId);

  if (error) {
    console.error("Failed to update job schedule", error);
  }
}

async function runJob(job) {
  const startedAt = nowMs();
  let success = false;
  let statusCode = null;
  let errorMessage = null;
  let attemptCount = 0;

  try {
    const maxRetries = Number(job.max_retries || 0);
    const retryDelay = Number(job.retry_delay_ms || 0);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      attemptCount = attempt + 1;
      try {
        statusCode = await attemptFetch(job);
        success = true;
        break;
      } catch (err) {
        errorMessage = String(err?.message || err);
        if (attempt < maxRetries && retryDelay > 0) {
          await sleep(retryDelay);
        }
      }
    }
  } catch (err) {
    console.error(`Job ${job.id} failed`, err);
  }

  const lastRun = nowMs();
  const nextRun = lastRun + job.interval_ms;

  await updateJobSchedule(job.id, lastRun, nextRun);

  const finishedAt = nowMs();
  await insertRunLog({
    jobId: job.id,
    startedAt,
    finishedAt,
    success,
    statusCode,
    errorMessage,
    attemptCount,
  });

  scheduleJob({ ...job, last_run_at: lastRun, next_run_at: nextRun });
}

function scheduleJob(job) {
  if (!job.active) return;

  if (timers.has(job.id)) {
    clearTimeout(timers.get(job.id));
  }

  const nextRun = job.next_run_at ?? job.created_at + job.interval_ms;
  const delay = Math.max(0, nextRun - nowMs());

  const timer = setTimeout(async () => {
    const { data: latest, error } = await supabase
      .from(JOBS_TABLE)
      .select("*")
      .eq("id", job.id)
      .single();

    if (error || !latest || !latest.active) return;
    runJob(latest);
  }, delay);

  timers.set(job.id, timer);
}

async function hydrateJobs() {
  const { data: jobs, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Failed to hydrate jobs", error);
    return;
  }

  for (const job of jobs) {
    scheduleJob(job);
  }
}

app.post("/jobs", async (req, res) => {
  const { url, method, headers, body, intervalMs, maxRetries, retryDelayMs } =
    req.body || {};

  if (!url || intervalMs == null) {
    return res.status(400).json({ error: "url and intervalMs are required" });
  }

  const intervalNumber = Number(intervalMs);
  if (!Number.isFinite(intervalNumber) || intervalNumber <= 0) {
    return res.status(400).json({ error: "intervalMs must be a positive number" });
  }

  const maxRetriesNumber = maxRetries == null ? 0 : Number(maxRetries);
  const retryDelayNumber = retryDelayMs == null ? 0 : Number(retryDelayMs);
  if (!Number.isFinite(maxRetriesNumber) || maxRetriesNumber < 0) {
    return res.status(400).json({ error: "maxRetries must be a non-negative number" });
  }
  if (!Number.isFinite(retryDelayNumber) || retryDelayNumber < 0) {
    return res.status(400).json({ error: "retryDelayMs must be a non-negative number" });
  }

  const createdAt = nowMs();
  const methodNorm = normalizeMethod(method);
  const { body: bodyValue, bodyIsJson } = serializeBody(body);

  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .insert({
      url,
      method: methodNorm,
      headers: headers ?? null,
      body: bodyValue,
      body_is_json: bodyIsJson,
      interval_ms: intervalNumber,
      max_retries: maxRetriesNumber,
      retry_delay_ms: retryDelayNumber,
      created_at: createdAt,
      last_run_at: null,
      next_run_at: createdAt + intervalNumber,
      active: true,
    })
    .select("*")
    .single();

  if (error) {
    return res.status(500).json({ error: "failed to create job" });
  }

  scheduleJob(data);
  res.status(201).json(data);
});

app.get("/jobs", async (_req, res) => {
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .order("id", { ascending: false });

  if (error) return res.status(500).json({ error: "failed to load jobs" });
  res.json(data);
});

app.get("/monitor", async (_req, res) => {
  const { data, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .order("id", { ascending: false });

  if (error) return res.status(500).json({ error: "failed to load jobs" });
  res.json({ jobs: data });
});

app.get("/jobs/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  const { data, error } = await supabase
    .from(LOGS_TABLE)
    .select("*")
    .eq("job_id", id)
    .order("id", { ascending: false })
    .limit(200);

  if (error) return res.status(500).json({ error: "failed to load logs" });
  res.json(data);
});

app.patch("/jobs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { data: existing, error: fetchError } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !existing) return res.status(404).json({ error: "not found" });

  const {
    url,
    method,
    headers,
    body,
    intervalMs,
    maxRetries,
    retryDelayMs,
    active,
  } = req.body || {};

  const updatedUrl = url ?? existing.url;
  const updatedMethod = normalizeMethod(method ?? existing.method);
  const updatedHeaders = headers === undefined ? existing.headers : headers;
  const bodyPayload =
    body === undefined
      ? { body: existing.body, bodyIsJson: existing.body_is_json }
      : serializeBody(body);

  const intervalNumber = intervalMs == null ? existing.interval_ms : Number(intervalMs);
  if (!Number.isFinite(intervalNumber) || intervalNumber <= 0) {
    return res.status(400).json({ error: "intervalMs must be a positive number" });
  }

  const maxRetriesNumber =
    maxRetries == null ? existing.max_retries : Number(maxRetries);
  const retryDelayNumber =
    retryDelayMs == null ? existing.retry_delay_ms : Number(retryDelayMs);

  if (!Number.isFinite(maxRetriesNumber) || maxRetriesNumber < 0) {
    return res.status(400).json({ error: "maxRetries must be a non-negative number" });
  }
  if (!Number.isFinite(retryDelayNumber) || retryDelayNumber < 0) {
    return res.status(400).json({ error: "retryDelayMs must be a non-negative number" });
  }

  const activeValue = active == null ? existing.active : Boolean(active);
  const nextRunAt = (existing.last_run_at ?? existing.created_at) + intervalNumber;

  const { data: updated, error: updateError } = await supabase
    .from(JOBS_TABLE)
    .update({
      url: updatedUrl,
      method: updatedMethod,
      headers: updatedHeaders,
      body: bodyPayload.body,
      body_is_json: bodyPayload.bodyIsJson,
      interval_ms: intervalNumber,
      max_retries: maxRetriesNumber,
      retry_delay_ms: retryDelayNumber,
      active: activeValue,
      next_run_at: nextRunAt,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return res.status(500).json({ error: "failed to update job" });

  scheduleJob(updated);
  res.json(updated);
});

app.delete("/jobs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { error } = await supabase.from(JOBS_TABLE).delete().eq("id", id);
  if (error) return res.status(500).json({ error: "failed to delete job" });
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
  res.json({ ok: true });
});

app.post("/jobs/:id/disable", async (req, res) => {
  const id = Number(req.params.id);
  const { error } = await supabase
    .from(JOBS_TABLE)
    .update({ active: false })
    .eq("id", id);

  if (error) return res.status(500).json({ error: "failed to disable job" });
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
  res.json({ ok: true });
});

app.post("/jobs/:id/enable", async (req, res) => {
  const id = Number(req.params.id);
  const { data: job, error } = await supabase
    .from(JOBS_TABLE)
    .select("*")
    .eq("id", id)
    .single();

  if (error || !job) return res.status(404).json({ error: "not found" });

  const { data: updated, error: updateError } = await supabase
    .from(JOBS_TABLE)
    .update({ active: true })
    .eq("id", id)
    .select("*")
    .single();

  if (updateError) return res.status(500).json({ error: "failed to enable job" });

  scheduleJob(updated);
  res.json(updated);
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>dowave-awake monitor</title>
    <style>
      :root { color-scheme: light; }
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; padding: 24px; }
      h1 { margin: 0 0 16px 0; font-size: 20px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e2e2e2; }
      .muted { color: #666; font-size: 12px; }
      .pill { padding: 2px 8px; border-radius: 999px; background: #f0f0f0; display: inline-block; }
      .row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
      button { padding: 6px 10px; font-size: 12px; }
      pre { white-space: pre-wrap; word-break: break-word; }
    </style>
  </head>
  <body>
    <div class="row">
      <h1>dowave-awake monitor</h1>
      <button id="refresh">refresh</button>
      <span id="status" class="muted"></span>
    </div>
    <div class="muted">Shows jobs from /monitor.</div>
    <table id="jobs"></table>
    <script>
      const elJobs = document.getElementById("jobs");
      const elStatus = document.getElementById("status");
      const formatMs = (ms) => ms ? new Date(ms).toISOString() : "-";
      async function load() {
        elStatus.textContent = "loading...";
        const res = await fetch("/monitor");
        const data = await res.json();
        const jobs = data.jobs || [];

        let html = "";
        html += "<tr>";
        html += "<th>ID</th><th>Method</th><th>URL</th><th>Interval</th>";
        html += "<th>Active</th><th>Last Run</th><th>Next Run</th>";
        html += "</tr>";

        html += jobs.map((j) => {
          return (
            "<tr>" +
            "<td>" + j.id + "</td>" +
            "<td><span class=\"pill\">" + j.method + "</span></td>" +
            "<td><pre>" + j.url + "</pre></td>" +
            "<td>" + j.interval_ms + " ms</td>" +
            "<td>" + (j.active ? "yes" : "no") + "</td>" +
            "<td>" + formatMs(j.last_run_at) + "</td>" +
            "<td>" + formatMs(j.next_run_at) + "</td>" +
            "</tr>"
          );
        }).join("");

        elJobs.innerHTML = html;
        elStatus.textContent = "updated " + new Date().toLocaleTimeString();
      }
      document.getElementById("refresh").addEventListener("click", load);
      load();
      setInterval(load, 15000);
    </script>
  </body>
</html>`);
});

await hydrateJobs();

app.listen(PORT, () => {
  console.log(`dowave-awake running on :${PORT}`);
});
