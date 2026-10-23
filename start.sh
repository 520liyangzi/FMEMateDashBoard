#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3.10+ is required. Please install Python and run this script again."
  exit 1
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Python 3.10+ is required."
  exit 1
}
echo "FMEMate Project Pulse: http://127.0.0.1:8000"
echo "Keep this terminal open. Press Ctrl+C to stop."
exec python3 server.py "$@"
