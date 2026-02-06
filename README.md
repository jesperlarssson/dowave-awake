# dowave-awake

Simple service that stores scheduled API calls in SQLite and replays them on an interval.

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
- Jobs are rehydrated from SQLite on restart.

## Monitoring

- `GET /monitor` returns all jobs
- `GET /jobs/:id/logs` returns recent run logs
