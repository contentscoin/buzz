[CmdletBinding()]
param(
    [string]$Target = "x86_64-pc-windows-msvc",
    [string]$ArchivePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-GeneratedPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Leaf
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a generated path outside the repository: $fullPath"
    }
    if ([IO.Path]::GetFileName($fullPath) -ne $Leaf) {
        throw "Refusing to modify unexpected generated path: $fullPath"
    }
    return $fullPath
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$manifestPath = Join-Path $repoRoot "scripts/windows-managed-git.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json

if ($manifest.schema -ne 1) {
    throw "Unsupported managed Git manifest schema: $($manifest.schema)"
}
if ($Target -ne "x86_64-pc-windows-msvc") {
    throw "The pinned MinGit asset supports only x86_64-pc-windows-msvc; got $Target"
}
if ($manifest.sha256 -notmatch '^[0-9a-f]{64}$') {
    throw "Managed Git manifest has an invalid SHA-256"
}

$cacheRoot = Join-Path $repoRoot ".cache/windows-managed-git"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
    $archive = Join-Path $cacheRoot $manifest.asset
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        Invoke-WebRequest -Uri $manifest.url -OutFile $archive -UseBasicParsing
    }
} else {
    $archive = [IO.Path]::GetFullPath($ArchivePath)
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        throw "Managed Git archive does not exist: $archive"
    }
}

$actualSha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualSha256 -ne $manifest.sha256) {
    throw "Managed Git archive SHA-256 mismatch: expected $($manifest.sha256), got $actualSha256"
}

$stageLeaf = "stage-$([Guid]::NewGuid().ToString('N'))"
$stageRoot = Assert-GeneratedPath -Path (Join-Path $cacheRoot $stageLeaf) -Root $repoRoot -Leaf $stageLeaf
$runtimeOutput = Assert-GeneratedPath `
    -Path (Join-Path $repoRoot "desktop/src-tauri/resources/fmg-managed-git") `
    -Root $repoRoot `
    -Leaf "fmg-managed-git"
$binariesDir = Join-Path $repoRoot "desktop/src-tauri/binaries"
$launcherOutput = Join-Path $binariesDir "git-$Target.exe"
$launcherSource = Join-Path $repoRoot "scripts/windows-managed-git-launcher.rs"
$launcherTemp = Join-Path $cacheRoot "git-$Target-$([Guid]::NewGuid().ToString('N')).exe"
$runtimeInstalled = $false

try {
    Expand-Archive -LiteralPath $archive -DestinationPath $stageRoot

    foreach ($required in @("cmd/git.exe", "LICENSE.txt", "etc/package-versions.txt")) {
        $requiredPath = Join-Path $stageRoot $required
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Pinned MinGit archive is missing required file: $required"
        }
    }

    $notice = @"
FMG Buzz managed Git runtime

Distribution: $($manifest.distribution) $($manifest.version)
Release tag: $($manifest.tag)
Unmodified binary archive: $($manifest.url)
Archive SHA-256: $($manifest.sha256)
Corresponding source: $($manifest.source)
MinGit build tooling: $($manifest.build_tools)
License: $($manifest.license)

The upstream LICENSE.txt and etc/package-versions.txt files are included in
this directory. FMG Buzz adds only this provenance notice to the extracted
MinGit archive.
"@
    Set-Content -LiteralPath (Join-Path $stageRoot "FMG-MINGIT-SOURCE.txt") -Value $notice -Encoding utf8

    New-Item -ItemType Directory -Path $binariesDir -Force | Out-Null
    & rustc $launcherSource `
        --edition=2021 `
        --target $Target `
        -C opt-level=z `
        -C panic=abort `
        -C strip=symbols `
        -o $launcherTemp
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $launcherTemp -PathType Leaf)) {
        throw "Failed to compile the managed Git launcher for $Target"
    }

    if (Test-Path -LiteralPath $runtimeOutput) {
        Remove-Item -LiteralPath $runtimeOutput -Recurse -Force
    }
    Move-Item -LiteralPath $stageRoot -Destination $runtimeOutput
    $runtimeInstalled = $true
    Copy-Item -LiteralPath $launcherTemp -Destination $launcherOutput -Force
} finally {
    if (-not $runtimeInstalled -and (Test-Path -LiteralPath $stageRoot)) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
    if (Test-Path -LiteralPath $launcherTemp) {
        Remove-Item -LiteralPath $launcherTemp -Force
    }
}

Write-Host "Staged $($manifest.distribution) $($manifest.version) and launcher for $Target"
