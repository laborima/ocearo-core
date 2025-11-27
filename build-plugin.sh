#!/bin/bash

echo "🔨 Building ocearo-core Plugin..."

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to plugin directory
cd "$SCRIPT_DIR/plugin"

echo "Working in directory: $(pwd)"

# Check if package.json exists
if [ ! -f "package.json" ]; then
    echo "❌ package.json not found in $(pwd)"
    exit 1
fi

# Clean previous builds
echo "🧹 Cleaning previous build..."
rm -rf node_modules

# Install dependencies
if [ -f "package-lock.json" ]; then
    echo "📦 Installing dependencies with npm ci..."
    npm ci || {
        echo "⚠️  npm ci failed, attempting npm install instead..."
        npm install || echo "⚠️  Dependency installation had issues, but continuing build..."
    }
else
    echo "📦 Installing dependencies..."
    npm install || echo "⚠️  Dependency installation had issues, but continuing build..."
fi

# Run build script if available
echo "🛠️ Running build (if available)..."
npm run build --if-present || echo "⚠️  Build script not found or failed, continuing..."

# Remove local dependencies to prepare deployment
echo "🧹 Removing local node_modules before deployment..."
rm -rf node_modules
