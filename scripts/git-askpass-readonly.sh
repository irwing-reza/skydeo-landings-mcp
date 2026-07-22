#!/bin/sh
set -eu

case "${1:-}" in
  *Username*)
    printf '%s\n' 'x-access-token'
    ;;
  *Password*)
    : "${REPOSITORY_CHECKOUT_TOKEN:?Repository checkout credential is unavailable}"
    printf '%s\n' "${REPOSITORY_CHECKOUT_TOKEN}"
    ;;
  *)
    exit 1
    ;;
esac
