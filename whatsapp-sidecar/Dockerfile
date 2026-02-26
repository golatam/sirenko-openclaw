FROM node:22-slim

WORKDIR /app
COPY package.json /app/
RUN npm install --production

COPY main.js /app/

ENV NODE_ENV=production

CMD ["node", "main.js"]
