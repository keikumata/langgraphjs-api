#!/bin/bash
set -e # Exit on error
set -x # Print commands before execution

rm -rf dist
tsc --outDir dist
tsc --module nodenext --outDir dist/cli -d src/cli/spawn.mts

cp src/graph/parser/schema/types.template.mts dist/src/graph/parser/schema
rm -rf dist/src/graph/parser/schema/types.template.mjs

mv dist/src/* dist
rm -rf dist/src dist/tests