#!/bin/bash
# Fix symlink issue for policy-middleware during Azure deployment
# This script removes any existing symlink and ensures proper directory structure

echo "Fixing policy-middleware symlink..."

# Remove existing symlink or directory if it exists
if [ -L "node_modules/@membership/policy-middleware" ] || [ -d "node_modules/@membership/policy-middleware" ]; then
  echo "Removing existing symlink/directory..."
  rm -rf "node_modules/@membership/policy-middleware" 2>/dev/null || true
fi

# Ensure @membership directory exists
mkdir -p "node_modules/@membership" 2>/dev/null || true

# Create proper symlink if policy-middleware directory exists
if [ -d "policy-middleware" ]; then
  echo "Creating symlink to policy-middleware..."
  ln -sf "$(pwd)/policy-middleware" "node_modules/@membership/policy-middleware" 2>/dev/null || true
  echo "Symlink created successfully"
else
  echo "Warning: policy-middleware directory not found"
fi

echo "Symlink fix complete"

