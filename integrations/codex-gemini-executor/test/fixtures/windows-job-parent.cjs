// Fixture for windows-job.test.js: a parent process that launches the
// Windows job wrapper exactly the way src/app-server/process.js does.
// argv[2] = powershell path, argv[3] = job helper script, argv[4] = base64 launch spec.
const { spawn } = require('node:child_process');
const wrapper = spawn(process.argv[2], ['-NoLogo', '-NoProfile', '-NonInteractive',
  '-ExecutionPolicy', 'Bypass', '-File', process.argv[3],
  '-ParentPid', String(process.pid), '-LaunchSpecBase64', process.argv[4]], {
  stdio: 'inherit', windowsHide: true,
});
process.stdout.write(JSON.stringify({ kind: 'wrapper', pid: wrapper.pid }) + '\n');
setInterval(() => {}, 1000);
