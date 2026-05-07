#!/usr/bin/env sh
set -eu

echo "Checking Docker..."
docker version >/dev/null

echo "Checking Compose file..."
docker compose config >/dev/null

echo "Checking NVIDIA GPU visibility..."
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
