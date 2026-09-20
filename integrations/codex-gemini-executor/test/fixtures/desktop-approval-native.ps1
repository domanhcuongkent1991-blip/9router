$ErrorActionPreference = 'Stop'
$root = Join-Path $env:NINEROUTER_TEST_SCRATCH_ROOT ('approval native ' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\..\scripts\Set-DesktopApprovalCanarySafe.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'writer_parse_failed' }
foreach ($name in @('ConvertTo-CanaryNativeArgument', 'Invoke-CanaryNative', 'Invoke-CanaryVerifier', 'Assert-CanaryGuard')) {
    $helper = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    . ([scriptblock]::Create($helper.Extent.Text))
}
$node = 'C:\Program Files\nodejs\node.exe'
$runner = Join-Path $root 'runner with spaces.mjs'
[IO.File]::WriteAllText($runner, @'
const mode = process.argv[2];
process.stderr.write('PRIVATE_NATIVE_STDERR_SENTINEL\n');
if (mode === 'args') console.log(JSON.stringify(process.argv.slice(3)));
else if (mode === 'hang') setTimeout(() => {}, 5000);
else {
  console.log(JSON.stringify(mode === 'pass' ? {status:'pass'} : {status:'HOLD',error:mode}));
  process.exitCode = mode === 'pass' ? 0 : 1;
}
'@)
$expected = @('C:\path with spaces\canary.json', 'embedded"quote', 'C:\path with spaces\', 'x\"y', 'a&b', '$(unchanged)')
$result = Invoke-CanaryNative -Executable $node -Arguments (@($runner, 'args') + $expected)
if ($result.exitCode -ne 0) { throw 'native_warning_caused_failure' }
$actual = $result.stdout | ConvertFrom-Json
if ($actual.Count -ne $expected.Count) { throw 'argument_count_mismatch' }
for ($i=0; $i -lt $expected.Count; $i++) { if ($actual[$i] -cne $expected[$i]) { throw 'argument_corrupted' } }
if (($result | ConvertTo-Json) -match 'PRIVATE_NATIVE_STDERR_SENTINEL') { throw 'stderr_leaked' }
Invoke-CanaryVerifier @('pass')
$passed = 3
foreach ($code in @('router_identity_unavailable', 'host_identity_changed', 'fixture_layout_invalid')) {
    try { Invoke-CanaryVerifier @($code); throw 'invalid_gate_accepted' }
    catch { if ($_.Exception.Message -cne $code) { throw 'native_reason_lost' } }
    $passed++
}
try { Invoke-CanaryVerifier @('UNTRUSTED_REASON_SENTINEL'); throw 'invalid_gate_accepted' }
catch { if ($_.Exception.Message -cne 'canary_verification_failed') { throw 'untrusted_reason_leaked' } }
$passed++
try { $null = Invoke-CanaryNative -Executable $node -Arguments @($runner,'hang') -TimeoutMs 100; throw 'hung_child_accepted' }
catch { if ($_.Exception.Message -cne 'canary_child_timeout') { throw } }
$passed++
# Reproduce the Apply precondition path without closing Desktop, bypassing a
# production guard, or executing a transaction. All replacements are test-local.
$DescriptorPath = Join-Path $root 'canary.json'
[IO.File]::WriteAllText($DescriptorPath, (@{root=$root}|ConvertTo-Json))
function Assert-DesktopClosed { }
function Get-CimInstance { @() }
[IO.File]::WriteAllText($runner, "process.stderr.write('PRIVATE_NATIVE_STDERR_SENTINEL'); console.log(JSON.stringify({status:'HOLD',error:'router_identity_unavailable'})); process.exitCode=1;")
try { Assert-CanaryGuard; throw 'unavailable_router_accepted' }
catch { if ($_.Exception.Message -cne 'router_identity_unavailable' -or $script:phase -ne 'verifying_canary') { throw 'guard_diagnostic_lost' } }
$passed++
function Assert-DesktopClosed { throw 'desktop_still_running' }
try { Assert-CanaryGuard; throw 'open_desktop_accepted' }
catch { if ($_.Exception.Message -cne 'desktop_still_running' -or $script:phase -ne 'checking_desktop') { throw 'desktop_guard_diagnostic_lost' } }
$passed++
@{passed=$passed;failed=0} | ConvertTo-Json -Compress
