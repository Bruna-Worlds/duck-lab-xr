# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
param([string]$Out, [int]$Height, [Parameter(ValueFromRemainingArguments)][string[]]$Files)
Add-Type -AssemblyName System.Drawing
$imgs = @($Files | ForEach-Object { [Drawing.Image]::FromFile((Resolve-Path $_)) })
$ws = @($imgs | ForEach-Object { [int]($_.Width * $Height / $_.Height) })
$total = [int]0
foreach ($w in $ws) { $total += $w + 10 }
$o = New-Object Drawing.Bitmap $total, $Height
$g = [Drawing.Graphics]::FromImage($o)
$g.Clear([Drawing.Color]::Gray)
$g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$x = 0
for ($i = 0; $i -lt $imgs.Count; $i++) { $g.DrawImage($imgs[$i], $x, 0, $ws[$i], $Height); $x += $ws[$i] + 10 }
$o.Save((Join-Path (Get-Location) $Out), [Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $o.Dispose(); $imgs | ForEach-Object { $_.Dispose() }
