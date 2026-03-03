FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev

COPY main.js /app/

ENV NODE_ENV=production

CMD ["node", "main.js"]
