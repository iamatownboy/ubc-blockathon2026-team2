#!/usr/bin/env bash
# A clean submission bundle: tracked source and lockfiles only.
#
# The working checkout carries ~1 GB of node_modules, Hardhat artifacts and an
# old Next.js build. None of it is tracked, so `git archive` is the whole
# answer — it exports exactly what .gitignore left in, and nothing has to be
# deleted from the working tree to produce it.
#
#   ./make-submission.sh              → ../languagetoken-submission.zip
#   ./make-submission.sh /tmp/out.zip → that path instead
set -euo pipefail

cd "$(dirname "$0")"
out="${1:-../languagetoken-submission.zip}"

if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes are NOT included — commit first if you want them" >&2
fi

git archive --format=zip -o "$out" HEAD
echo "wrote $out"
unzip -l "$out" | tail -1
echo
echo "The reviewer installs dependencies themselves:"
echo "  npm install            # optional: the live coach SDK only"
echo "  cd contracts && npm install && npx hardhat test"
echo "  node server/server.js"
