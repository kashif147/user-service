# CORS Configuration Guide for Microservice Deployment

## Environment Variables for Server Deployment

### Required Environment Variables

Add these to your server environment (Docker, Kubernetes, or server config):

```bash
# CORS Configuration
ALLOWED_ORIGINS=https://your-frontend-domain.com,https://your-admin-domain.com,https://your-mobile-domain.com
CORS_CREDENTIALS=true
CORS_MAX_AGE=86400

# Environment
NODE_ENV=staging  # or production
PORT=3000

# Security
SECURITY_HEADERS_ENABLED=true
RATE_LIMIT_ENABLED=true
```

### Docker Configuration

Create a `docker-compose.yml` for staging:

```yaml
version: "3.8"
services:
  user-service:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=staging
      - ALLOWED_ORIGINS=https://staging-frontend.yourdomain.com,https://staging-admin.yourdomain.com
      - CORS_CREDENTIALS=true
      - MONGO_URI=${MONGO_URI}
      - REDIS_URL=${REDIS_URL}
    env_file:
      - .env.staging
    restart: unless-stopped
```

### Kubernetes Configuration

Create a `k8s-configmap.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: user-service-config
data:
  NODE_ENV: "staging"
  ALLOWED_ORIGINS: "https://staging-frontend.yourdomain.com,https://staging-admin.yourdomain.com"
  CORS_CREDENTIALS: "true"
  CORS_MAX_AGE: "86400"
  SECURITY_HEADERS_ENABLED: "true"
  RATE_LIMIT_ENABLED: "true"
```

### Nginx Configuration

If using Nginx as reverse proxy:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    # CORS headers
    add_header 'Access-Control-Allow-Origin' '*' always;
    add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
    add_header 'Access-Control-Allow-Headers' 'Origin, X-Requested-With, Content-Type, Accept, Authorization' always;
    add_header 'Access-Control-Allow-Credentials' 'true' always;

    # Handle preflight requests
    if ($request_method = 'OPTIONS') {
        add_header 'Access-Control-Allow-Origin' '*' always;
        add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, OPTIONS' always;
        add_header 'Access-Control-Allow-Headers' 'Origin, X-Requested-With, Content-Type, Accept, Authorization' always;
        add_header 'Access-Control-Max-Age' 86400;
        add_header 'Content-Type' 'text/plain; charset=utf-8';
        add_header 'Content-Length' 0;
        return 204;
    }

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Load Balancer Configuration

For AWS ALB or similar:

```yaml
# ALB Target Group Health Check
health_check_path: /health
health_check_interval: 30
health_check_timeout: 5
healthy_threshold_count: 2
unhealthy_threshold_count: 3

# Security Groups
inbound_rules:
  - port: 3000
    protocol: tcp
    source: "0.0.0.0/0" # Restrict to your frontend IPs
```

## Testing CORS Configuration

### Test Script

Create `test-cors.js`:

```javascript
const axios = require("axios");

const testOrigins = [
  "https://staging-frontend.yourdomain.com",
  "https://staging-admin.yourdomain.com",
  "https://unauthorized-domain.com",
];

async function testCORS() {
  for (const origin of testOrigins) {
    try {
      const response = await axios.get(
        "https://staging-api.yourdomain.com/health",
        {
          headers: { Origin: origin },
          validateStatus: () => true,
        }
      );

      console.log(`Origin: ${origin}`);
      console.log(`Status: ${response.status}`);
      console.log(`CORS Headers:`, {
        "Access-Control-Allow-Origin":
          response.headers["access-control-allow-origin"],
        "Access-Control-Allow-Credentials":
          response.headers["access-control-allow-credentials"],
      });
      console.log("---");
    } catch (error) {
      console.log(`Origin: ${origin} - Error:`, error.message);
    }
  }
}

testCORS();
```

### Frontend Integration

For React/Next.js applications:

```javascript
// API client configuration
const apiClient = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// Handle CORS errors
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.message.includes("CORS")) {
      console.error("CORS Error:", error.response?.data);
      // Handle CORS error in UI
    }
    return Promise.reject(error);
  }
);
```

## Monitoring and Debugging

### CORS Logging

The CORS configuration includes logging for blocked origins. Monitor your logs for:

```
CORS blocked origin: https://unauthorized-domain.com
Allowed origins: https://staging-frontend.yourdomain.com, https://staging-admin.yourdomain.com
```

### Health Check Endpoint

Add to your routes:

```javascript
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    cors: {
      allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",") || [],
      credentials: process.env.CORS_CREDENTIALS === "true",
    },
  });
});
```

## Security Considerations

1. **Never use wildcard origins** (`*`) in production
2. **Always specify exact domains** in `ALLOWED_ORIGINS`
3. **Use HTTPS** for all production domains
4. **Regularly audit** allowed origins
5. **Monitor CORS violations** in logs
6. **Use environment-specific** configurations

## Troubleshooting

### Common Issues

1. **CORS still blocked**: Check if `ALLOWED_ORIGINS` includes exact domain
2. **Credentials not sent**: Ensure `withCredentials: true` in frontend
3. **Preflight fails**: Check if OPTIONS method is handled
4. **Headers missing**: Verify `allowedHeaders` includes required headers

### Debug Commands

```bash
# Test CORS from command line
curl -H "Origin: https://your-frontend.com" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: X-Requested-With" \
     -X OPTIONS \
     https://your-api.com/health

# Check environment variables
docker exec -it container_name env | grep CORS
```
