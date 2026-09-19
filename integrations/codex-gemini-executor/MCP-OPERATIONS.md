# nine-router-gemini vận hành và nâng cấp

MCP chỉ được đánh dấu `Ready for use` khi preflight, offline tests, runtime identity,
MCP handshake và một fixed read-only task đều đạt. `qualified-scoped-combination.json`
và `qualified-scoped-bootstrap.json` là evidence có identity; không chỉnh tay để bỏ qua
`scoped_*_not_qualified`.

Trạng thái mới nhất và đường dẫn evidence: [ACCEPTANCE-STATUS.md](ACCEPTANCE-STATUS.md).
Bootstrap chỉ cấp đúng task đọc marker cố định; không cấp quyền task tùy ý hoặc sửa
file. Preflight trả `readiness: HOLD` ngay cả khi các kiểm tra preflight đạt, vì
Desktop acceptance là một gate riêng. Registration Desktop hiện trỏ tới candidate
bootstrap và fixed read-only canary đã đạt; general qualification vẫn HOLD.

## Kiểm tra trước khi chạy

Từ thư mục companion:

```powershell
$env:NINEROUTER_TEST_SCRATCH_ROOT = 'C:\tmp\CodexScratch\2026-09-19-mcp-stability'
npm run test:preflight
npm test
npm run mcp:preflight
```

`NINEROUTER_TEST_SCRATCH_ROOT` chỉ dành cho test/rehearsal. Production runtime không
tự động fallback sang thư mục khác. Preflight chỉ in trạng thái credential presence,
không in API key.

## Khi nâng cấp 9Router

1. Giữ artifact/data checkpoint cũ; kiểm tra restore trên bản sao trước migration.
   Kiểm tra `/api/health` và `/api/compatibility` của đúng candidate được cấu hình.
2. Ghi version, build ID, contract version, model và provider vào runtime identity.
3. Tạo release immutable bằng `src/release-cli.js build` với file runtime identity.
4. Chạy offline suite, MCP protocol checks và fixed read-only canary.
5. Tạo qualification record mới cho đúng release và router build.
6. Giữ release/config cũ nếu một gate fail; không reuse record của build cũ.

Profile hiện cho phép đúng loopback `http://127.0.0.1:20128`; loopback khác,
localhost alias và LAN private đều bị từ chối. Không đổi port rồi vô hiệu hóa guard.
Chạy router candidate ở môi trường riêng với origin được duyệt, hoặc lên lịch
chuyển router có rollback sau khi job cũ kết thúc. `prepare-candidate.mjs` hiện ghim
target `0.5.81`; bản nâng cấp khác cần chốt target mới và test lại trước đóng gói.

## Đóng gói và kiểm tra candidate

Chạy từ `D:\9Router\integrations\codex-gemini-executor`. Các lệnh canary gọi model
thật, chỉ chạy khi được operator cho phép. Không tự retry sau failure.

```powershell
node scripts/prepare-candidate.mjs C:\Users\Admin\Documents\Codex\9router-gemini-runtime\candidates C:\Users\Admin\.codex\config.toml
```

Lấy chính xác `directory` từ JSON kết quả làm `$candidate`; không di chuyển candidate
sau đó vì đường dẫn nằm trong identity. Package đã được khóa read-only, dùng bản
dependency đang có, không download. Thuộc tính read-only chống ghi nhầm, không phải
cơ chế chống sửa bởi Admin; digest được kiểm tra trước/sau canary.

```powershell
$env:NINEROUTER_TEST_SCRATCH_ROOT = 'C:\tmp\CodexScratch\<task-id>'
Push-Location (Join-Path $candidate 'package')
npm test *> (Join-Path $env:NINEROUTER_TEST_SCRATCH_ROOT 'candidate-offline.log')
if ($LASTEXITCODE -ne 0) { throw 'Offline gate failed' }
Pop-Location
$env:NINEROUTER_CANARY_ROOT = 'C:\tmp\CodexScratch\<task-id>\live-new'
node (Join-Path $candidate 'package\scripts\candidate-canary.mjs') (Join-Path $candidate 'candidate.json')
if ($LASTEXITCODE -ne 0) { throw 'Live gate failed' }
node (Join-Path $candidate 'package\scripts\candidate-stdio.mjs') (Join-Path $candidate 'candidate.json') (Join-Path $env:NINEROUTER_TEST_SCRATCH_ROOT 'candidate-offline.log')
```

Lệnh stdio chỉ tạo bootstrap evidence sau khi snapshot tests và live report đạt.
Luôn xem `status: pass` trong report; exit 0 một mình không chứng minh hoàn tất.
Evidence mapping ghi recovery/scope-denial là kiểm tra offline; accept/decline của
script không thay thế Desktop UI approval. Giữ report và hash cùng candidate.

`release-cli build` chỉ tạo manifest, không đóng gói. Khi promote, CLI kiểm tra
`package/release-manifest.json` của snapshot và identity quan sát lại; không tính
provenance từ working tree mới rồi dùng chung với evidence cũ.

## Khi nâng cấp companion hoặc dependency

- Tính lại source digest và lock digest.
- Chạy full suite với scratch root đã probe.
- Chạy secret scan và dependency scan; ghi rõ `limited` nếu scanner không chạy được.
- Tạo manifest mới. Mọi thay đổi trong source, lockfile, model allowlist hoặc provider
  đều làm evidence cũ hết hiệu lực.

## Khi nâng cấp Codex CLI/App Server/Desktop

- Ghi absolute executable path, version và SHA-256; không fallback theo `PATH`.
- Với backend `legacy-app-server`, generate schema và chạy handshake/capability
  qualification cho executable thực sự được chạy. Backend `router-responses-v1`
  gọi HTTP trực tiếp nên CLI độc lập không nằm trong runtime model fingerprint.
  Desktop host/App Server vẫn phải được ghi version/hash trong host evidence và
  kiểm tra lại MCP discovery/elicitation khi Desktop cập nhật.
- Thoát Desktop trước khi dùng safe writer; giữ checkpoint config.
- Restart Desktop một lần, tạo task mới, kiểm tra `initialize`, `tools/list`, approval
  và fixed read-only canary.
- Nếu task mới không nạp tool hoặc approval timeout, rollback checkpoint và giữ nguyên
  release 9Router đang được xác nhận.

Safe writer legacy ngày 2026-09-12 yêu cầu `integrations/src/index.js` và
`manifest.json`; candidate mới dùng `package/src/index.js` và
`package/release-manifest.json`. Không truyền candidate mới vào writer cũ. Cần
preview/validation writer đúng layout qua App Server authority trước batch config;
chỉ ghi đúng entry, có checkpoint và rollback, Desktop đã thoát. Không sửa
`config.toml` bằng tay. Chỉ restart sau khi trạng thái MCP thực sự thay đổi.

### Chuyển registration sang bootstrap candidate

`scripts/Set-NineRouterBootstrapSafe.ps1` là writer cho layout candidate hiện tại.
Lệnh preview tạo transaction riêng dưới `Codex` checkpoints, ghi proposal private,
kiểm tra hash candidate và dùng App Server authority với `CODEX_HOME` cô lập. Nó
không sửa config:

```powershell
$candidate = 'C:\Users\Admin\Documents\Codex\9router-gemini-runtime\candidates\<candidate-id>'
pwsh -NoProfile -File .\scripts\Set-NineRouterBootstrapSafe.ps1 -CandidatePath $candidate
```

Chỉ dùng `-Apply` với `-PlanPath`, `-ExpectedPlanSha256` và
`-ExpectedConfigSha256` lấy từ chính preview. Writer chờ Desktop thoát, kiểm tra
App Server, owner lock, job state và router health ngay trước khi ghi. Chạy từ một
cửa sổ Windows PowerShell mở bên ngoài Desktop. Thoát Desktop hoàn toàn, rồi dùng
wrapper dưới đây để tạo preview với hash sau khi thoát và áp dụng một lần:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\9Router\integrations\codex-gemini-executor\scripts\Complete-NineRouterBootstrap.ps1 -CandidatePath $candidate -Apply
```

Chỉ mở lại Desktop khi lệnh báo `APPLIED_BOOTSTRAP_ONLY`. Nếu `HOLD`, dừng tại
transaction đó; không retry hoặc đổi endpoint/model/key. Helper được khởi chạy từ
Codex có thể chết cùng Desktop; `Start-Process -WindowStyle Hidden` không chứng minh
process tồn tại độc lập. Không dùng cách này để phối hợp shutdown. Tùy chọn chờ
`-WaitForDesktopExitSeconds` chỉ dùng trong shell ngoài Desktop; không tự tạo lại
preview nếu hash thay đổi trong lúc chờ.

`apply-started.json` và `apply-progress.json` ghi thời điểm/PID/giai đoạn, không có
config hay credential. Có started nhưng thiếu result và PID đã thoát là attempt
bị gián đoạn, không phải đang chờ. `configChanged` mô tả ghi bởi writer;
`configDiffersFromPreview` mô tả drift so với preview, có thể do writer bên ngoài.
Checkpoint `config.toml.before` được giữ trong transaction. Post-write validation
lỗi sẽ rollback một lần; nếu phát hiện
writer khác đã sửa file thì rollback bị từ chối và transaction phải được điều tra
thủ công. Không xóa job `running` cũ hoặc execution lock khi chưa xác minh process
owner. Bootstrap candidate chỉ cho fixed read-only marker task; chưa phải general
qualification và chưa phải Ready for use.

General qualification giữ `desktopGrantAccept` và `desktopGrantDeclineCancel` chưa
đạt cho đến khi có evidence của host thật. `session_id` resume không được hỗ trợ
ở scoped backend; status sau restart là đọc kết quả đã lưu, không phải resume task.

## Chẩn đoán nhanh

### Shell báo không có MCP nhưng Desktop vẫn gọi được

Kiểm tra Windows identity, thư mục profile thực và `CODEX_HOME` trước khi sửa
registration. Trên host này, shell sandbox chạy dưới `CodexSandboxOffline`, còn
App Server Desktop chạy dưới `Admin`. `USERPROFILE` trong shell có thể vẫn là
`C:\Users\Admin`; riêng biến này không chứng minh CLI đang đọc config của Admin.
`-c/--config` là ghi đè tùy chọn `key=value`, không phải đường dẫn file config.

Dùng đúng executable authority và đặt `CODEX_HOME` chỉ trong process kiểm tra;
khôi phục sau lệnh. Chỉ xuất các trường được chọn, không in toàn bộ JSON có env:

```powershell
$previousCodexHome = $env:CODEX_HOME
try {
    $env:CODEX_HOME = 'C:\Users\Admin\.codex'
    $mcpJson = & 'C:\Users\Admin\.codex\plugins\.plugin-appserver\codex.exe' mcp get nine-router-gemini --json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'MCP lookup failed in explicit Admin home' }
    $mcp = ($mcpJson -join "`n") | ConvertFrom-Json
    [pscustomobject]@{
        name = $mcp.name
        enabled = $mcp.enabled
        command = $mcp.transport.command
        entrypoint = $mcp.transport.args
        cwd = $mcp.transport.cwd
        runtimeRoot = $mcp.transport.env.NINEROUTER_RUNTIME_ROOT
    }
} finally {
    $env:CODEX_HOME = $previousCodexHome
}
```

Đối chiếu entrypoint/runtime root với candidate đã duyệt và kiểm tra tool/status
trong task Desktop. Không suy ra Desktop thiếu MCP từ CLI ở home khác; không đổi
profile toàn cục, reinstall hoặc restart để sửa một phép kiểm tra sai context.
CLI tìm thấy registration cũng chưa chứng minh approval UI hoặc general
qualification đạt. Sau update, xác minh version/hash của executable Desktop đang
chạy và authority riêng biệt; không mặc định hai bản luôn giống nhau.

| Mã/symptom | Xử lý |
| --- | --- |
| `scoped_bootstrap_not_qualified` | So sánh router build ID, source/lock digest, Node và model; tạo evidence mới. |
| `qualification_record_missing` | Kiểm tra runtime root/release path; không tạo record giả. |
| `app_server_incompatible` | Kiểm tra schema/handshake và đúng App Server executable. |
| `dispatch_failed` | Kiểm tra process identity, database write access và router health trước wire format. |
| `input_required` timeout | Kiểm tra Desktop approval/elicitation flow; không đổi model/key/endpoint để retry. |
| `EPERM` tại scratch root | Chạy `npm run test:preflight`, sửa ACL hoặc truyền root test đã được operator kiểm tra. |
| HTTP 429 không có layer metadata | Giữ `unknown/router`; không tự kết luận provider quota hoặc chuyển model. |
| Job core completed nhưng tools/call lỗi schema | Kiểm tra output schema MCP, đặc biệt recovery metadata và ánh xạ scoped-edit sang workspace-write. Không gọi model lại trước khi tái hiện offline. |
| Probe exit 0 nhưng report vẫn running | Không công nhận pass; kiểm tra callback cancel đang tự chờ onStarted. Giữ runtime lỗi để chẩn đoán, không xóa owner lock tự động. |

Rollback chỉ dùng checkpoint/release đã biết tốt, sau đó restart Desktop một lần và
kiểm tra task mới. Không `clean`, `reset`, xóa cache hoặc xóa execution lock khi chưa
xác minh owner/process.
