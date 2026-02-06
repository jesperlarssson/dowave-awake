import express from "express";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || "./data.sqlite";

const app = express();
app.use(express.json({ limit: "2mb" }));

const db = await open({
  filename: DB_PATH,
  driver: sqlite3.Database,
});

await db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    method TEXT NOT NULL,
    headers_json TEXT,
    body_json TEXT,
    body_is_json INTEGER NOT NULL DEFAULT 0,
    interval_ms INTEGER NOT NULL,
    max_retries INTEGER NOT NULL DEFAULT 0,
    retry_delay_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    next_run_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    success INTEGER NOT NULL,
    status_code INTEGER,
    error_message TEXT,
    attempt_count INTEGER NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id)
  );
`);

async function ensureJobsColumns() {
  const columns = await db.all(`PRAGMA table_info(jobs)`);
  const names = new Set(columns.map((col) => col.name));

  if (!names.has("max_retries")) {
    await db.exec(`ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 0`);
  }
  if (!names.has("retry_delay_ms")) {
    await db.exec(`ALTER TABLE jobs ADD COLUMN retry_delay_ms INTEGER NOT NULL DEFAULT 0`);
  }
}

await ensureJobsColumns();

const timers = new Map();

function nowMs() {
  return Date.now();
}

function normalizeMethod(method) {
  return String(method || "GET").toUpperCase();
}

function serializeHeaders(headers) {
  if (!headers) return null;
  return JSON.stringify(headers);
}

function serializeBody(body) {
  if (body === undefined) return { bodyJson: null, isJson: 0 };
  if (typeof body === "string") return { bodyJson: body, isJson: 0 };
  return { bodyJson: JSON.stringify(body), isJson: 1 };
}

function buildRequestOptions(job) {
  const headers = job.headers_json ? JSON.parse(job.headers_json) : {};
  let body = undefined;

  if (job.body_json != null) {
    if (job.body_is_json) {
      body = job.body_json;
      if (!headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
    } else {
      body = job.body_json;
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

async function runJob(job) {
  const startedAt = nowMs();
  let success = 0;
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
        success = 1;
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

  await db.run(
    `UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE id = ?`,
    lastRun,
    nextRun,
    job.id
  );

  const finishedAt = nowMs();
  await db.run(
    `INSERT INTO run_logs (job_id, started_at, finished_at, success, status_code, error_message, attempt_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    job.id,
    startedAt,
    finishedAt,
    success,
    statusCode,
    errorMessage,
    attemptCount
  );

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
    const latest = await db.get(`SELECT * FROM jobs WHERE id = ?`, job.id);
    if (!latest || !latest.active) return;
    runJob(latest);
  }, delay);

  timers.set(job.id, timer);
}

async function hydrateJobs() {
  const jobs = await db.all(`SELECT * FROM jobs WHERE active = 1`);
  for (const job of jobs) {
    scheduleJob(job);
  }
}

app.post("/jobs", async (req, res) => {
  const { url, method, headers, body, intervalMs, maxRetries, retryDelayMs } = req.body || {};

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
  const headersJson = serializeHeaders(headers);
  const { bodyJson, isJson } = serializeBody(body);

  const result = await db.run(
    `INSERT INTO jobs (url, method, headers_json, body_json, body_is_json, interval_ms, max_retries, retry_delay_ms, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    url,
    methodNorm,
    headersJson,
    bodyJson,
    isJson,
    intervalNumber,
    maxRetriesNumber,
    retryDelayNumber,
    createdAt,
    createdAt + intervalNumber
  );

  const job = await db.get(`SELECT * FROM jobs WHERE id = ?`, result.lastID);
  scheduleJob(job);

  res.status(201).json(job);
});

app.get("/jobs", async (_req, res) => {
  const jobs = await db.all(`SELECT * FROM jobs ORDER BY id DESC`);
  res.json(jobs);
});

app.get("/monitor", async (_req, res) => {
  const jobs = await db.all(`SELECT * FROM jobs ORDER BY id DESC`);
  res.json({ jobs });
});

app.get("/jobs/:id/logs", async (req, res) => {
  const id = Number(req.params.id);
  const logs = await db.all(
    `SELECT * FROM run_logs WHERE job_id = ? ORDER BY id DESC LIMIT 200`,
    id
  );
  res.json(logs);
});

app.patch("/jobs/:id", async (req, res) => {
  const id = Number(req.params.id);
  const existing = await db.get(`SELECT * FROM jobs WHERE id = ?`, id);
  if (!existing) return res.status(404).json({ error: "not found" });

  const { url, method, headers, body, intervalMs, maxRetries, retryDelayMs, active } = req.body || {};

  const updatedUrl = url ?? existing.url;
  const updatedMethod = normalizeMethod(method ?? existing.method);

  const updatedHeadersJson = headers === undefined ? existing.headers_json : serializeHeaders(headers);
  const bodyPayload = body === undefined ? { bodyJson: existing.body_json, isJson: existing.body_is_json } : serializeBody(body);

  const intervalNumber = intervalMs == null ? existing.interval_ms : Number(intervalMs);
  if (!Number.isFinite(intervalNumber) || intervalNumber <= 0) {
    return res.status(400).json({ error: "intervalMs must be a positive number" });
  }

  const maxRetriesNumber = maxRetries == null ? existing.max_retries : Number(maxRetries);
  const retryDelayNumber = retryDelayMs == null ? existing.retry_delay_ms : Number(retryDelayMs);
  if (!Number.isFinite(maxRetriesNumber) || maxRetriesNumber < 0) {
    return res.status(400).json({ error: "maxRetries must be a non-negative number" });
  }
  if (!Number.isFinite(retryDelayNumber) || retryDelayNumber < 0) {
    return res.status(400).json({ error: "retryDelayMs must be a non-negative number" });
  }

  const activeNumber = active == null ? existing.active : active ? 1 : 0;
  const nextRunAt = (existing.last_run_at ?? existing.created_at) + intervalNumber;

  await db.run(
    `UPDATE jobs
     SET url = ?, method = ?, headers_json = ?, body_json = ?, body_is_json = ?,
         interval_ms = ?, max_retries = ?, retry_delay_ms = ?, active = ?, next_run_at = ?
     WHERE id = ?`,
    updatedUrl,
    updatedMethod,
    updatedHeadersJson,
    bodyPayload.bodyJson,
    bodyPayload.isJson,
    intervalNumber,
    maxRetriesNumber,
    retryDelayNumber,
    activeNumber,
    nextRunAt,
    id
  );

  const updated = await db.get(`SELECT * FROM jobs WHERE id = ?`, id);
  scheduleJob(updated);
  res.json(updated);
});

app.delete("/jobs/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.run(`DELETE FROM jobs WHERE id = ?`, id);
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
  res.json({ ok: true });
});

app.post("/jobs/:id/disable", async (req, res) => {
  const id = Number(req.params.id);
  await db.run(`UPDATE jobs SET active = 0 WHERE id = ?`, id);
  if (timers.has(id)) clearTimeout(timers.get(id));
  timers.delete(id);
  res.json({ ok: true });
});

app.post("/jobs/:id/enable", async (req, res) => {
  const id = Number(req.params.id);
  const job = await db.get(`SELECT * FROM jobs WHERE id = ?`, id);
  if (!job) return res.status(404).json({ error: "not found" });
  await db.run(`UPDATE jobs SET active = 1 WHERE id = ?`, id);
  const updated = await db.get(`SELECT * FROM jobs WHERE id = ?`, id);
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
        elJobs.innerHTML = \`
          <tr>
            <th>ID</th><th>Method</th><th>URL</th><th>Interval</th>
            <th>Active</th><th>Last Run</th><th>Next Run</th>
          </tr>
          \${jobs.map(j => \`
            <tr>
              <td>\${j.id}</td>
              <td><span class="pill">\${j.method}</span></td>
              <td><pre>\${j.url}</pre></td>
              <td>\${j.interval_ms} ms</td>
              <td>\${j.active ? "yes" : "no"}</td>
              <td>\${formatMs(j.last_run_at)}</td>
              <td>\${formatMs(j.next_run_at)}</td>
            </tr>
          \`).join("")}
        \`;
        elStatus.textContent = \`updated \${new Date().toLocaleTimeString()}\`;
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
