FROM node:24-alpine

RUN adduser --disabled-password application && \
  mkdir -p /home/application/app/ && \
  chown -R application:application /home/application

USER application

WORKDIR /home/application/app

COPY yarn.lock .
COPY package.json .

RUN yarn install --frozen-lockfile --ignore-scripts

COPY . .

RUN yarn install --frozen-lockfile

ENV NODE_ENV production
EXPOSE 9000
