#!/bin/bash
# Run the agent in the foreground with auto-reload. Stop the launchd job first if it is installed,
# or set CCA_PORT to a different port.
cd "$(dirname "$0")/.." && exec node --watch packages/agent/src/main.ts
