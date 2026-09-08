[CmdletBinding()]
param([string]$ProjectPath = (Split-Path $PSScriptRoot), [switch]$Json)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$tool = Join-Path $project '.codex\tools\bin\osv-scanner.exe'
if ((Get-FileHash -LiteralPath $tool -Algorithm SHA256).Hash -ne '25E42F5EF6711FD8C0FB45390972205891DD44C6BD02AC93F0F63E8E98D9BFB6') { throw 'OSV hash mismatch' }
$scratch = Join-Path 'C:\tmp\CodexScratch\2026-09-07-mcp-security-tools' ('deps-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $scratch
$report = Join-Path $scratch 'osv.json'
$arguments = @('scan','source','--no-call-analysis=all','--no-resolve','--format=json','--verbosity=error',"--output-file=$report")
$rootLock = 'package-lock.json'
if (!(Test-Path -LiteralPath (Join-Path $project $rootLock))) { $rootLock = 'node_modules/.package-lock.json' }
foreach ($relative in @($rootLock,'tests/package-lock.json','integrations/codex-gemini-executor/package-lock.json')) {
    $path = Join-Path $project $relative
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing lockfile: $relative" }
    $arguments += "--lockfile=package-lock.json:$path"
}
$env:GOMAXPROCS = '2'
& $tool @arguments 2>$null | Out-Null
$code = $LASTEXITCODE
if ($code -notin @(0,1)) { throw "OSV execution failed ($code); coverage limited" }
$data = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
$findings = @(foreach($result in $data.results) { foreach($package in $result.packages) {
    if (@($package.vulnerabilities).Count) { [ordered]@{source=$result.source.path;package=$package.package.name;version=$package.package.version;ids=@($package.vulnerabilities | ForEach-Object {$_.id})} }
} })
$result = [ordered]@{status=$(if($code -eq 0){'pass'}else{'fail'});scope='test/companion lockfiles and local app inventory; no call analysis';appInventory=$rootLock;report=$report;findings=$findings}
if($Json){$result | ConvertTo-Json -Depth 8}else{[pscustomobject]$result}
exit $code
