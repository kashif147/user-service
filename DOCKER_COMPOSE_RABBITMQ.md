# Docker Compose RabbitMQ Dependency

## Problem

`user-service` depends on `rabbitmq`, but they are in separate docker-compose files:
- `rabbitmq-middleware/docker-compose.yml` - Contains RabbitMQ service
- `user-service/docker-compose.yml` - Contains user-service

Docker Compose's `depends_on` only works for services in the same compose file.

## Solution

We've implemented a **wait script** that ensures RabbitMQ is ready before starting the service.

### How It Works

1. **Wait Script**: `wait-for-rabbitmq.sh` checks if RabbitMQ is accessible on the network
2. **Dockerfile**: Runs the wait script before starting the Node.js service
3. **Network**: Both services use the same external network (`gateway_app-net`)

### Deployment Options

#### Option 1: Use Wait Script (Current Implementation)

The service will automatically wait for RabbitMQ:

```bash
# Start RabbitMQ first
cd rabbitmq-middleware
docker-compose up -d

# Start user-service (will wait for RabbitMQ)
cd ../user-service
docker-compose up -d
```

The wait script will:
- Check if RabbitMQ container is accessible
- Wait up to 60 attempts (2 minutes)
- Start the service even if RabbitMQ isn't ready (graceful fallback)

#### Option 2: Use Docker Compose with Multiple Files

You can combine both compose files:

```bash
# From user-service directory
docker-compose \
  -f ../rabbitmq-middleware/docker-compose.yml \
  -f docker-compose.yml \
  up -d
```

This allows `depends_on` to work properly.

#### Option 3: Add RabbitMQ to user-service compose (Not Recommended)

You could add the rabbitmq service definition to `user-service/docker-compose.yml`, but this would cause conflicts if both compose files try to manage the same container.

## Wait Script Details

**File**: `wait-for-rabbitmq.sh`

- Checks TCP connection to RabbitMQ (port 5672)
- Waits up to 60 attempts (2 minutes total)
- Uses `netcat` for network connectivity check
- Falls back gracefully if RabbitMQ unavailable

**Environment Variables**:
- `RABBITMQ_HOST` - Default: `rabbitmq` (container name)
- `RABBITMQ_PORT` - Default: `5672`
- `MAX_ATTEMPTS` - Default: `60`

## Verification

After starting both services, verify:

```bash
# Check RabbitMQ is running
docker ps | grep rabbitmq

# Check user-service is running
docker ps | grep user-service

# Check logs for wait script
docker logs user-service | grep -i "rabbitmq"
```

Expected output:
```
⏳ Waiting for RabbitMQ at rabbitmq:5672...
✅ RabbitMQ is accessible at rabbitmq:5672!
```

## Benefits

1. ✅ **Ensures RabbitMQ is ready** before service starts
2. ✅ **Works with separate compose files** (no need to combine)
3. ✅ **Graceful fallback** if RabbitMQ unavailable
4. ✅ **Network-based check** (no Docker socket access needed)
5. ✅ **Non-blocking** - Service can start even if RabbitMQ fails

## Troubleshooting

### Service starts before RabbitMQ

Check if the wait script is running:
```bash
docker logs user-service | head -20
```

### RabbitMQ not found

Ensure both services are on the same network:
```bash
docker network inspect gateway_app-net
```

### Wait script fails

The script will exit with code 0 even if RabbitMQ isn't ready, allowing the service to start. Check RabbitMQ separately:
```bash
docker ps | grep rabbitmq
docker logs rabbitmq
```

