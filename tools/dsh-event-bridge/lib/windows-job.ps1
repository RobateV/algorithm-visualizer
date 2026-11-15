param([Parameter(Mandatory=$true)][string]$NodePath,
      [Parameter(Mandatory=$true)][string]$EntryPath,
      [Parameter(Mandatory=$true)][string]$PatchPath)
$ErrorActionPreference = 'Stop'
# Legacy manual entry; the runner compiles the same trusted source without a PowerShell host.
Add-Type -Path (Join-Path $PSScriptRoot 'windows-job.cs')
try { exit ([LocalDshJob]::Run($NodePath,$EntryPath,$PatchPath)) }
catch { [Console]::Error.WriteLine('LOCAL_DSH_JOB_FAILED: launch containment failed'); exit 1 }
