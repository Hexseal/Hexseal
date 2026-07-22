FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
# Cache-bust — see frontend/Dockerfile. The legacy builder over-caches COPY on exFAT.
ARG CACHEBUST=0
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
