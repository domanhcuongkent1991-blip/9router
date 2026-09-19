$ErrorActionPreference = 'Stop'
$root = Join-Path $env:NINEROUTER_TEST_SCRATCH_ROOT ('approval-writer-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
. (Join-Path $PSScriptRoot '..\..\scripts\Set-NineRouterBootstrapSafe.ps1')
# Load only the catalog helper from the AST. Never execute the writer's top level.
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\..\scripts\Set-DesktopApprovalCanarySafe.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'writer_parse_failed' }
$helper = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Copy-PreviewCatalog' }, $true)
. ([scriptblock]::Create($helper.Extent.Text))
$config = Join-Path $root 'config.toml'
$preview = Join-Path $root 'preview'
[IO.Directory]::CreateDirectory($preview) | Out-Null
[IO.File]::WriteAllText((Join-Path $root 'catalog.json'), '{"models":[]}')
[IO.File]::WriteAllText($config, 'model_catalog_json = "catalog.json"')
$before = Get-ConfigHash $config
Copy-PreviewCatalog $config $preview
if ((Get-ConfigHash $config) -ne $before) { throw 'source_config_changed' }
if ([IO.File]::ReadAllText((Join-Path $preview 'catalog.json')) -cne '{"models":[]}') { throw 'catalog_copy_wrong' }
$passed = 1
foreach ($bad in @('../catalog.json', 'nested/catalog.json', 'C:catalog.json')) {
    [IO.File]::WriteAllText($config, ('model_catalog_json = "' + $bad + '"'))
    try { Copy-PreviewCatalog $config $preview; throw 'unsafe_catalog_allowed' }
    catch { if ($_.Exception.Message -ne 'preview_catalog_path_unsupported') { throw } }
    $passed++
}
[IO.File]::WriteAllText($config, '[mcp_servers.example]' + [Environment]::NewLine + 'model_catalog_json = "missing.json"')
Copy-PreviewCatalog $config $preview
$passed++
@{passed=$passed;failed=0} | ConvertTo-Json -Compress
