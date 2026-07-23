#!/bin/sh
set -eu

: "${REPOSITORY_PAGE_PATH:?Repository page path is unavailable}"

case "${REPOSITORY_PAGE_PATH}" in
  src/domains/*)
    ;;
  *)
    echo "Repository page path is outside the landing source boundary" >&2
    exit 64
    ;;
esac

workspace=/workspace/repository
changed=$(git -C "${workspace}" status --short --untracked-files=all)
changed_path=$(printf '%s\n' "${changed}" | cut -c4-)
changed_lines=$(printf '%s\n' "${changed}" | wc -l | tr -d ' ')
if [ "${changed_lines}" != "1" ] || [ "${changed_path}" != "${REPOSITORY_PAGE_PATH}" ]; then
  echo "The workspace contains changes outside the resolved landing page" >&2
  exit 65
fi

git -C "${workspace}" add -- "${REPOSITORY_PAGE_PATH}"
tree_sha=$(git -C "${workspace}" write-tree)
printf '%s\n' "${tree_sha}"
