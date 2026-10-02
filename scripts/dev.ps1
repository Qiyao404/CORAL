# CORAL v1.1.0 - Windows PowerShell dev launcher
# Usage: ./scripts/dev.ps1
# Starts server (3001) + web (5173) concurrently.

$ErrorActionPreference = 'Continue'
Set-Location -Path "$PSScriptRoot/.."

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  CORAL v1.1.0  -  DEV launcher" -ForegroundColor Green
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

# Check Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js not found (need Node 18+)" -ForegroundColor Red
    exit 1
}
$nodeVersion = node --version
Write-Host "[OK] Node $nodeVersion" -ForegroundColor Cyan

# Check Python
$pythonCmd = $null
foreach ($cmd in @('python', 'py', 'python3')) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        $pythonCmd = $cmd
        break
    }
}
if ($pythonCmd) {
    $pyVer = & $pythonCmd --version 2>&1
    Write-Host "[OK] $pyVer" -ForegroundColor Cyan
} else {
    Write-Host "[WARN] Python not found (policy-scraper / policy-to-post / information-filter need it)" -ForegroundColor Yellow
}

# npm install if missing
if (-not (Test-Path './node_modules')) {
    Write-Host "[INFO] First run: installing npm deps..." -ForegroundColor Yellow
    npm install
}

# .env check
if (-not (Test-Path './.env')) {
    Write-Host "[ERROR] missing .env file" -ForegroundColor Red
    exit 1
}

# Ensure data/ skills/
foreach ($dir in @('./data', './skills')) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

Write-Host ""
Write-Host "[START] backend :3001  +  web :5173  (concurrent)" -ForegroundColor Green
Write-Host "[HINT]  Ctrl+C to stop" -ForegroundColor Cyan
Write-Host ""

npm run dev
