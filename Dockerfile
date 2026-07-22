FROM docker.io/cloudflare/sandbox:0.12.4 AS sandbox-runtime

FROM node:22-bookworm-slim

COPY --from=sandbox-runtime /container-server/sandbox /sandbox

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
EXPOSE 4321

ENTRYPOINT ["/sandbox"]

