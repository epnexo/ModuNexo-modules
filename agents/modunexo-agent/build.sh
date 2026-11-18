#!/usr/bin/env sh
set -eu

target="${1:-linux/arm64}"
output="${2:-./dist}"
mkdir -p "$output"
docker buildx build --platform "$target" --target export --output "type=local,dest=$output" -f Containerfile .
