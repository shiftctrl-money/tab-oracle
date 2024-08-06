FROM node:20.12.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init

ENV NODE_ENV=production

WORKDIR /usr/src/app

COPY --chown=node:node . /usr/src/app

RUN npm ci --omit=dev

RUN chown -R node:node node_modules

USER node

RUN npx prisma generate

CMD ["dumb-init", "npm", "start"]
