FROM docker.io/cloudflare/sandbox:0.12.4 AS sandbox-runtime

FROM node:22-bookworm-slim

COPY --from=sandbox-runtime /container-server/sandbox /sandbox

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY scripts/git-askpass-readonly.sh /usr/local/bin/git-askpass-readonly
COPY scripts/prepare-readonly-repository.sh /usr/local/bin/prepare-readonly-repository
COPY scripts/apply-landing-headline.mjs /usr/local/bin/apply-landing-headline.mjs
COPY scripts/apply-landing-edits.mjs /usr/local/bin/apply-landing-edits
COPY scripts/snapshot-repository-tree.sh /usr/local/bin/snapshot-repository-tree
COPY scripts/restore-repository-tree.sh /usr/local/bin/restore-repository-tree
COPY scripts/repository-preview-proxy.mjs /usr/local/bin/repository-preview-proxy
COPY scripts/verify-repository-preview.mjs /usr/local/bin/verify-repository-preview
RUN chmod 0555 /usr/local/bin/git-askpass-readonly \
  /usr/local/bin/prepare-readonly-repository \
  /usr/local/bin/apply-landing-edits \
  /usr/local/bin/snapshot-repository-tree \
  /usr/local/bin/restore-repository-tree \
  /usr/local/bin/repository-preview-proxy \
  /usr/local/bin/verify-repository-preview

WORKDIR /workspace
EXPOSE 4321

ENTRYPOINT ["/sandbox"]
