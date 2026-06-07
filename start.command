#!/bin/bash
# Double-click this file (macOS) to launch the Research Console.
cd "$(dirname "$0")"
echo "Starting Research Console…  (close this window to stop)"
exec node src/server.mjs
