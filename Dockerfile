FROM node:18 as build

WORKDIR /app

ADD package.json /app
ADD package-lock.json /app

RUN npm install

COPY src /app/src
ADD tsconfig.json /app

RUN npx tsc

FROM node:18

WORKDIR /app

ADD package.json /app
ADD package-lock.json /app

RUN npm ci --production

COPY --from=build /app/dist /app/dist

RUN ln -s /data /app/data
ENV NODE_ENV=production

VOLUME [ "/data" ]

CMD [ "node", "/app/dist/index.js" ]
