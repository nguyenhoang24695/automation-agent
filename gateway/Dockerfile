FROM node:20-alpine

# sharp and zca-js may need native build tools
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/

# Create secrets directory for Zalo credentials
RUN mkdir -p secrets

EXPOSE 8000

CMD ["node", "src/index.js"]
