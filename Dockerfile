FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --production || true

COPY . .

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "server.js"]
