# Parity Harness

Diffs the legacy TypeScript backend (`backend-legacy/`) against the Python
backend on the same request bodies so the migration can be verified
endpoint-by-endpoint.

## Run

From `backend/`:

```bash
uv run python tests/parity/parity_check.py
```

Requires `bun` on PATH (for the TS backend) and the venv in
`backend/.venv`. Both backends start on scratch ports (3102/3103) against
temporary data dirs, so no real user data is touched.

## What it checks

For each endpoint it compares HTTP status and JSON body (after scrubbing
volatile fields: timestamps, ids, digests, colors). The TS backend is the
reference — a Python mismatch is a porting bug.

## Adding cases

Append `(method, path, body, label)` tuples to `CASES` in `parity_check.py`.
For authenticated endpoints, register a user on both sides first and pass the
token in the body/headers (extend the harness with a shared auth step when
needed).