# dowave-awake

Service that stores scheduled API calls in Supabase and replays them on an interval.

## Setup

Set env vars:

```bash
export SUPABASE_URL="https://obfdcgcctdfqqrdffxhk.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<your-service-role-key>"
```

Create tables in Supabase (SQL editor):

```sql
create table if not exists scheduled_api_calls (
  id bigserial primary key,
  url text not null,
  method text not null,
  headers jsonb,
  body jsonb,
  body_is_json boolean not null default false,
  interval_ms bigint not null,
  max_retries int not null default 0,
  retry_delay_ms bigint not null default 0,
  created_at bigint not null,
  last_run_at bigint,
  next_run_at bigint,
  active boolean not null default true
);

create table if not exists scheduled_api_call_logs (
  id bigserial primary key,
  job_id bigint not null references scheduled_api_calls(id) on delete cascade,
  started_at bigint not null,
  finished_at bigint not null,
  success boolean not null,
  status_code int,
  error_message text,
  attempt_count int not null
);
```

## Run

```bash
npm install
npm run dev
```

## Create a job

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/webhook",
    "method": "POST",
    "headers": {"x-foo": "bar"},
    "body": {"hello": "world"},
    "intervalMs": 840000,
    "maxRetries": 3,
    "retryDelayMs": 2000
  }'
```

## Notes

- `intervalMs` is required and is in milliseconds.
- `maxRetries` and `retryDelayMs` are optional.
- First run happens `intervalMs` after job creation.
- Jobs are rehydrated from Supabase on restart.

## Monitoring

- `GET /monitor` returns all jobs
- `GET /jobs/:id/logs` returns recent run logs
