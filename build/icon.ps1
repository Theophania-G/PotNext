# icon.ps1 - generate PotNext app icon (icon.ico multi-size + icon.png 256)
# ASCII-only on purpose; run under Windows PowerShell 5.1
param([string]$OutDir = (Split-Path -Parent $MyInvocation.MyCommand.Path))
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = "Stop"

function New-IconBitmap([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"
  $g.PixelOffsetMode = "HighQuality"

  # rounded square path
  $r = [Math]::Max(2, [Math]::Round($S * 0.22))
  $w = $S - 1
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
  $path.AddArc($w - $r * 2, 0, $r * 2, $r * 2, 270, 90)
  $path.AddArc($w - $r * 2, $w - $r * 2, $r * 2, $r * 2, 0, 90)
  $path.AddArc(0, $w - $r * 2, $r * 2, $r * 2, 90, 90)
  $path.CloseFigure()

  # dark gradient body
  $rect = New-Object System.Drawing.Rectangle(0, 0, $S, $S)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 32, 39, 50),
    [System.Drawing.Color]::FromArgb(255, 13, 16, 22),
    45)
  $g.FillPath($brush, $path)

  # hairline border for light backgrounds
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(52, 255, 255, 255), [Math]::Max(1, $S / 160))
  $g.DrawPath($pen, $path)

  # white play triangle, optically centered
  $a = $S * 0.27
  $cx = $S * 0.53
  $cy = $S * 0.5
  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon(@(
    (New-Object System.Drawing.PointF([float]($cx - $a * 0.78), [float]($cy - $a))),
    (New-Object System.Drawing.PointF([float]($cx - $a * 0.78), [float]($cy + $a))),
    (New-Object System.Drawing.PointF([float]($cx + $a * 0.92), [float]$cy))
  ))
  $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)), $tri)

  $g.Dispose()
  return $bmp
}

function Save-Icon($Bitmaps, [string]$Path) {
  $entries = @()
  foreach ($b in $Bitmaps) {
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $entries += ,@([int]$b.Width, $ms.ToArray())
    $ms.Dispose()
  }
  $fs = [System.IO.File]::Create($Path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0)                  # ICONDIR.reserved
  $bw.Write([uint16]1)                  # type: icon
  $bw.Write([uint16]$entries.Count)
  $offset = 6 + 16 * $entries.Count
  foreach ($e in $entries) {
    $dim = $e[0]
    $data = $e[1]
    $bw.Write([byte]$(if ($dim -ge 256) { 0 } else { $dim }))  # width
    $bw.Write([byte]$(if ($dim -ge 256) { 0 } else { $dim }))  # height
    $bw.Write([byte]0)                                          # palette
    $bw.Write([byte]0)                                          # reserved
    $bw.Write([uint16]1)                                        # planes
    $bw.Write([uint16]32)                                       # bpp
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$offset)
    $offset += $data.Length
  }
  foreach ($e in $entries) { $bw.Write($e[1]) }
  $bw.Close()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$bitmaps = @()
foreach ($s in $sizes) { $bitmaps += ,(New-IconBitmap $s) }
$bitmaps[-1].Save((Join-Path $OutDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
Save-Icon $bitmaps (Join-Path $OutDir "icon.ico")
foreach ($b in $bitmaps) { $b.Dispose() }
Write-Output ("icons written to " + $OutDir)
