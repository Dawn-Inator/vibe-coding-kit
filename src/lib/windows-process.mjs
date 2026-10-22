import { spawnSync } from 'node:child_process';

const WINDOWS_PROCESS_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class VibeWindowsProcessProbe {
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessBasicInformation {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref ProcessBasicInformation info, uint length, out uint returned);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref IntPtr info, uint length, out uint returned);

  private static IntPtr Add(IntPtr address, int offset) {
    return new IntPtr(address.ToInt64() + offset);
  }

  private static byte[] Read(IntPtr process, IntPtr address, int length) {
    byte[] data = new byte[length];
    UIntPtr read;
    if (!ReadProcessMemory(process, address, data, (UIntPtr)length, out read) || read.ToUInt64() != (ulong)length) return null;
    return data;
  }

  private static IntPtr ReadPointer(byte[] data, int pointerSize) {
    return pointerSize == 8 ? new IntPtr(BitConverter.ToInt64(data, 0)) : new IntPtr(BitConverter.ToInt32(data, 0));
  }

  public static object ReadCurrentDirectory(uint processId) {
    IntPtr process = OpenProcess(0x1010, false, processId); // QUERY_LIMITED_INFORMATION | VM_READ
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      return new { path = (string)null, status = error == 87 || error == 1168 ? "exited" : "unreadable", errorCode = error };
    }

    try {
      ProcessBasicInformation basic = new ProcessBasicInformation();
      uint returned;
      int status = NtQueryInformationProcess(process, 0, ref basic, (uint)Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned);
      if (status != 0 || basic.PebBaseAddress == IntPtr.Zero) {
        return new { path = (string)null, status = "unreadable", errorCode = status };
      }

      int pointerSize = IntPtr.Size;
      IntPtr peb = basic.PebBaseAddress;
      // A 64-bit PowerShell process can inspect a 32-bit target through its WOW64 PEB.
      if (IntPtr.Size == 8) {
        IntPtr wow64Peb = IntPtr.Zero;
        int wow64Status = NtQueryInformationProcess(process, 26, ref wow64Peb, (uint)IntPtr.Size, out returned);
        if (wow64Status == 0 && wow64Peb != IntPtr.Zero) { peb = wow64Peb; pointerSize = 4; }
      }

      byte[] parametersBytes = Read(process, Add(peb, pointerSize == 8 ? 0x20 : 0x10), pointerSize);
      if (parametersBytes == null) return new { path = (string)null, status = "unreadable", errorCode = Marshal.GetLastWin32Error() };
      IntPtr parameters = ReadPointer(parametersBytes, pointerSize);
      if (parameters == IntPtr.Zero) return new { path = (string)null, status = "unreadable", errorCode = 0 };

      // RTL_USER_PROCESS_PARAMETERS.CurrentDirectory.DosPath.
      int currentDirectoryOffset = pointerSize == 8 ? 0x38 : 0x24;
      byte[] unicodeString = Read(process, Add(parameters, currentDirectoryOffset), pointerSize == 8 ? 16 : 8);
      if (unicodeString == null) return new { path = (string)null, status = "unreadable", errorCode = Marshal.GetLastWin32Error() };
      int byteLength = BitConverter.ToUInt16(unicodeString, 0);
      IntPtr pathBuffer = pointerSize == 8
        ? new IntPtr(BitConverter.ToInt64(unicodeString, 8))
        : new IntPtr(BitConverter.ToInt32(unicodeString, 4));
      if (byteLength <= 0 || byteLength > 32766 || pathBuffer == IntPtr.Zero) {
        return new { path = (string)null, status = "unreadable", errorCode = 0 };
      }
      byte[] pathBytes = Read(process, pathBuffer, byteLength);
      if (pathBytes == null) return new { path = (string)null, status = "unreadable", errorCode = Marshal.GetLastWin32Error() };
      return new { path = Encoding.Unicode.GetString(pathBytes), status = "readable", errorCode = 0 };
    } finally {
      CloseHandle(process);
    }
  }
}
'@

$rows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object {
  $cwd = [VibeWindowsProcessProbe]::ReadCurrentDirectory([uint32]$_.ProcessId)
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
    cwd = [string]$cwd.path
    cwdStatus = [string]$cwd.status
    cwdErrorCode = [int]$cwd.errorCode
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

function validateProcessRows(value) {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  return rows.map((row) => {
    const pid = Number(row.pid);
    const ppid = Number(row.ppid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      throw new Error('Windows process inventory returned an invalid PID record');
    }
    const cwdStatus = ['readable', 'unreadable', 'exited'].includes(row.cwdStatus)
      ? row.cwdStatus
      : 'unknown';
    const cwd = cwdStatus === 'readable' && typeof row.cwd === 'string' && row.cwd.length > 0
      ? row.cwd
      : null;
    return {
      pid,
      ppid,
      executablePath: typeof row.executablePath === 'string' && row.executablePath ? row.executablePath : null,
      commandLine: typeof row.commandLine === 'string' && row.commandLine ? row.commandLine : null,
      cwd,
      cwdStatus: cwd === null && cwdStatus === 'readable' ? 'unknown' : cwdStatus,
      cwdErrorCode: Number.isInteger(Number(row.cwdErrorCode)) ? Number(row.cwdErrorCode) : null,
    };
  });
}

/**
 * Return a Windows process snapshot from the OS process table and each
 * process's PEB. A process with an unreadable cwd remains in the result with
 * cwdStatus="unreadable"; callers must decide conservatively when it may be
 * relevant. Inventory failures throw and must never be treated as an empty
 * process list.
 *
 * @param {{platform?: string, spawn?: typeof spawnSync, timeoutMs?: number}} [options]
 * @returns {{pid: number, ppid: number, executablePath: string|null, commandLine: string|null, cwd: string|null, cwdStatus: string, cwdErrorCode: number|null}[]}
 */
export function listWindowsProcesses({ platform = process.platform, spawn = spawnSync, timeoutMs = 30000 } = {}) {
  if (platform !== 'win32') throw new Error('Windows process inventory is only available on Windows');
  const result = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROCESS_QUERY],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error) throw new Error(`Windows process inventory failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`Windows process inventory failed (PowerShell exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  try {
    return validateProcessRows(JSON.parse(String(result.stdout || '[]').trim() || '[]'));
  } catch (error) {
    if (error?.message?.startsWith('Windows process inventory returned')) throw error;
    throw new Error(`Windows process inventory returned invalid JSON: ${error.message}`);
  }
}
