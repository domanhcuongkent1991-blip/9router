# safe-cleanup-template.ps1 — template dọn dẹp an toàn (bài học sự cố 16/10/2026)
#
# Sự cố gốc: robocopy /MIR không có /XJ đi XUYÊN junction worktree→repo chính,
# xoá rỗng node_modules của repo (44.000 file). Template này ép 3 lớp phòng:
#   Lớp 1: quét reparse point (junction/symlink) trong vùng sắp dọn — thấy là DỪNG
#   Lớp 2: KHÔNG xoá thẳng — move vào vùng chờ E:\_XOA\<ngày>\<loại>\ kèm note
#   Lớp 3: smoke check repo sau khi dọn — phát hiện hư hại trong 1 phút
#
# Cách dùng:
#   .\scripts\safe-cleanup-template.ps1 -Target "D:\something\merge-xxx" -CleanupType "01-cache-build"
#   .\scripts\safe-cleanup-template.ps1 -Target ... -SmokeCheckRepo "D:\9Router"
#   Chỉ xem mà không move: thêm -WhatIfMode
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$CleanupType = "03-chua-ro",
  [string]$VaultRoot = "E:\_XOA",
  [string]$SmokeCheckRepo = "",
  [switch]$WhatIfMode
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8  # emit UTF-8 stdout (PS 5.1 defaults to console codepage)
$Target = (Resolve-Path $Target -ErrorAction Stop).Path
$log = @()
function Log($m) { $line = "$(Get-Date -Format o) $m"; $log += $line; Write-Host $line }

# ---- LỚP 1: quét junction/symlink — bẫy của robocopy/rm -rf ----
Log "Lớp 1: quét reparse point trong $Target ..."
$reparse = Get-ChildItem -LiteralPath $Target -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue
if ($reparse) {
  Log "PHÁT HIỆN $($reparse.Count) JUNCTION/SYMLINK — KHÔNG ĐỘNG vào vùng này bằng tool đệ quy:"
  $reparse | ForEach-Object {
    $linkTarget = $_.Target
    Log ("  - " + $_.FullName + "  ==>  " + $linkTarget)
  }
  Log "Cách xử lý: xoá chính junction (Remove-Item -Force trên đúng đường junction, KHÔNG -Recurse) trước, hoặc bỏ qua vùng chứa nó."
  exit 2   # mã lỗi riêng để caller/hook nhận ra
}
Log "  sạch reparse point."

# ---- LỚP 2: move vào vùng chờ E:\_XOA (mặc định, KHÔNG xoá thẳng) ----
if ($WhatIfMode) { Log "WhatIfMode: dừng trước lớp 2."; exit 0 }
$day = Get-Date -Format "yyyy-MM-dd"
$destDir = Join-Path $VaultRoot "$day\$CleanupType"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$name = Split-Path $Target -Leaf
$dest = Join-Path $destDir $name
Log "Lớp 2: move $Target -> $dest"
Move-Item -LiteralPath $Target -Destination $dest
$note = Join-Path $destDir "!$name.txt"
@"
Nguồn gốc: $Target
Ngày vào vùng chờ: $day
Lý do: (điền — do ai/chạy gì tạo ra, vì sao nghi là rác)
Kết quả kiểm tra: (điền — đã quét reparse point sạch, đã smoke check)
"@ | Out-File $note -Encoding utf8
Log "  đã ghi note: $note"

# ---- LỚP 3: smoke check repo sống sót ----
if ($SmokeCheckRepo) {
  Log "Lớp 3: smoke check $SmokeCheckRepo"
  $fail = $false
  Push-Location $SmokeCheckRepo
  git status --porcelain *> $null
  if ($LASTEXITCODE -ne 0) { Log "  FAIL: git hỏng"; $fail = $true } else { Log "  git OK" }
  Pop-Location
  $nm = Join-Path $SmokeCheckRepo "node_modules"
  if (Test-Path $nm) {
    $n = (Get-ChildItem $nm -Directory -ErrorAction SilentlyContinue).Count
    if ($n -lt 50) { Log "  FAIL: node_modules chỉ còn $n package (thường ~470+)"; $fail = $true }
    else { Log "  node_modules OK ($n package)" }
  }
  if ($fail) { Log "SMOKE CHECK FAIL — xem lại ngay vùng vừa dọn ở $destDir"; exit 3 }
  Log "  smoke check PASS"
}
Log "XONG an toàn."
