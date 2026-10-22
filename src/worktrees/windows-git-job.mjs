import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CANCEL_CONFIRM_TIMEOUT_MS = 10_000;
const MAX_CONTROLLER_STDERR_BYTES = 8 * 1024;

const CONTROLLER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $json = [Console]::In.ReadLine()
  if ($null -eq $json) { throw 'Missing Windows Job Object configuration on stdin.' }
  $cfg = ConvertFrom-Json -InputObject $json
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class VibeWindowsGitJobOutcome {
  public Nullable<int> Status { get; set; }
  public string StdoutBase64 { get; set; }
  public string StderrBase64 { get; set; }
  public string Signal { get; set; }
  public bool TimedOut { get; set; }
  public bool Cancelled { get; set; }
  public bool ConfirmedZero { get; set; }
  public string Error { get; set; }
}

public static class VibeWindowsGitJobRunner {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
  const uint JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002;
  const uint HANDLE_FLAG_INHERIT = 0x00000001;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 0x00000001;
  const uint FILE_SHARE_WRITE = 0x00000002;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
  const uint WAIT_OBJECT_0 = 0;
  const uint WAIT_TIMEOUT = 0x00000102;
  const uint TERMINATE_CODE = 0xE0000001;
  const int ERROR_BROKEN_PIPE = 109;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFOEX {
    public STARTUPINFO StartupInfo;
    public IntPtr lpAttributeList;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public uint dwProcessId;
    public uint dwThreadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public int bInheritHandle;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct EXTENDED_LIMIT_INFORMATION {
    public BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime;
    public long TotalKernelTime;
    public long ThisPeriodTotalUserTime;
    public long ThisPeriodTotalKernelTime;
    public uint TotalPageFaultCount;
    public uint TotalProcesses;
    public uint ActiveProcesses;
    public uint TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr securityAttributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, uint infoClass, ref EXTENDED_LIMIT_INFORMATION info, uint length);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, uint infoClass, out BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateFileW(string fileName, uint access, uint share, ref SECURITY_ATTRIBUTES security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, byte[] environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previousValue, IntPtr returnSize);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool PeekNamedPipe(IntPtr pipe, IntPtr buffer, uint bufferSize, out uint bytesRead, out uint totalAvailable, out uint bytesLeftThisMessage);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadFile(IntPtr file, byte[] buffer, uint bytesToRead, out uint bytesRead, IntPtr overlapped);

  sealed class OutputCapture {
    readonly object gate = new object();
    readonly int max;
    int used;
    readonly MemoryStream stdout = new MemoryStream();
    readonly MemoryStream stderr = new MemoryStream();
    public OutputCapture(int maxBytes) { max = maxBytes; }
    public void Append(bool isStdout, byte[] bytes, int count) {
      lock (gate) {
        int keep = Math.Min(count, Math.Max(0, max - used));
        if (keep > 0) {
          (isStdout ? stdout : stderr).Write(bytes, 0, keep);
          used += keep;
        }
      }
    }
    public byte[] Get(bool isStdout) {
      lock (gate) return (isStdout ? stdout : stderr).ToArray();
    }
  }

  static string Win32Error(string operation) {
    int code = Marshal.GetLastWin32Error();
    return operation + " failed (Win32 " + code.ToString() + "): " + new System.ComponentModel.Win32Exception(code).Message;
  }
  static string Quote(string value) {
    StringBuilder result = new StringBuilder();
    result.Append('"');
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') {
        result.Append('\\', slashes * 2 + 1);
        result.Append('"');
        slashes = 0;
        continue;
      }
      result.Append('\\', slashes);
      slashes = 0;
      result.Append(c);
    }
    result.Append('\\', slashes * 2);
    result.Append('"');
    return result.ToString();
  }
  static string BuildCommandLine(string command, string[] args) {
    StringBuilder line = new StringBuilder(Quote(command));
    foreach (string arg in args) { line.Append(' '); line.Append(Quote(arg)); }
    return line.ToString();
  }
  static byte[] EmptyEnvironment() { return new byte[] { 0, 0, 0, 0 }; }
  static byte[] DecodeEnvironment(string encoded) {
    return String.IsNullOrEmpty(encoded) ? EmptyEnvironment() : Convert.FromBase64String(encoded);
  }
  static bool TryActive(IntPtr job, out uint active) {
    BASIC_ACCOUNTING_INFORMATION info;
    bool ok = QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, out info,
      (uint)Marshal.SizeOf(typeof(BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero);
    active = ok ? info.ActiveProcesses : UInt32.MaxValue;
    return ok;
  }
  static int DrainPipe(IntPtr pipe, bool isStdout, OutputCapture output, int maxDrainBytes) {
    byte[] buffer = new byte[16 * 1024];
    int total = 0;
    while (total < maxDrainBytes) {
      uint read, available, left;
      if (!PeekNamedPipe(pipe, IntPtr.Zero, 0, out read, out available, out left)) {
        if (Marshal.GetLastWin32Error() == ERROR_BROKEN_PIPE) return total;
        throw new InvalidOperationException(Win32Error("PeekNamedPipe"));
      }
      if (available == 0) return total;
      uint wanted = Math.Min((uint)Math.Min(buffer.Length, maxDrainBytes - total), available);
      if (!ReadFile(pipe, buffer, wanted, out read, IntPtr.Zero)) {
        if (Marshal.GetLastWin32Error() == ERROR_BROKEN_PIPE) return total;
        throw new InvalidOperationException(Win32Error("ReadFile"));
      }
      if (read == 0) return total;
      output.Append(isStdout, buffer, (int)read);
      total += (int)read;
    }
  }
  static VibeWindowsGitJobOutcome Outcome(OutputCapture output, Nullable<int> status, bool timedOut, bool cancelled, bool confirmedZero, string error) {
    return new VibeWindowsGitJobOutcome {
      Status = status,
      StdoutBase64 = Convert.ToBase64String(output.Get(true)),
      StderrBase64 = Convert.ToBase64String(output.Get(false)),
      Signal = (timedOut || cancelled) ? "SIGTERM" : null,
      TimedOut = timedOut,
      Cancelled = cancelled,
      ConfirmedZero = confirmedZero,
      Error = error
    };
  }

  public static VibeWindowsGitJobOutcome Run(string command, string[] args, string cwd, string environmentBase64, int timeoutMs, int maxOutputBytes, string testFailAt) {
    if (args == null) args = new string[0];
    OutputCapture output = new OutputCapture(maxOutputBytes);
    IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero, errRead = IntPtr.Zero, errWrite = IntPtr.Zero, nullInput = IntPtr.Zero;
    IntPtr attributeList = IntPtr.Zero, handleArray = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    bool assigned = false, resumed = false, attributeListInitialized = false, unassignedProcessPending = false;
    string failure = null;
    bool timedOut = false, cancelled = false, confirmedZero = false;
    Nullable<int> status = null;
    try {
      if (testFailAt == "create-job") return Outcome(output, null, false, false, true, "Injected job initialization failure.");
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return Outcome(output, null, false, false, true, Win32Error("CreateJobObjectW"));
      EXTENDED_LIMIT_INFORMATION limits = new EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT_INFORMATION)))) {
        return Outcome(output, null, false, false, true, Win32Error("SetInformationJobObject"));
      }

      SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), bInheritHandle = 1, lpSecurityDescriptor = IntPtr.Zero };
      if (!CreatePipe(out outRead, out outWrite, ref inheritable, 0)) return Outcome(output, null, false, false, true, Win32Error("CreatePipe(stdout)"));
      if (!SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0)) return Outcome(output, null, false, false, true, Win32Error("SetHandleInformation(stdout)"));
      if (!CreatePipe(out errRead, out errWrite, ref inheritable, 0)) return Outcome(output, null, false, false, true, Win32Error("CreatePipe(stderr)"));
      if (!SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0)) return Outcome(output, null, false, false, true, Win32Error("SetHandleInformation(stderr)"));
      nullInput = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      if (nullInput == IntPtr.Zero || nullInput == new IntPtr(-1)) return Outcome(output, null, false, false, true, Win32Error("CreateFileW(NUL)"));

      IntPtr attributeSize = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeSize);
      if (attributeSize == IntPtr.Zero) return Outcome(output, null, false, false, true, Win32Error("InitializeProcThreadAttributeList(size)"));
      attributeList = Marshal.AllocHGlobal(attributeSize);
      if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeSize)) return Outcome(output, null, false, false, true, Win32Error("InitializeProcThreadAttributeList"));
      attributeListInitialized = true;
      handleArray = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleArray, 0, nullInput);
      Marshal.WriteIntPtr(handleArray, IntPtr.Size, outWrite);
      Marshal.WriteIntPtr(handleArray, IntPtr.Size * 2, errWrite);
      if (!UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleArray, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero)) {
        return Outcome(output, null, false, false, true, Win32Error("UpdateProcThreadAttribute(HANDLE_LIST)"));
      }

      STARTUPINFOEX startup = new STARTUPINFOEX();
      startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.StartupInfo.dwFlags = 0x00000100;
      startup.StartupInfo.hStdInput = nullInput;
      startup.StartupInfo.hStdOutput = outWrite;
      startup.StartupInfo.hStdError = errWrite;
      startup.lpAttributeList = attributeList;
      string commandLine = BuildCommandLine(command, args);
      if (commandLine.Length > 32766) return Outcome(output, null, false, false, true, "Windows command line exceeds 32,766 UTF-16 characters.");
      byte[] env = DecodeEnvironment(environmentBase64);
      if (testFailAt == "create-process") return Outcome(output, null, false, false, true, "Injected process initialization failure.");
      if (!CreateProcessW(command, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, env, cwd, ref startup, out process)) {
        return Outcome(output, null, false, false, true, Win32Error("CreateProcessW"));
      }
      if (testFailAt == "assign") {
        failure = "Injected AssignProcessToJobObject failure.";
      } else if (!AssignProcessToJobObject(job, process.hProcess)) {
        failure = Win32Error("AssignProcessToJobObject");
      } else {
        assigned = true;
      }
      if (failure != null) {
        if (!TerminateProcess(process.hProcess, TERMINATE_CODE)) failure += " " + Win32Error("TerminateProcess(suspended child)");
        uint wait = WaitForSingleObject(process.hProcess, 5000);
        confirmedZero = wait == WAIT_OBJECT_0;
        if (!confirmedZero) failure += " Suspended child termination was not confirmed.";
        return Outcome(output, null, false, false, confirmedZero, failure);
      }
      if (ResumeThread(process.hThread) == UInt32.MaxValue) {
        failure = Win32Error("ResumeThread");
        TerminateJobObject(job, TERMINATE_CODE);
      } else {
        resumed = true;
      }
      CloseHandle(outWrite); outWrite = IntPtr.Zero;
      CloseHandle(errWrite); errWrite = IntPtr.Zero;
      CloseHandle(nullInput); nullInput = IntPtr.Zero;
      if (handleArray != IntPtr.Zero) { Marshal.FreeHGlobal(handleArray); handleArray = IntPtr.Zero; }
      if (attributeList != IntPtr.Zero) { if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); attributeList = IntPtr.Zero; attributeListInitialized = false; }

      if (failure == null) {
        Thread inputMonitor = new Thread(delegate() {
          try {
            string line;
            while ((line = Console.ReadLine()) != null) {
              if (line.Trim() == "cancel") { Interlocked.Exchange(ref cancelRequested, 1); return; }
            }
          } catch { }
          Interlocked.Exchange(ref cancelRequested, 1);
        });
        inputMonitor.IsBackground = true;
        inputMonitor.Start();
        Stopwatch clock = Stopwatch.StartNew();
        bool terminationSent = false;
        long terminationAt = 0;
        while (true) {
          try { DrainPipe(outRead, true, output, 64 * 1024); DrainPipe(errRead, false, output, 64 * 1024); }
          catch (Exception ex) {
            if (failure == null) failure = ex.Message;
            if (!terminationSent) { TerminateJobObject(job, TERMINATE_CODE); terminationSent = true; terminationAt = clock.ElapsedMilliseconds; }
          }
          if (Interlocked.Exchange(ref cancelRequested, 0) != 0 && !terminationSent) {
            cancelled = true;
            TerminateJobObject(job, TERMINATE_CODE);
            terminationSent = true;
            terminationAt = clock.ElapsedMilliseconds;
          }
          if (clock.ElapsedMilliseconds >= timeoutMs && !terminationSent) {
            timedOut = true;
            TerminateJobObject(job, TERMINATE_CODE);
            terminationSent = true;
            terminationAt = clock.ElapsedMilliseconds;
          }
          uint active;
          if (!TryActive(job, out active)) {
            if (failure == null) failure = Win32Error("QueryInformationJobObject");
            if (!terminationSent) { TerminateJobObject(job, TERMINATE_CODE); terminationSent = true; terminationAt = clock.ElapsedMilliseconds; }
            else if (clock.ElapsedMilliseconds - terminationAt >= 5000) {
              if (failure == null) failure = "ActiveProcesses could not be confirmed after bounded job termination.";
              break;
            }
          } else if (active == 0) {
            confirmedZero = true;
            break;
          } else if (terminationSent && clock.ElapsedMilliseconds - terminationAt >= 5000) {
            if (failure == null) failure = "ActiveProcesses remained nonzero after bounded job termination.";
            break;
          }
          Thread.Sleep(10);
        }
        DrainPipe(outRead, true, output, 1024 * 1024);
        DrainPipe(errRead, false, output, 1024 * 1024);
        uint exitCode;
        if (GetExitCodeProcess(process.hProcess, out exitCode)) status = unchecked((int)exitCode);
        else if (failure == null) failure = Win32Error("GetExitCodeProcess");
      } else {
        uint active;
        confirmedZero = TryActive(job, out active) && active == 0;
      }
    } catch (Exception ex) {
      failure = failure == null ? ex.ToString() : failure + " " + ex.Message;
      if (job != IntPtr.Zero) TerminateJobObject(job, TERMINATE_CODE);
      if (process.hProcess != IntPtr.Zero && !assigned && !resumed) {
        TerminateProcess(process.hProcess, TERMINATE_CODE);
        confirmedZero = WaitForSingleObject(process.hProcess, 5000) == WAIT_OBJECT_0;
        unassignedProcessPending = !confirmedZero;
      }
    } finally {
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (outRead != IntPtr.Zero) CloseHandle(outRead);
      if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
      if (errRead != IntPtr.Zero) CloseHandle(errRead);
      if (errWrite != IntPtr.Zero) CloseHandle(errWrite);
      if (nullInput != IntPtr.Zero && nullInput != new IntPtr(-1)) CloseHandle(nullInput);
      if (attributeList != IntPtr.Zero) { if (attributeListInitialized) DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
      if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
      if (job != IntPtr.Zero) {
        uint active;
        if (!unassignedProcessPending && TryActive(job, out active) && active == 0) confirmedZero = true;
        else {
          TerminateJobObject(job, TERMINATE_CODE);
          uint wait = WaitForSingleObject(job, 5000);
          if (!unassignedProcessPending && wait == WAIT_OBJECT_0 && TryActive(job, out active) && active == 0) confirmedZero = true;
        }
        CloseHandle(job);
      }
    }
    return Outcome(output, status, timedOut, cancelled, confirmedZero, failure);
  }
  static int cancelRequested;
}
'@
  $commandArgs = @()
  if ($null -ne $cfg.args) { $commandArgs = @($cfg.args | ForEach-Object { [string]$_ }) }
  $outcome = [VibeWindowsGitJobRunner]::Run([string]$cfg.command, [string[]]$commandArgs, $cfg.cwd, [string]$cfg.environmentBase64, [int]$cfg.timeoutMs, [int]$cfg.maxOutputBytes, [string]$cfg.testFailAt)
  $response = [pscustomobject]@{
    protocol = 1
    status = $outcome.Status
    stdoutBase64 = $outcome.StdoutBase64
    stderrBase64 = $outcome.StderrBase64
    signal = $outcome.Signal
    timedOut = $outcome.TimedOut
    cancelled = $outcome.Cancelled
    confirmedZero = $outcome.ConfirmedZero
    error = $outcome.Error
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $response -Compress -Depth 3))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 1
}
`;

function rejectable(error) {
  return Promise.reject(error);
}

function quoteWindowsArg(value) {
  const text = String(value);
  let result = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    result += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${result}${'\\'.repeat(backslashes * 2)}"`;
}

function encodeEnvironment(environment) {
  const entries = Object.entries(environment ?? {});
  const seen = new Set();
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || key.includes('\0') || (!key.startsWith('=') && key.includes('='))) {
      throw new TypeError(`Invalid Windows environment variable name: ${key}`);
    }
    if (value === undefined || value === null) continue;
    if (String(value).includes('\0')) throw new TypeError(`Invalid value for Windows environment variable ${key}`);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new TypeError(`Invalid value for Windows environment variable ${key}`);
    }
    const folded = key.toUpperCase();
    if (seen.has(folded)) throw new TypeError(`Duplicate Windows environment variable: ${key}`);
    seen.add(folded);
  }
  const sorted = entries
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)])
    .sort(([left], [right]) => {
      const leftSpecial = left.startsWith('=');
      const rightSpecial = right.startsWith('=');
      if (leftSpecial !== rightSpecial) return leftSpecial ? -1 : 1;
      const a = left.toUpperCase();
      const b = right.toUpperCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
  const block = `${sorted.map(([key, value]) => `${key}=${value}\0`).join('')}\0`;
  if (block.length > 32_766) throw new RangeError('Windows environment block exceeds 32,766 UTF-16 characters');
  return Buffer.from(block, 'utf16le').toString('base64');
}

function makeConfig(command, args, options) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new RangeError(`maxOutputBytes must be an integer from 0 to ${MAX_OUTPUT_BYTES}`);
  }
  if (options.cwd !== undefined && (typeof options.cwd !== 'string' || options.cwd.length === 0)) {
    throw new TypeError('cwd must be a non-empty string when provided');
  }
  if (options.cwd?.includes('\0')) throw new TypeError('cwd cannot contain a NUL character');
  const environment = options.env === undefined ? process.env : options.env;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('env must be an object when provided');
  }
  const testFailAt = options.testHooks?.failAt;
  if (testFailAt !== undefined && !['create-job', 'create-process', 'assign'].includes(testFailAt)) {
    throw new TypeError('Unsupported internal Windows job test hook');
  }
  return {
    command,
    args,
    cwd: options.cwd ?? null,
    environmentBase64: encodeEnvironment(environment),
    timeoutMs,
    maxOutputBytes,
    testFailAt: testFailAt ?? null,
  };
}

/**
 * Run one Windows command inside a kill-on-close Job Object.
 * The child is created suspended, assigned to the job, then resumed. The
 * controller reports completion only after QueryInformationJobObject proves
 * ActiveProcesses is zero. timeoutMs is the total launch/runtime deadline;
 * after it expires, cleanup confirmation is bounded to ten additional seconds.
 * maxOutputBytes caps retained stdout plus stderr together while both pipes
 * continue to drain, and is capped at 32 MiB. `testHooks` is a fail-safe
 * native-test seam which can only inject setup failures; it cannot bypass job
 * containment.
 */
export function startWindowsJob(command, args = [], options = {}) {
  let config;
  try {
    if (typeof command !== 'string' || command.length === 0) throw new TypeError('command must be a non-empty string');
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings');
    if (command.includes('\0') || args.some((arg) => arg.includes('\0'))) throw new TypeError('command and args cannot contain NUL characters');
    config = makeConfig(command, args, options);
    if (quoteWindowsArg(command).length + args.reduce((size, arg) => size + quoteWindowsArg(arg).length + 1, 0) > 32766) {
      throw new RangeError('Windows command line exceeds 32,766 UTF-16 characters');
    }
  } catch (error) {
    const result = rejectable(error);
    return { result, cancel: () => rejectable(error) };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    const error = new Error('Windows Job Object execution is only available on win32');
    return { result: rejectable(error), cancel: () => rejectable(error) };
  }

  const script = CONTROLLER_SCRIPT;
  const powershellArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
  const spawn = options.spawn ?? nodeSpawn;
  let child;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let settled = false;
  let closed = false;
  let finalRecord = null;
  let stdoutText = '';
  let stderrText = '';
  let stderrKept = 0;
  let deadlineTriggered = false;
  let cancelPromise = null;
  let cancelTimer = null;
  const maxProtocolBytes = Math.max(64 * 1024, config.maxOutputBytes * 2 + 64 * 1024);
  let protocolBytes = 0;
  const cleanup = () => {
    clearTimeout(deadlineTimer);
    clearTimeout(cancelTimer);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectResult(error instanceof Error ? error : new Error(String(error)));
  };
  const maybeResolve = () => {
    if (!closed || !finalRecord || settled) return;
    if (finalRecord.confirmedZero !== true) {
      fail(new Error(`Windows Job Object did not confirm ActiveProcesses=0${finalRecord.error ? `: ${finalRecord.error}` : ''}`));
      return;
    }
    if (finalRecord.protocol !== 1) {
      fail(new Error('Unsupported Windows Job Object controller response'));
      return;
    }
    const stdout = Buffer.from(finalRecord.stdoutBase64 ?? '', 'base64').toString('utf8');
    const stderr = Buffer.from(finalRecord.stderrBase64 ?? '', 'base64').toString('utf8');
    settled = true;
    cleanup();
    resolveResult({
      status: Number.isInteger(finalRecord.status) ? finalRecord.status : null,
      stdout,
      stderr,
      signal: finalRecord.signal ?? (finalRecord.cancelled || finalRecord.timedOut ? 'SIGTERM' : null),
      timedOut: Boolean(finalRecord.timedOut || deadlineTriggered),
      ...(finalRecord.error ? { error: String(finalRecord.error) } : {}),
    });
  };
  const onControllerOutput = (chunk) => {
    stdoutText += chunk.toString('utf8');
    protocolBytes += Buffer.byteLength(chunk);
    if (protocolBytes > maxProtocolBytes) {
      try { child?.kill(); } catch { /* the job handle closes with the controller */ }
      fail(new Error('Windows Job Object controller response exceeded its output limit'));
      return;
    }
    let newline;
    while ((newline = stdoutText.indexOf('\n')) !== -1) {
      const line = stdoutText.slice(0, newline).trim();
      stdoutText = stdoutText.slice(newline + 1);
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === 'object' && record.protocol === 1) finalRecord = record;
      } catch {
        // PowerShell's stdout must contain only the final JSON record.
        try { child?.kill(); } catch { /* the job handle closes with the controller */ }
        fail(new Error('Windows Job Object controller emitted an invalid response'));
        return;
      }
    }
  };
  const onCancelWatchdog = () => {
    try { child?.kill(); } catch { /* controller exit closes its kill-on-close job */ }
    fail(new Error('Windows Job Object cancellation did not confirm ActiveProcesses=0 within five seconds'));
  };
  const sendCancel = (isDeadline) => {
    if (isDeadline) deadlineTriggered = true;
    if (cancelPromise) return cancelPromise;
    cancelPromise = new Promise((resolve, reject) => {
      if (settled) {
        reject(new Error('Windows Job Object is no longer available for cancellation'));
        return;
      }
      cancelTimer = setTimeout(onCancelWatchdog, CANCEL_CONFIRM_TIMEOUT_MS);
      try {
        if (!child?.stdin || child.stdin.destroyed || child.exitCode !== null) throw new Error('Windows Job Object controller is not available');
        child.stdin.write('cancel\n', (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
    cancelPromise.catch(() => {});
    return cancelPromise;
  };

  const deadlineTimer = setTimeout(() => {
    sendCancel(true).catch(() => {});
  }, config.timeoutMs);
  try {
    child = spawn('powershell.exe', powershellArgs, {
      cwd: process.cwd(),
      env: options.controllerEnv ?? (options.env ?? process.env),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(error);
    return { result, cancel: () => result.then(() => {}, () => {}) };
  }
  child.stdin?.write(`${JSON.stringify(config)}\n`, (error) => {
    if (error) fail(new Error(`Could not send Windows Job Object configuration: ${error.message}`));
  });
  child.stdout?.on('data', onControllerOutput);
  child.stderr?.on('data', (chunk) => {
    if (stderrKept >= MAX_CONTROLLER_STDERR_BYTES) return;
    const kept = chunk.subarray(0, MAX_CONTROLLER_STDERR_BYTES - stderrKept);
    stderrText += kept.toString('utf8');
    stderrKept += kept.length;
  });
  child.on('error', (error) => fail(error));
  child.on('close', (code, signal) => {
    closed = true;
    if (!finalRecord && !settled) {
      const detail = stderrText.trim();
      fail(new Error(`Windows Job Object controller exited before confirming cleanup (code=${code}, signal=${signal ?? 'none'})${detail ? `: ${detail}` : ''}`));
      return;
    }
    maybeResolve();
  });

  return {
    result,
    cancel(reason) {
      void reason;
      if (settled) return result.then(() => {}, (error) => { throw error; });
      return sendCancel(false).then(() => result.then(() => {}, (error) => { throw error; }));
    },
  };
}
