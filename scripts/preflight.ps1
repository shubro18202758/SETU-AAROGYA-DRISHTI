$ErrorActionPreference = "Stop"

Write-Host "Checking Docker..."
docker version | Out-Null

Write-Host "Checking Compose file..."
docker compose config | Out-Null

Write-Host "Checking NVIDIA GPU visibility..."
docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
