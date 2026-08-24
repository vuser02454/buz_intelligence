# ==============================================================================
# Crowd Heatmap & Business Intelligence Platform - PowerShell Launcher
# ==============================================================================

param (
    [string]$Command = "dev",
    [int]$Port = 8000,
    [string]$Host = "127.0.0.1",
    [switch]$Help
)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

# Find python
$PythonExec = "python"
if (Test-Path "$ProjectDir\.venv\Scripts\python.exe") {
    $PythonExec = "$ProjectDir\.venv\Scripts\python.exe"
} elseif (Test-Path "$ProjectDir\venv\Scripts\python.exe") {
    $PythonExec = "$ProjectDir\venv\Scripts\python.exe"
}

if ($Help -or $Command -eq "help") {
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "   Crowd Heatmap & Business Intelligence Platform" -ForegroundColor Cyan
    Write-Host "======================================================================" -ForegroundColor Cyan
    Write-Host "Available commands:"
    Write-Host "  .\run.ps1                  Start full-stack dev server"
    Write-Host "  .\run.ps1 -Port 8080       Start dev server on custom port"
    Write-Host "  .\run.ps1 setup            Install dependencies and run migrations"
    Write-Host "  .\run.ps1 migrate          Apply database migrations"
    Write-Host "  .\run.ps1 test             Run test suite"
    Write-Host "  .\run.ps1 train            Train recommendation model"
    Write-Host "  .\run.ps1 superuser        Create Django admin superuser"
    Write-Host "  .\run.ps1 check            Run Django configuration check"
    Write-Host "  .\run.ps1 clean            Clean bytecode cache"
    exit 0
}

switch ($Command) {
    "dev" { & $PythonExec run.py dev --host $Host --port $Port }
    "start" { & $PythonExec run.py dev --host $Host --port $Port }
    "server" { & $PythonExec run.py dev --host $Host --port $Port }
    "run" { & $PythonExec run.py dev --host $Host --port $Port }
    "setup" { & $PythonExec run.py setup }
    "migrate" { & $PythonExec run.py migrate }
    "test" { & $PythonExec run.py test }
    "train" { & $PythonExec run.py train }
    "superuser" { & $PythonExec run.py superuser }
    "check" { & $PythonExec run.py check }
    "clean" { & $PythonExec run.py clean }
    Default { & $PythonExec run.py $Command }
}
