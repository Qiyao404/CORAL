# CORAL v1.1.0 - Windows PowerShell production launcher
# Builds server + web, then starts the backend in production mode.

$ErrorActionPreference = 'Continue'
Set-Location -Path "$PSScriptRoot/.."

Write-Host "[BUILD] server..." -ForegroundColor Cyan
npm run build:server
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[BUILD] web..." -ForegroundColor Cyan
npm run build:web
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "[START] CORAL backend (production)..." -ForegroundColor Green
npm run start -w packages/server
