# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
#
# Starts Isaac Sim headless, streaming over WebRTC, with the Duck Lab XR bridge
# (tools/isaac/exts/ducklab.isaac_bridge) enabled. Runs detached and returns;
# Isaac Sim's log is in %USERPROFILE%\.nvidia-omniverse\logs\Kit\Isaac-Sim.
#
#   powershell -File tools/isaac/start-isaac-sim.ps1 [-IsaacSim <install dir>] [extra Kit arguments]
#
# Isaac Sim 4.5 (the standalone zip, apps\isaacsim.exp.full.streaming.kit) or
# 2022.2 (the Omniverse Launcher's, apps\omni.isaac.sim.headless.webrtc.kit).
# The install is -IsaacSim, else ISAAC_SIM_PATH, else the newest 4.5 under
# D:\Omniverse, C:\isaacsim or Downloads, else the newest 2022.2 under the
# Launcher's package folders.
#
# Isaac Sim 4.5 asks its user to accept NVIDIA's Omniverse licence once: run its
# isaac-sim.bat in a terminal and answer Yes. This script never accepts it for you.
# Its web server would take port 8011 (or any free one from 8000 to 8100): this
# pins it to 8211, as in 2022.2, where Duck Lab XR's ?isaac looks first. The first
# start after a new install or a driver change compiles the RTX shaders, which
# took 43 minutes on an RTX 3070 with driver 580.88; later starts reuse them.
param([string]$IsaacSim = $env:ISAAC_SIM_PATH, [Parameter(ValueFromRemainingArguments = $true)] [string[]]$KitArgs = @())
$ErrorActionPreference = 'Stop'
if (-not $IsaacSim) {
  $standalone = @('D:\Omniverse', 'C:\isaacsim', "$env:USERPROFILE\Downloads") | Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Directory -ErrorAction SilentlyContinue } |
    Where-Object { Test-Path (Join-Path $_.FullName 'apps\isaacsim.exp.full.streaming.kit') } | Sort-Object Name -Descending
  $launcher = @("$env:LOCALAPPDATA\ov\pkg", 'D:\Omniverse\pkg', 'C:\Omniverse\pkg') | Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem $_ -Directory -Filter 'isaac_sim-2022.2*' -ErrorAction SilentlyContinue } | Sort-Object Name -Descending
  $IsaacSim = @($standalone) + @($launcher) | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $IsaacSim -or -not (Test-Path "$IsaacSim\kit\kit.exe")) { throw 'Isaac Sim not found: pass -IsaacSim <install dir> or set ISAAC_SIM_PATH' }
$exts = Join-Path $PSScriptRoot 'exts'
if (Test-Path "$IsaacSim\apps\isaacsim.exp.full.streaming.kit") {
  $accepted = (Test-Path "$IsaacSim\kit\EULA_ACCEPTED") -and ((Get-Content "$IsaacSim\kit\EULA_ACCEPTED" -TotalCount 1) -match '^(y|yes|1)$')
  if (-not $accepted -and $env:OMNI_KIT_ACCEPT_EULA -notmatch '^(y|yes|1)$') {
    throw "Isaac Sim 4.5 needs its user to accept NVIDIA's Omniverse licence first: run $IsaacSim\isaac-sim.bat in a terminal once and answer Yes."
  }
  $app = "$IsaacSim\apps\isaacsim.exp.full.streaming.kit"
  $KitArgs = @('--/exts/omni.services.transport.server.http/port=8211') + $KitArgs
} else {
  $app = "$IsaacSim\apps\omni.isaac.sim.headless.webrtc.kit"
}
$arguments = @("`"$app`"", '--ext-folder', "`"$IsaacSim\apps`"", '--ext-folder', "`"$exts`"", '--enable', 'ducklab.isaac_bridge', '--no-window') + $KitArgs
$process = Start-Process -FilePath "$IsaacSim\kit\kit.exe" -ArgumentList $arguments -WorkingDirectory $IsaacSim -WindowStyle Hidden -PassThru
Write-Output "Isaac Sim started (process $($process.Id)) from $IsaacSim ($(Split-Path $app -Leaf))"
Write-Output 'Ready when http://127.0.0.1:8211/ducklab/status answers (the first start of a new version compiles shaders: several minutes).'
