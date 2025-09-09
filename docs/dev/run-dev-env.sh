#!/bin/bash

set -e

REPO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/../.." && pwd )"

pm2 delete all || true


# Environment Variables
if [ -f "${REPO_DIR}/docs/dev/env.sh" ]; then
    . ${REPO_DIR}/docs/dev/env.sh
fi


# Server
cd "${REPO_DIR}/cloudcost-server"
if [ ! -f package-lock.json ]; then
    rm -fr node_modules
    npm install
fi
if [ ! -d node_modules ]; then
    npm ci
fi

# Start
cd "${REPO_DIR}"
pm2 start ecosystem.config.js --env development
pm2 logs
