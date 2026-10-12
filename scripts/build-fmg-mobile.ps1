param(
    [string]$FlutterSdk = '',
    [string]$Version = '1.2.2',
    [ValidateRange(1, 2147483647)][int]$BuildNumber = 5
)
$ErrorActionPreference = 'Stop'
$fmgFlutter = if ($FlutterSdk) { Join-Path $FlutterSdk 'bin/flutter.bat' } else { 'flutter' }
$fmgRoot = Split-Path $PSScriptRoot -Parent
$fmgRequired = @(
    'BUZZ_ANDROID_UPLOAD_KEYSTORE_PATH', 'BUZZ_ANDROID_UPLOAD_KEYSTORE_PASSWORD',
    'BUZZ_ANDROID_UPLOAD_KEY_ALIAS', 'BUZZ_ANDROID_UPLOAD_KEY_PASSWORD'
)
foreach ($fmgName in $fmgRequired) {
    if (-not [Environment]::GetEnvironmentVariable($fmgName)) {
        throw "FMG 전용 릴리스 서명 환경변수가 필요합니다: $fmgName"
    }
}
if ($env:BUZZ_ANDROID_RELEASE_SIGNING -eq 'external') {
    throw '직접 설치할 FMG APK는 전용 릴리스 서명이 필요합니다.'
}
Push-Location (Join-Path $fmgRoot 'mobile')
try {
    & $fmgFlutter pub get
    if ($LASTEXITCODE -ne 0) { throw 'Flutter 의존성 설치에 실패했습니다.' }
    & $fmgFlutter build apk --release --no-pub --dart-define=FMG_CUSTOM=true `
        "--build-name=$Version" "--build-number=$BuildNumber" --target-platform=android-arm64
    if ($LASTEXITCODE -ne 0) { throw 'FMG Android APK 빌드에 실패했습니다.' }
    $fmgOutput = Join-Path $fmgRoot 'mobile/build/fmg-release'
    New-Item -ItemType Directory -Path $fmgOutput -Force | Out-Null
    Copy-Item -LiteralPath 'build/app/outputs/flutter-apk/app-release.apk' `
        -Destination (Join-Path $fmgOutput "FMG-Buzz-$Version-arm64.apk")
    Write-Output "FMG APK: $fmgOutput"
} finally {
    Pop-Location
}
