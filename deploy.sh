#!/bin/bash

# Configuration variables
LOCAL_BUILD_DIR="./plugin"  # Path to the Next.js build directory
REMOTE_USER="pi"           # Username for the Raspberry Pi
REMOTE_HOST="cirrus.local" # IP or hostname of the Raspberry Pi
REMOTE_PLUGIN_DIR="/home/pi/.signalk/node_modules/ocearo-core" # Path to the plugin folder on the Pi
SSH_PORT=22                # SSH port, default is 22

./build-plugin.sh

# Determine if runtime dependencies exist
DEPENDENCY_COUNT=$(node -e "const pkg=require('${LOCAL_BUILD_DIR}/package.json'); const deps=pkg.dependencies || {}; console.log(Object.keys(deps).length);")
if [ $? -ne 0 ]; then
  echo "Failed to inspect dependencies. Ensure Node.js is available locally."
  exit 1
fi

# Transfer files using SCP
echo "Transferring files to Raspberry Pi..."
scp -r -P $SSH_PORT "$LOCAL_BUILD_DIR"/. $REMOTE_USER@$REMOTE_HOST:$REMOTE_PLUGIN_DIR

# Check if SCP was successful
if [ $? -ne 0 ]; then
  echo "File transfer failed! Please check your connection and configuration."
  exit 1
fi

# Install dependencies on remote host if needed
if [ "$DEPENDENCY_COUNT" -gt 0 ]; then
  echo "Installing dependencies on Raspberry Pi..."
  ssh -p $SSH_PORT $REMOTE_USER@$REMOTE_HOST "cd $REMOTE_PLUGIN_DIR && rm -rf node_modules && if [ -f package-lock.json ]; then npm ci --omit=dev || npm install --production; else npm install --production; fi"

  if [ $? -ne 0 ]; then
    echo "Failed to install dependencies on Raspberry Pi!"
    exit 1
  fi
else
  echo "No runtime dependencies declared; skipping dependency installation."
fi

# Optional: Restart Signal K server
echo "Restarting Signal K server on Raspberry Pi..."
ssh -p $SSH_PORT $REMOTE_USER@$REMOTE_HOST "sudo systemctl restart signalk"

if [ $? -ne 0 ]; then
  echo "Failed to restart Signal K server! Please restart it manually."
  exit 1
fi

echo "Deployment complete!"
