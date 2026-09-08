[CmdletBinding()]
param([string]$ProjectPath = (Split-Path $PSScriptRoot), [switch]$Json)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$tool = Join-Path $project '.codex\tools\bin\gitleaks.exe'
if ((Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash -ne '17157E2EE8B76FC8B1D8BEE607A250E34B8A8023C8BC81822D4B5EE4D78FCB7C') { throw 'Gitleaks hash mismatch' }
$scratch = Join-Path 'C:\tmp\CodexScratch\2026-09-07-mcp-security-tools' ('secrets-' + [guid]::NewGuid().ToString('N'))
$snapshot = Join-Path $scratch 'source'
$null = New-Item -ItemType Directory -Path $snapshot
$paths = @(& git -C $project diff --name-only HEAD --)
if ($LASTEXITCODE -ne 0) { throw 'Git diff failed' }
$paths += @(& git -C $project ls-files --others --exclude-standard)
if ($LASTEXITCODE -ne 0) { throw 'Git untracked listing failed' }
$count = 0
foreach ($relative in @($paths | Sort-Object -Unique)) {
    if ($relative -like '.codex/*') { continue }
    $source = [IO.Path]::GetFullPath((Join-Path $project $relative))
    if (!$source.StartsWith($project + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source escapes project' }
    if (!(Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    if ((Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing linked scan input' }
    $destination = Join-Path $snapshot $relative
    $null = New-Item -ItemType Directory -Path (Split-Path $destination) -Force
    Copy-Item -LiteralPath $source -Destination $destination
    $count++
}
if (!$count) { throw 'No changed files to scan' }
$report = Join-Path $scratch 'gitleaks.json'
$env:GOMAXPROCS = '2'
& $tool dir $snapshot --redact=100 --no-banner --no-color --ignore-gitleaks-allow --timeout 120 --report-format json --report-path $report 2>$null | Out-Null
$code = $LASTEXITCODE
if ($code -notin @(0,1)) { throw "Gitleaks execution failed ($code)" }
$findings = @((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json))
$result = [ordered]@{status=$(if($code -eq 0){'pass'}else{'fail'});scope='changed-file snapshot, not full Git history';files=$count;report=$report;findings=@($findings | ForEach-Object { @{rule=$_.RuleID;file=$_.File;line=$_.StartLine} })}
if($Json){$result | ConvertTo-Json -Depth 5}else{[pscustomobject]$result}
exit $code
