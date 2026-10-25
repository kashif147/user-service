FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

# Install netcat-openbsd for TCP connection checks and curl for health checks
RUN apk add --no-cache netcat-openbsd curl git

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Copy wait script
COPY wait-for-rabbitmq.sh /usr/local/bin/wait-for-rabbitmq.sh
RUN chmod +x /usr/local/bin/wait-for-rabbitmq.sh

EXPOSE 5001

# Wait for RabbitMQ, then start the service
CMD ["sh", "-c", "wait-for-rabbitmq.sh && npm start"]
