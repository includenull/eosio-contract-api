FROM node:24-bookworm AS sidecar-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake g++ git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY native/ship-sidecar ./native/ship-sidecar
RUN cmake -S native/ship-sidecar -B native/ship-sidecar/build \
    && cmake --build native/ship-sidecar/build --config Release -j

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

COPY --from=sidecar-builder /src/native/ship-sidecar/build/ship-sidecar /home/application/app/native/ship-sidecar/build/ship-sidecar

ENV NODE_ENV production
EXPOSE 9000
