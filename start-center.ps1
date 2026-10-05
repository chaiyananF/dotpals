# Open the session center prototype with its own local profile.
$ErrorActionPreference = 'Stop'
$centerRoot = $PSScriptRoot
$centerProfile = Join-Path $centerRoot '.dotpals-center'
$centerDesktop = Join-Path $centerProfile 'desktop'
$centerElectron = Join-Path $centerRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $centerElectron)) {
  $centerElectron = Join-Path $env:USERPROFILE '.dotpals\node_modules\electron\dist\electron.exe'
}
if ($env:DOTPALS_ELECTRON) { $centerElectron = $env:DOTPALS_ELECTRON }
if (-not (Test-Path -LiteralPath $centerElectron)) {
  throw 'Electron is not installed. Run npm install in this checkout, or set DOTPALS_ELECTRON.'
}
New-Item -ItemType Directory -Path $centerDesktop -Force | Out-Null
$centerEnvironment = @{}
foreach ($centerName in @('DOTPALS_HOME', 'DOTPALS_PORT', 'DOTPALS_USER_DATA', 'ELECTRON_RUN_AS_NODE')) {
  $centerEnvironment[$centerName] = [Environment]::GetEnvironmentVariable($centerName, 'Process')
}
try {
  $env:DOTPALS_HOME = $centerProfile
  $env:DOTPALS_PORT = '5176'
  $env:DOTPALS_USER_DATA = $centerDesktop
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $centerMain = Join-Path $centerRoot 'desktop\main.js'
  $centerProcess = Start-Process -FilePath $centerElectron -ArgumentList @(('"' + $centerMain + '"'), '--dashboard', '--tasks') -WorkingDirectory $centerRoot -PassThru
  Write-Output "Session center opened (PID $($centerProcess.Id)): http://127.0.0.1:5176/dashboard"
} finally {
  foreach ($centerName in $centerEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($centerName, $centerEnvironment[$centerName], 'Process')
  }
}
