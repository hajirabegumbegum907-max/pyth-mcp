FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY bin/ ./bin/
COPY lib/ ./lib/
COPY types/ ./types/
COPY index.js mcp-server.js ./

ENTRYPOINT ["node", "mcp-server.js"]
