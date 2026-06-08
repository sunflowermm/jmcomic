param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$AgtRoot
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PyDest = Join-Path $AgtRoot 'subserver\pyserver\apis\jmcomic'
$PluginDest = Join-Path $AgtRoot 'core\jm-Core\plugin'

New-Item -ItemType Directory -Force -Path $PyDest, $PluginDest | Out-Null

$pyFiles = @(
    '__init__.py',
    'config_loader.py',
    'deploy_sync.py',
    'download_service.py',
    'default_config.yaml',
    'requirements.txt',
    'README.md'
)

foreach ($file in $pyFiles) {
    $src = Join-Path $RepoRoot $file
    $dest = Join-Path $PyDest $file
    if ((Resolve-Path $src).Path -eq (Resolve-Path $dest -ErrorAction SilentlyContinue).Path) { continue }
    Copy-Item -Force $src $dest
}

Copy-Item -Force (Join-Path $RepoRoot 'plugin\车牌.js') (Join-Path $PluginDest '车牌.js')

Write-Host "已部署 Python 扩展 -> $PyDest"
Write-Host "已部署 QQ 插件     -> $PluginDest\车牌.js"
Write-Host ''
Write-Host '下一步:'
Write-Host "  cd $AgtRoot\subserver\pyserver"
Write-Host '  uv pip install -r apis/jmcomic/requirements.txt'
Write-Host '  # 重启子服务与主服务'
