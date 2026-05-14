# 构建 + 打包 + 签名 MSIX。每次改了 Rust 代码或 manifest 后跑一次。
#
# 步骤:
#   1. cargo build --release  -> target\release\marina_context_menu.dll
#   2. 收集 DLL + manifest + assets 到 build\staging\
#   3. MakeAppx.exe pack       -> build\MarinaContextMenu.msix
#   4. SignTool.exe sign       -> 同一个 MSIX (in-place)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot | Split-Path -Parent
Set-Location $root

$SDK = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64'
$makeAppx = Join-Path $SDK 'MakeAppx.exe'
$signTool = Join-Path $SDK 'SignTool.exe'

if (-not (Test-Path $makeAppx)) {
    throw "MakeAppx.exe not found at $makeAppx — check Windows 10/11 SDK install"
}
if (-not (Test-Path $signTool)) {
    throw "SignTool.exe not found at $signTool — check Windows 10/11 SDK install"
}

$pfx = Join-Path $root 'dev-cert.pfx'
if (-not (Test-Path $pfx)) {
    throw "dev-cert.pfx missing. Run .\scripts\dev-cert.ps1 first."
}

Write-Host "[1/4] cargo build --release" -ForegroundColor Cyan
cargo build --release
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

$staging = Join-Path $root 'build\staging'
Write-Host "[2/4] Staging files to $staging" -ForegroundColor Cyan
if (Test-Path $staging) {
    Remove-Item $staging -Recurse -Force
}
New-Item $staging -ItemType Directory | Out-Null

Copy-Item "$root\target\release\marina_context_menu.dll" $staging
Copy-Item "$root\target\release\marina-context-menu-host.exe" $staging
Copy-Item "$root\package\AppxManifest.xml" $staging
Copy-Item "$root\package\assets" $staging -Recurse

$msix = Join-Path $root 'build\MarinaContextMenu.msix'

Write-Host "[3/4] MakeAppx pack -> $msix" -ForegroundColor Cyan
& $makeAppx pack /d $staging /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx pack failed" }

Write-Host "[4/4] SignTool sign" -ForegroundColor Cyan
# RFC 3161 时间戳:即使 dev-cert.pfx 在 2029-05-12 到期,已分发的 MSIX 签名
# 依旧有效(时间戳服务在签名当下打上的时间戳证明"这签名是在证书有效期内
# 做的")。否则证书过期一刻,所有已装 MSIX 都会被 Add-AppxPackage 视为
# NotValid,新装失败 + 已装重启后 Explorer 加载 DLL 失败。
& $signTool sign /f $pfx /p marina-dev /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 $msix
if ($LASTEXITCODE -ne 0) { throw "SignTool sign failed" }

Write-Host ""
Write-Host "Done. Next:" -ForegroundColor Green
Write-Host "  .\scripts\install.ps1   # install MSIX and restart explorer"
