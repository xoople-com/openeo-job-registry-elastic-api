# dev build
FROM node:24-alpine AS builder
LABEL stage=builder
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .

RUN npm run build



# prod build
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /usr/src/app/dist ./dist

USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
