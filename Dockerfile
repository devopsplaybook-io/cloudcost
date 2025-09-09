# BUILD
FROM node:22-alpine as builder

WORKDIR /opt/src

RUN apk add --no-cache bash git python3 perl alpine-sdk

COPY cloudcost-server cloudcost-server

RUN cd cloudcost-server && \
    npm ci && \
    npm run build

# RUN
FROM node:22-alpine

COPY --from=builder /opt/src/cloudcost-server/node_modules /opt/app/cloudcost/node_modules
COPY --from=builder /opt/src/cloudcost-server/dist /opt/app/cloudcost/dist
COPY cloudcost-server/config.json /opt/app/cloudcost/config.json
COPY package.json /opt/app/cloudcost/package.json

WORKDIR /opt/app/cloudcost

CMD [ "dist/App.js" ]