<#
  build.ps1 - regera o instalador self-contained e o zip distribuivel do FreeHive.

  Entrada : src/free-hive/*.ts  (+ VERSION)
  Saida   : install.ps1, install.sh (extensao embutida em base64)
            dist/free-hive-<versao>.zip, dist/free-hive-<versao>.zip.sha256

  Uso: powershell -ExecutionPolicy Bypass -File .\build.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -Raw).Trim()
$SrcDir  = Join-Path $Root 'src\free-hive'
$DistDir = Join-Path $Root 'dist'

if (-not (Test-Path -LiteralPath (Join-Path $SrcDir 'index.ts'))) {
  throw "Fonte nao encontrada: $SrcDir\index.ts"
}

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }

Write-Step "FreeHive build $Version"

# 1. zip da extensao (com a pasta free-hive como raiz)
if (-not (Test-Path -LiteralPath $DistDir)) { New-Item -ItemType Directory -Path $DistDir -Force | Out-Null }
$ZipPath = Join-Path $DistDir "free-hive-$Version.zip"
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }

# ZipArchive manual: o CreateFromDirectory do .NET Framework grava '\' nos caminhos, o que
# quebra o unzip em Linux/macOS. Aqui as entradas usam sempre '/'.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fsStream = [IO.File]::Open($ZipPath, [IO.FileMode]::Create)
try {
  $archive = New-Object IO.Compression.ZipArchive($fsStream, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in (Get-ChildItem -LiteralPath $SrcDir -Recurse -File | Sort-Object FullName)) {
      $rel   = $file.FullName.Substring($SrcDir.Length).TrimStart('\', '/')
      $entry = $archive.CreateEntry("free-hive/$($rel.Replace('\', '/'))", [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = $file.LastWriteTime
      $stream = $entry.Open()
      try {
        $bytes = [IO.File]::ReadAllBytes($file.FullName)
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    }
  } finally { $archive.Dispose() }
} finally { $fsStream.Dispose() }

$zipBytes = [IO.File]::ReadAllBytes($ZipPath)
$zipHash  = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$ZipPath.sha256" -Value ("{0}  {1}" -f $zipHash, (Split-Path -Leaf $ZipPath)) -Encoding ASCII

# 2. base64 em linhas de 100 chars (evita linha gigante em alguns editores)
$b64 = [Convert]::ToBase64String($zipBytes)
$sb = New-Object System.Text.StringBuilder
for ($i = 0; $i -lt $b64.Length; $i += 100) {
  $len = [Math]::Min(100, $b64.Length - $i)
  [void]$sb.AppendLine($b64.Substring($i, $len))
}
$b64Lines = $sb.ToString()

# 3. injeta nos templates
function Expand-Template {
  param([string]$TemplatePath, [string]$OutputPath, [string]$Payload, [bool]$UnixNewlines)

  $text = Get-Content -LiteralPath $TemplatePath -Raw
  $text = $text.Replace('__VERSION__', $Version)
  $text = $text.Replace('__FREEHIVE_B64_PAYLOAD__', $Payload.TrimEnd())
  if ($UnixNewlines) { $text = $text -replace "`r`n", "`n" }
  [IO.File]::WriteAllText($OutputPath, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Expand-Template -TemplatePath (Join-Path $Root 'templates\install.ps1.tmpl') -OutputPath (Join-Path $Root 'install.ps1') -Payload $b64Lines -UnixNewlines $false
Expand-Template -TemplatePath (Join-Path $Root 'templates\install.sh.tmpl')  -OutputPath (Join-Path $Root 'install.sh')  -Payload $b64Lines -UnixNewlines $true

Write-Step ("zip   : dist/free-hive-$Version.zip ({0:N0} KB)" -f ($zipBytes.Length / 1KB))
Write-Step "sha256: $zipHash"
Write-Step ("ps1   : install.ps1 ({0:N0} KB)" -f ((Get-Item (Join-Path $Root 'install.ps1')).Length / 1KB))
Write-Step ("sh    : install.sh ({0:N0} KB)" -f ((Get-Item (Join-Path $Root 'install.sh')).Length / 1KB))
Write-Host ''
Write-Host 'OK. Commit install.ps1 / install.sh / dist e publique (publish.ps1).' -ForegroundColor Green
