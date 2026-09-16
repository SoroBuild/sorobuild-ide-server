#!/bin/sh
set -eu
mkdir -p /tmp/project
cp -R /input/. /tmp/project/
mkdir -p /tmp/cargo
# rustfmt only needs workspace metadata and source files. Copying the full
# dependency registry on every save dominates formatting time.
if [ "${2:-}" != "fmt" ]; then
  cp -R /usr/local/cargo/registry /tmp/cargo/registry
fi
export CARGO_HOME=/tmp/cargo
cd /tmp/project
"$@"
if [ "$2" = "build" ]; then
  for artifact in /tmp/target/wasm32v1-none/release/*.wasm; do
    [ -f "$artifact" ] || continue
    printf '\nSOROBUILD_ARTIFACT:%s:' "$(basename "$artifact")"
    base64 -w 0 "$artifact"
    printf '\n'
  done
fi

if [ "$2" = "fmt" ]; then
  find . -name '*.rs' -type f | while IFS= read -r file; do
    printf '\nSOROBUILD_FORMAT:'
    printf '%s' "${file#./}" | base64 -w 0
    printf ':'
    base64 -w 0 "$file"
    printf '\n'
  done
fi
