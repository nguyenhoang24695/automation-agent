FROM node:20-alpine

WORKDIR /app

# Install git (for Git operations in Step 5) and openssh-client
RUN apk add --no-cache git openssh-client

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY src/ ./src/

CMD ["node", "src/index.js"]
