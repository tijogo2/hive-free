<#
  publish.ps1 - publica o FreeHive no GitHub e imprime as URLs de instalacao em uma linha.

  Faz: build -> (README com a URL do repo) -> git init/commit -> push -> tag v<versao>.

  Funciona em dois modos:
    - com GitHub CLI (gh) autenticado: cria o repo (-Create) e publica a release com zip + sha256
    - so com git: empurra branch e tag; a release voce cria no site (o script imprime o link)

  Uso:
    powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Repo tijogo2/hive-free
    powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Repo tijogo2/hive-free -Create
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [switch]$Create,
  [switch]$Private,
  [switch]$SkipRelease,
  [string]$Branch = 'main',
  [string]$AuthorName,
  [string]$AuthorEmail
)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Version = (Get-Content -LiteralPath (Join-Path $Root 'VERSION') -Raw).Trim()
$Tag     = "v$Version"

function Write-Step($m) { Write-Host $m -ForegroundColor Cyan }
function Write-Warn2($m) { Write-Host $m -ForegroundColor Yellow }
function Write-Bad($m)  { Write-Host $m -ForegroundColor Red }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Bad 'git nao encontrado no PATH.'; exit 1 }
$HasGh = [bool](Get-Command gh -ErrorAction SilentlyContinue)
if (-not $HasGh -and $Create) {
  Write-Bad 'Sem gh nao da para criar o repositorio. Crie no site (New repository) e rode sem -Create.'
  exit 1
}

Push-Location $Root
try {
  # identidade do commit: usa a global se existir, senao define local pelo owner do repo
  $owner = ($Repo -split '/')[0]
  if (-not $AuthorName)  { $AuthorName  = if (git config user.name)  { $null } else { $owner } }
  if (-not $AuthorEmail) { $AuthorEmail = if (git config user.email) { $null } else { "$owner@users.noreply.github.com" } }

  Write-Step '1/5 build'
  & (Join-Path $Root 'build.ps1') | Out-Host

  Write-Step '2/5 README + git'
  $readmePath  = Join-Path $Root 'README.md'
  $readme      = Get-Content -LiteralPath $readmePath -Raw
  $readmeFixed = $readme.Replace('SEU-USUARIO/free-hive', $Repo)
  if ($readmeFixed -ne $readme) {
    [IO.File]::WriteAllText($readmePath, $readmeFixed, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "   README aponta agora para $Repo"
  }

  if (-not (Test-Path (Join-Path $Root '.git'))) { git init -b $Branch | Out-Null }
  if ($AuthorName)  { git config user.name  $AuthorName }
  if ($AuthorEmail) { git config user.email $AuthorEmail }

  git add -A
  if (git status --porcelain) { git commit -m "FreeHive $Version" | Out-Null } else { Write-Host '   nada novo para commitar' }

  Write-Step '3/5 remote + push'
  $remotes = @(git remote)
  if ($remotes -notcontains 'origin') {
    if ($Create) {
      $visibility = if ($Private) { '--private' } else { '--public' }
      gh repo create $Repo $visibility --source . --remote origin --push
    } else {
      git remote add origin "https://github.com/$Repo.git"
    }
  }
  if (-not $Create) {
    Write-Host "   empurrando para https://github.com/$Repo (o Git Credential Manager pode abrir o navegador)"
    git push -u origin $Branch
  }

  Write-Step '4/5 tag'
  if (@(git tag --list $Tag) -contains $Tag) {
    Write-Host "   tag $Tag ja existe"
  } else {
    git tag -a $Tag -m "FreeHive $Version"
  }
  git push origin $Tag

  Write-Step '5/5 release'
  if ($SkipRelease) {
    Write-Host '   pulada (-SkipRelease)'
  } elseif (-not $HasGh) {
    Write-Warn2 '   sem gh: publique a release no site e anexe os 2 arquivos de dist\'
    Write-Warn2 "   https://github.com/$Repo/releases/new?tag=$Tag"
    Write-Warn2 "   anexos: dist\free-hive-$Version.zip  e  dist\free-hive-$Version.zip.sha256"
  } else {
    $zip  = Join-Path $Root "dist\free-hive-$Version.zip"
    $sha  = "$zip.sha256"
    $notes = "FreeHive $Version`n`nInstale em uma linha:`n  irm https://raw.githubusercontent.com/$Repo/$Tag/install.ps1 | iex`n`nmacOS/Linux:`n  curl -fsSL https://raw.githubusercontent.com/$Repo/$Tag/install.sh | bash"
    $exists = $false
    try { gh release view $Tag --repo $Repo | Out-Null; $exists = $true } catch { $exists = $false }
    if ($exists) { gh release upload $Tag $zip $sha --repo $Repo --clobber }
    else { gh release create $Tag $zip $sha --repo $Repo --title "FreeHive $Version" --notes $notes }
  }

  $rawMain   = "https://raw.githubusercontent.com/$Repo/$Branch/install.ps1"
  $rawPinned = "https://raw.githubusercontent.com/$Repo/$Tag/install.ps1"
  $rawSh     = "https://raw.githubusercontent.com/$Repo/$Branch/install.sh"

  Write-Host ''
  Write-Host 'Repositorio : ' -NoNewline; Write-Host "https://github.com/$Repo" -ForegroundColor Green
  Write-Host 'Instalar (Windows):' -ForegroundColor Yellow
  Write-Host "  irm $rawPinned | iex"
  Write-Host 'Instalar (Linux/macOS/Git Bash):' -ForegroundColor Yellow
  Write-Host "  curl -fsSL $rawSh | bash"
  Write-Host 'Prompt para outro agente DeepAI:' -ForegroundColor Yellow
  Write-Host "  Instale o plugin FreeHive rodando no PowerShell: irm $rawPinned | iex"
} finally {
  Pop-Location
}
