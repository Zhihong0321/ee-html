<#
.SYNOPSIS
  Push a folder of HTML files to the host as one app.

.EXAMPLE
  $env:HOST="https://your-app.up.railway.app"; $env:API_KEY="xxx"
  ./scripts/push.ps1 -Dir ./my-app-dir -Slug my-app -Name "My App"
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$Slug = "",
  [string]$Name = ""
)

$ErrorActionPreference = "Stop"

$Host_ = $env:HOST
$ApiKey = $env:API_KEY
if (-not $Host_) { throw "Set `$env:HOST to your host base URL" }
if (-not $ApiKey) { throw "Set `$env:API_KEY" }

if (-not (Test-Path (Join-Path $Dir "index.html"))) {
  throw "$Dir must contain index.html at its root."
}

$zip = Join-Path ([System.IO.Path]::GetTempPath()) ("bundle_" + [guid]::NewGuid().ToString("N") + ".zip")
Compress-Archive -Path (Join-Path $Dir "*") -DestinationPath $zip -Force

try {
  $form = @{ bundle = Get-Item $zip }
  if ($Slug) { $form["slug"] = $Slug }
  if ($Name) { $form["name"] = $Name }

  Invoke-RestMethod -Uri "$Host_/api/apps" -Method Post `
    -Headers @{ Authorization = "Bearer $ApiKey" } `
    -Form $form | ConvertTo-Json -Depth 5
}
finally {
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
}
