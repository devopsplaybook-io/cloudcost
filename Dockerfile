# BUILD
FROM node:24.22.2-alpine3.24 as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY cloudcost-server cloudcost-server

RUN cd cloudcost-server && \
    npm ci && \
    npm run build && \
    npm prune --omit=dev

# RUN
FROM node:24.22.2-alpine3.24

COPY --from=builder /opt/src/cloudcost-server/node_modules /opt/app/cloudcost/node_modules
COPY --from=builder /opt/src/cloudcost-server/dist /opt/app/cloudcost/dist
COPY cloudcost-server/config.json /opt/app/cloudcost/config.json
COPY package.json /opt/app/cloudcost/package.json

WORKDIR /opt/app/cloudcost

ENV NODE_ENV=production

USER node

CMD [ "dist/App.js" ]