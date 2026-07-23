#!/bin/sh
set -eu

: "${REPOSITORY_PAGE_PATH:?Repository page path is unavailable}"
: "${REPOSITORY_TREE_SHA:?Repository tree SHA is unavailable}"

case "${REPOSITORY_PAGE_PATH}" in
  src/domains/*)
    ;;
  *)
    echo "Repository page path is outside the landing source boundary" >&2
    exit 64
    ;;
esac
case "${REPOSITORY_TREE_SHA}" in
  *[!0-9a-f]*|'')
    echo "Repository tree SHA is invalid" >&2
    exit 64
    ;;
esac

workspace=/workspace/repository
git -C "${workspace}" read-tree "${REPOSITORY_TREE_SHA}"
git -C "${workspace}" checkout-index --all --force
actual_tree=$(git -C "${workspace}" write-tree)
if [ "${actual_tree}" != "${REPOSITORY_TREE_SHA}" ]; then
  echo "Repository tree restoration could not be verified" >&2
  exit 65
fi
printf '%s\n' "${actual_tree}"
