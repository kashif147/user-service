#!/bin/sh
# Wait for RabbitMQ to be ready
# This script checks if RabbitMQ is accessible via network

set -e

RABBITMQ_HOST="${RABBITMQ_HOST:-rabbitmq}"
RABBITMQ_PORT="${RABBITMQ_PORT:-5672}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-60}"
ATTEMPT=0

echo "⏳ Waiting for RabbitMQ at ${RABBITMQ_HOST}:${RABBITMQ_PORT}..."

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
  # Try to connect to RabbitMQ port
  if nc -z "${RABBITMQ_HOST}" "${RABBITMQ_PORT}" 2>/dev/null; then
    echo "✅ RabbitMQ is accessible at ${RABBITMQ_HOST}:${RABBITMQ_PORT}!"
    exit 0
  fi
  
  ATTEMPT=$((ATTEMPT + 1))
  if [ $((ATTEMPT % 5)) -eq 0 ]; then
    echo "⏳ Attempt $ATTEMPT/$MAX_ATTEMPTS: RabbitMQ not ready yet, waiting..."
  fi
  sleep 2
done

echo "❌ RabbitMQ did not become accessible within ${MAX_ATTEMPTS} attempts"
echo "⚠️  Starting service anyway (RabbitMQ initialization is non-blocking)"
exit 0
