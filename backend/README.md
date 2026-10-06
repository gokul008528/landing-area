# Backend Deployment Notes

## Production code execution mode

Use Docker-backed execution in production:

```env
CODE_EXECUTION_MODE=docker
ALLOW_UNSAFE_LOCAL_EXECUTION=false
EXECUTION_TIMEOUT_MS=5000
EXECUTION_COMPILE_TIMEOUT_MS=30000
MAX_CONCURRENT_EXECUTIONS=4
MAX_PENDING_EXECUTIONS=200
EXECUTION_QUEUE_TIMEOUT_MS=30000
EXECUTION_TMP_DIR=/var/tmp
DB_INIT_MODE=verify
```

In this mode, the backend does not execute student code directly on the host. It launches short-lived Docker containers for `javascript`, `python`, `java`, `c`, and `cpp`.

`EXECUTION_TIMEOUT_MS` is the per-test runtime limit for submitted code. `EXECUTION_COMPILE_TIMEOUT_MS` is separate because Java, C, and C++ must start a compiler container and compile before running tests.

## Important architecture note

If you run the backend itself inside Docker, the container must have access to the host Docker daemon:

- mount `/var/run/docker.sock:/var/run/docker.sock`
- ensure the backend container has the `docker` CLI installed

The production Dockerfile in [`docker/Dockerfile`](./docker/Dockerfile) is prepared for that setup.

## Simpler EC2 deployment

For the simplest first production deployment:

1. Run the backend directly on the EC2 host with Node.js
2. Install Docker Engine on the EC2 host
3. Set `CODE_EXECUTION_MODE=docker`
4. Set `ALLOW_UNSAFE_LOCAL_EXECUTION=false`
5. Pre-pull the runner images used by the backend:

```bash
docker pull node:20-alpine
docker pull python:3.11-alpine
docker pull amazoncorretto:17-alpine-jdk
docker pull gcc:13
```

This avoids cold-start image pulls during the first student submission.

## Same-VPS scaling layout

For a single VPS, keep the normal API and socket traffic on the main backend
process, and send code execution traffic to a separate PM2 process. This keeps
long Docker-backed runs from competing with normal LMS pages, auth, chat, and
admin APIs.

Start both processes from the backend directory:

```bash
pm2 start ecosystem.config.cjs --only lms-api
pm2 start ecosystem.config.cjs --only lms-execution
pm2 save
```

Recommended first-pass sizing:

```env
# Main API process
PORT=5000
MAX_CONCURRENT_EXECUTIONS=2
MAX_PENDING_EXECUTIONS=100

# Execution process
PORT=5001
CODE_EXECUTION_MODE=docker
ALLOW_UNSAFE_LOCAL_EXECUTION=false
MAX_CONCURRENT_EXECUTIONS=12
MAX_PENDING_EXECUTIONS=1000
EXECUTION_QUEUE_TIMEOUT_MS=60000
EXECUTION_COMPILE_TIMEOUT_MS=30000
EXECUTION_TMP_DIR=/var/tmp
```

Tune `MAX_CONCURRENT_EXECUTIONS` from real VPS capacity. A conservative rule is
2-3 concurrent executions per vCPU, then lower it if memory pressure, Docker
startup latency, or database latency rises.

Example Nginx split:

```nginx
# Code execution endpoints go to the execution process.
location = /api/practice/run {
    proxy_pass http://127.0.0.1:5001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}

location = /api/practice/submit {
    proxy_pass http://127.0.0.1:5001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;
    proxy_send_timeout 90s;
}

# Everything else stays on the main API process.
location /api/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /socket.io/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Check pressure and Docker readiness:

```bash
curl -fsS http://127.0.0.1:5001/api/health/execution
```

The response includes Docker status, image availability, process role, temp
root, and queue stats.
