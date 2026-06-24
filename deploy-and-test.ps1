# deploy-and-test.ps1
# Usage: .\deploy-and-test.ps1
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$GAS_URL       = "https://script.google.com/macros/s/AKfycbx7Jd7pDS4pi_ug95KMV8uweRRx_zmuXNvHjhVMUZ5Rmd-QOpr1OlIkdkFx5-Nhte-U/exec"
$DEPLOYMENT_ID = "AKfycbx7Jd7pDS4pi_ug95KMV8uweRRx_zmuXNvHjhVMUZ5Rmd-QOpr1OlIkdkFx5-Nhte-U"
$SCRIPT_DIR    = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " LINE Reservation System: Deploy & Test" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# STEP 1: clasp push
Write-Host ""
Write-Host "[STEP 1] Pushing code to GAS..." -ForegroundColor Yellow
Set-Location $SCRIPT_DIR
$pushOut = npx clasp push --force 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: clasp push failed." -ForegroundColor Red
    Write-Host $pushOut
    exit 1
}
Write-Host "  -> Push OK" -ForegroundColor Green

# STEP 2: clasp deploy
Write-Host ""
Write-Host "[STEP 2] Updating deployment to latest version..." -ForegroundColor Yellow
$ts = Get-Date -Format "yyyyMMdd_HHmm"
$deployOut = npx clasp deploy --deploymentId $DEPLOYMENT_ID -d "auto_$ts" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: clasp deploy failed." -ForegroundColor Red
    Write-Host $deployOut
    exit 1
}
$versionLine = ($deployOut | Select-String "@\d+").ToString().Trim()
Write-Host "  -> Deploy OK: $versionLine" -ForegroundColor Green

Write-Host "  -> Waiting 5s for deployment to propagate..." -ForegroundColor Gray
Start-Sleep -Seconds 5

# STEP 3: Run tests via API
Write-Host ""
Write-Host "[STEP 3] Running automated tests (up to 3 min)..." -ForegroundColor Yellow
$body = '{"action":"runTests"}'
try {
    $resp = Invoke-RestMethod -Uri $GAS_URL -Method Post -Body $body -ContentType "text/plain;charset=utf-8" -TimeoutSec 180
} catch {
    Write-Host "ERROR: Test execution failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# STEP 4: Print results
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Test Results" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

if (-not $resp.success) {
    Write-Host "ERROR: $($resp.message)" -ForegroundColor Red
    exit 1
}

$sum = $resp.data.summary
$res = $resp.data.results

Write-Host ""
Write-Host ("  Executed : " + $sum.executedAt)
Write-Host ("  Duration : " + $sum.elapsedSec + " sec")
Write-Host ("  Total    : " + $sum.total)
Write-Host ("  Passed   : " + $sum.passed) -ForegroundColor Green

if ($sum.failed -gt 0) {
    Write-Host ("  Failed   : " + $sum.failed) -ForegroundColor Red
    Write-Host ""
    Write-Host "  Failed tests:" -ForegroundColor Red
    $res | Where-Object { -not $_.passed } | ForEach-Object {
        Write-Host ("    x " + $_.name) -ForegroundColor Red
        if ($_.error) {
            Write-Host ("      -> " + $_.error) -ForegroundColor DarkRed
        }
    }
    Write-Host ""
    Write-Host "  Evidence saved to sheet: 'Test Results'" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host ("  Failed   : 0") -ForegroundColor Green
    Write-Host ""
    Write-Host "  All tests passed! Ready for through-test." -ForegroundColor Green
    Write-Host "  Evidence saved to sheet: 'Test Results'" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
