# CORAL v1.1.0 E2E smoke test (Windows PowerShell)
# Usage: ./scripts/e2e/smoke.ps1 [baseUrl]

param(
    [string]$BaseUrl = "http://localhost:3001"
)

$ErrorActionPreference = 'Continue'
$pass = 0
$fail = 0

function Test-Step {
    param([string]$Name, [scriptblock]$Block)
    try {
        & $Block
        Write-Host "  [PASS] $Name" -ForegroundColor Green
        $script:pass++
    } catch {
        Write-Host "  [FAIL] $Name : $_" -ForegroundColor Red
        $script:fail++
    }
}

Write-Host ""
Write-Host "===================================================="
Write-Host "  CORAL v1.1.0 E2E Smoke Test ($BaseUrl)"
Write-Host "===================================================="
Write-Host ""

Write-Host "[1] Health check"
Test-Step "GET /api/health" {
    $r = Invoke-RestMethod "$BaseUrl/api/health"
    if ($r.status -ne 'healthy') { throw "status != healthy" }
}

Test-Step "GET /api/config (should be dashscope coding)" {
    $r = Invoke-RestMethod "$BaseUrl/api/config"
    if (-not ($r.llmBaseUrl -like '*coding.dashscope*')) {
        throw "llmBaseUrl not dashscope: $($r.llmBaseUrl)"
    }
    if ($r.llmModel -notmatch 'kimi') {
        Write-Host "    [WARN] llmModel not kimi: $($r.llmModel)" -ForegroundColor Yellow
    }
    Write-Host "    Model: $($r.llmModel) @ $($r.llmBaseUrl)" -ForegroundColor Cyan
}

Test-Step "GET /api/stats" {
    $r = Invoke-RestMethod "$BaseUrl/api/stats"
    if ($null -eq $r.skills) { throw "no skills field" }
    Write-Host "    Skills: $($r.skills.total) total / $($r.skills.available) available" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[2] Skill CRUD"
Test-Step "GET /api/skills" {
    $r = Invoke-RestMethod "$BaseUrl/api/skills"
    if ($r.total -lt 1) { throw "no skills" }
    Write-Host "    Total skills: $($r.total)" -ForegroundColor Cyan
}

Test-Step "GET /api/skills?source=builtin" {
    $r = Invoke-RestMethod "$BaseUrl/api/skills?source=builtin"
    if ($r.total -lt 1) { throw "no builtin" }
    Write-Host "    Builtin: $($r.total)" -ForegroundColor Cyan
}

Test-Step "GET /api/skills?source=user" {
    $r = Invoke-RestMethod "$BaseUrl/api/skills?source=user"
    Write-Host "    User: $($r.total)" -ForegroundColor Cyan
}

Test-Step "GET /api/skills/policy-scraper (should have md_path output)" {
    $r = Invoke-RestMethod "$BaseUrl/api/skills/policy-scraper"
    if ($r.version -ne '1.1.0') { throw "policy-scraper version != 1.1.0 ($($r.version))" }
    Write-Host "    policy-scraper v$($r.version)" -ForegroundColor Cyan
}

Test-Step "DELETE builtin skill without confirm = 403" {
    try {
        Invoke-RestMethod -Method Delete "$BaseUrl/api/skills/policy-scraper" -ErrorAction Stop
        throw "did not block!"
    } catch {
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode.value__ -eq 403) {
            return # expected
        }
        throw
    }
}

Write-Host ""
Write-Host "[3] Company Profile"
Test-Step "GET /api/company-profile" {
    $r = Invoke-RestMethod "$BaseUrl/api/company-profile"
    if (-not $r.companyName) { throw "no companyName" }
    Write-Host "    Profile v$($r.version): $($r.companyName)" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "[4] Skill Builder"
Test-Step "POST /api/skill-builder/sessions" {
    $body = '{"userId":"smoke-tester"}'
    $r = Invoke-RestMethod -Method Post -ContentType "application/json" -Body $body "$BaseUrl/api/skill-builder/sessions"
    if (-not $r.sessionId) { throw "no sessionId" }
    Write-Host "    Session: $($r.sessionId)" -ForegroundColor Cyan
    $script:builderSessionId = $r.sessionId
}

if ($builderSessionId) {
    Test-Step "GET session detail" {
        $r = Invoke-RestMethod "$BaseUrl/api/skill-builder/sessions/$builderSessionId"
        if (-not $r.sessionId) { throw "no sessionId" }
        if ($r.status -ne 'collecting') { throw "status != collecting: $($r.status)" }
    }

    Test-Step "DELETE session" {
        $r = Invoke-RestMethod -Method Delete "$BaseUrl/api/skill-builder/sessions/$builderSessionId"
        if (-not $r.success) { throw "cancel failed" }
    }
}

Write-Host ""
Write-Host "[5] LLM configs (should have dashscope active)" 
Test-Step "GET /api/llm/configs" {
    $r = Invoke-RestMethod "$BaseUrl/api/llm/configs"
    if (-not $r.activeProfileId) { throw "no active" }
    $active = $r.items | Where-Object { $_.isActive }
    if (-not ($active.baseUrl -like '*dashscope*')) {
        throw "active not dashscope: $($active.baseUrl)"
    }
    Write-Host "    Active: $($active.name) ($($active.model))" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "===================================================="
Write-Host "  Pass: $pass  Fail: $fail" -ForegroundColor $(if ($fail -eq 0) { 'Green' } else { 'Red' })
Write-Host "===================================================="

if ($fail -gt 0) { exit 1 }
