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
    created_at INTEGER NOT NULL,
    last_run_at INTEGER,
    next_run_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

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

async function runJob(job) {
  try {
    const options = buildRequestOptions(job);
    await fetch(job.url, options);
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
  const { url, method, headers, body, intervalMs } = req.body || {};

  if (!url || intervalMs == null) {
    return res.status(400).json({ error: "url and intervalMs are required" });
  }

  const intervalNumber = Number(intervalMs);
  if (!Number.isFinite(intervalNumber) || intervalNumber <= 0) {
    return res.status(400).json({ error: "intervalMs must be a positive number" });
  }

  const createdAt = nowMs();
  const methodNorm = normalizeMethod(method);
  const headersJson = serializeHeaders(headers);
  const { bodyJson, isJson } = serializeBody(body);

  const result = await db.run(
    `INSERT INTO jobs (url, method, headers_json, body_json, body_is_json, interval_ms, created_at, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    url,
    methodNorm,
    headersJson,
    bodyJson,
    isJson,
    intervalNumber,
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

await hydrateJobs();

app.listen(PORT, () => {
  console.log(`dowave-awake running on :${PORT}`);
});
