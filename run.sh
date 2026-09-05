#!/usr/bin/env bash
# Start the ASCII art generator. uv creates and syncs the venv on first run, so this is the
# only command needed on a fresh checkout.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"

PORT="${PORT:-8000}"
echo "ASCII art generator  ->  http://localhost:${PORT}"

# --reload is scoped to the Python package: watching the whole tree would restart the server
# every time a file is uploaded into media/.
exec uv run uvicorn server.app:app \
  --host 127.0.0.1 --port "$PORT" \
  --reload --reload-dir server "$@"
