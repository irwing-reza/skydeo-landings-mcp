FROM docker.io/cloudflare/sandbox:0.12.4 AS sandbox-runtime

FROM node:22-bookworm-slim

COPY --from=sandbox-runtime /container-server/sandbox /sandbox

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/git-askpass-readonly.sh /usr/local/bin/git-askpass-readonly
COPY scripts/prepare-readonly-repository.sh /usr/local/bin/prepare-readonly-repository
COPY scripts/apply-landing-headline.mjs /usr/local/bin/apply-landing-headline
COPY scripts/snapshot-repository-tree.sh /usr/local/bin/snapshot-repository-tree
COPY scripts/restore-repository-tree.sh /usr/local/bin/restore-repository-tree
COPY scripts/repository-preview-proxy.mjs /usr/local/bin/repository-preview-proxy
RUN chmod 0555 /usr/local/bin/git-askpass-readonly \
  /usr/local/bin/prepare-readonly-repository \
  /usr/local/bin/apply-landing-headline \
  /usr/local/bin/snapshot-repository-tree \
  /usr/local/bin/restore-repository-tree \
  /usr/local/bin/repository-preview-proxy

WORKDIR /workspace
EXPOSE 4321

ENTRYPOINT ["/sandbox"]
