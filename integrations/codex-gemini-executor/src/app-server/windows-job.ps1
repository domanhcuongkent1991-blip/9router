param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int] $ParentPid,

    [Parameter(Mandatory = $true)]
    [string] $LaunchSpecBase64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

try {
    $launchSpec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($LaunchSpecBase64)) | ConvertFrom-Json
    if ($launchSpec.executablePath -isnot [string] -or
        $launchSpec.executablePath -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])' -or
        -not [IO.File]::Exists($launchSpec.executablePath) -or
        $launchSpec.executablePath.IndexOf([char]0) -ge 0) {
        throw 'Invalid executable path'
    }
    if ($launchSpec.arguments -isnot [System.Array]) { throw 'Invalid argument list' }
    foreach ($argument in $launchSpec.arguments) {
        if ($argument -isnot [string] -or $argument.IndexOf([char]0) -ge 0) { throw 'Invalid argument' }
    }

    # This wrapper owns the only job handle. Its termination therefore also
    # terminates every descendant, including when its parent dies abruptly.
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AppServerWindowsJob
{
    const uint Synchronize = 0x00100000;
    const uint KillOnJobClose = 0x00002000;
    const uint CreateSuspended = 0x00000004;
    const uint CreateNoWindow = 0x08000000;
    const uint StartUseStdHandles = 0x00000100;
    const uint Infinite = 0xFFFFFFFF;
    const uint WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo
    {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation
    {
        public IntPtr hProcess, hThread;
        public uint dwProcessId, dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JobAccountingInformation
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimitInformation info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass,
        out JobAccountingInformation information, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string currentDirectory, ref StartupInfo startupInfo, out ProcessInformation processInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(int identifier);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
        out IntPtr targetHandle, uint desiredAccess, bool inheritHandle, uint options);

    static void Require(bool succeeded)
    {
        if (!succeeded) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static IntPtr InheritStandardHandle(int identifier)
    {
        IntPtr source = GetStdHandle(identifier);
        if (source == IntPtr.Zero || source == new IntPtr(-1)) throw new InvalidOperationException();
        IntPtr duplicate;
        Require(DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), out duplicate, 0, true, 2));
        return duplicate;
    }

    // Match Windows CommandLineToArgvW/CRT escaping without invoking a shell.
    static string Quote(string value)
    {
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1);
            else result.Append('\\', slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    static void StopJobAndWait(IntPtr job)
    {
        Require(TerminateJobObject(job, 125));
        Stopwatch deadline = Stopwatch.StartNew();
        do
        {
            JobAccountingInformation accounting;
            Require(QueryInformationJobObject(job, 1, out accounting,
                (uint)Marshal.SizeOf(typeof(JobAccountingInformation)), IntPtr.Zero));
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(10);
        } while (deadline.ElapsedMilliseconds < 5000);
        throw new TimeoutException();
    }

    public static int Run(int parentPid, string executablePath, string[] arguments)
    {
        IntPtr parent = IntPtr.Zero, job = IntPtr.Zero;
        StartupInfo startup = new StartupInfo();
        ProcessInformation process = new ProcessInformation();
        bool resumed = false;
        try
        {
            parent = OpenProcess(Synchronize, false, parentPid);
            Require(parent != IntPtr.Zero);
            if (WaitForSingleObject(parent, 0) != WaitTimeout) throw new InvalidOperationException();
            job = CreateJobObjectW(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            ExtendedLimitInformation limits = new ExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));

            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.dwFlags = StartUseStdHandles;
            startup.hStdInput = InheritStandardHandle(-10);
            startup.hStdOutput = InheritStandardHandle(-11);
            startup.hStdError = InheritStandardHandle(-12);
            StringBuilder commandLine = new StringBuilder(Quote(executablePath));
            foreach (string argument in arguments) commandLine.Append(' ').Append(Quote(argument));
            if (commandLine.Length >= 32767) throw new InvalidOperationException();

            // No child code runs until job membership has been established.
            Require(CreateProcessW(executablePath, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateNoWindow, IntPtr.Zero, null, ref startup, out process));
            Require(AssignProcessToJobObject(job, process.hProcess));
            if (WaitForSingleObject(parent, 0) != WaitTimeout) throw new InvalidOperationException();
            Require(ResumeThread(process.hThread) != 0xFFFFFFFF);
            resumed = true;

            uint result = WaitForMultipleObjects(2, new IntPtr[] { parent, process.hProcess }, false, Infinite);
            if (result == 0)
            {
                StopJobAndWait(job);
                return 0;
            }
            Require(result == 1);
            uint exitCode;
            Require(GetExitCodeProcess(process.hProcess, out exitCode));
            StopJobAndWait(job);
            return unchecked((int)exitCode);
        }
        finally
        {
            // A failed assignment must not leave a suspended, unowned child.
            if (process.hProcess != IntPtr.Zero && !resumed) TerminateProcess(process.hProcess, 125);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (process.hProcess != IntPtr.Zero)
            {
                WaitForSingleObject(process.hProcess, 5000);
                CloseHandle(process.hProcess);
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (startup.hStdInput != IntPtr.Zero) CloseHandle(startup.hStdInput);
            if (startup.hStdOutput != IntPtr.Zero) CloseHandle(startup.hStdOutput);
            if (startup.hStdError != IntPtr.Zero) CloseHandle(startup.hStdError);
            if (parent != IntPtr.Zero) CloseHandle(parent);
        }
    }
}
'@

    $result = [AppServerWindowsJob]::Run($ParentPid, $launchSpec.executablePath, [string[]] $launchSpec.arguments)
    exit $result
}
catch {
    [Console]::Error.WriteLine('app_server_process_error: windows_job_launch_failed')
    exit 125
}
