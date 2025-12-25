FROM node:22-alpine

# Install netcat-openbsd for TCP connection checks and curl for health checks
RUN apk add --no-cache netcat-openbsd curl

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
