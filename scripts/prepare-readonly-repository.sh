#!/bin/sh
set -eu

: "${REPOSITORY_BASE_SHA:?Repository base SHA is unavailable}"
: "${REPOSITORY_CHECKOUT_TOKEN:?Repository checkout credential is unavailable}"
: "${REPOSITORY_CHECKOUT_URL:?Repository checkout URL is unavailable}"

case "${REPOSITORY_BASE_SHA}" in
  *[!0-9a-f]*|'')
    echo "Repository base SHA is invalid" >&2
    exit 64
    ;;
esac

if [ "${#REPOSITORY_BASE_SHA}" -ne 40 ]; then
  echo "Repository base SHA is invalid" >&2
  exit 64
fi

case "${REPOSITORY_CHECKOUT_URL}" in
  https://github.com/*.git)
    ;;
  *)
    echo "Repository checkout URL is invalid" >&2
    exit 64
    ;;
esac

workspace=/workspace/repository

if [ -d "${workspace}/.git" ]; then
  actual_remote=$(git -C "${workspace}" remote get-url origin)
  actual_sha=$(git -C "${workspace}" rev-parse --verify HEAD)
  if [ "${actual_remote}" != "${REPOSITORY_CHECKOUT_URL}" ] \
    || [ "${actual_sha}" != "${REPOSITORY_BASE_SHA}" ] \
    || git -C "${workspace}" symbolic-ref -q HEAD >/dev/null 2>&1; then
    echo "Existing repository workspace does not match the configured detached checkout" >&2
    exit 65
  fi

  printf '%s\n' "${actual_sha}"
  exit 0
fi

if [ -e "${workspace}" ]; then
  echo "Repository workspace path is occupied" >&2
  exit 65
fi

mkdir -p "${workspace}"
git -C "${workspace}" init --quiet
git -C "${workspace}" remote add origin "${REPOSITORY_CHECKOUT_URL}"

GIT_ASKPASS=/usr/local/bin/git-askpass-readonly \
GIT_TERMINAL_PROMPT=0 \
git -C "${workspace}" -c credential.helper= fetch --quiet --no-tags --depth=1 \
  origin "${REPOSITORY_BASE_SHA}"

unset REPOSITORY_CHECKOUT_TOKEN
git -C "${workspace}" -c advice.detachedHead=false checkout --quiet --detach \
  "${REPOSITORY_BASE_SHA}"

actual_remote=$(git -C "${workspace}" remote get-url origin)
actual_sha=$(git -C "${workspace}" rev-parse --verify HEAD)
if [ "${actual_remote}" != "${REPOSITORY_CHECKOUT_URL}" ] \
  || [ "${actual_sha}" != "${REPOSITORY_BASE_SHA}" ] \
  || git -C "${workspace}" symbolic-ref -q HEAD >/dev/null 2>&1; then
  echo "Repository checkout verification failed" >&2
  exit 66
fi

printf '%s\n' "${actual_sha}"
