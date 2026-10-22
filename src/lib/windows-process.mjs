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
    public int ExitStatus;
    public IntPtr PebBaseAddress;
    public IntPtr AffinityMask;
    public int BasePriority;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool IsWow64Process(IntPtr process, out bool wow64Process);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess", ExactSpelling = true)]
  private static extern int NtQueryInformationProcessBasic(IntPtr process, int infoClass, ref ProcessBasicInformation info, uint length, out uint returned);
  [DllImport("ntdll.dll", EntryPoint = "NtQueryInformationProcess", ExactSpelling = true)]
  private static extern int NtQueryInformationProcessPointer(IntPtr process, int infoClass, ref IntPtr info, uint length, out uint returned);

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
    return pointerSize == 8
      ? new IntPtr(BitConverter.ToInt64(data, 0))
      : new IntPtr((long)(uint)BitConverter.ToInt32(data, 0));
  }

  public static object ReadCurrentDirectory(uint processId) {
    // PID 0 is the System Idle Process pseudo-record, not an openable process.
    if (processId == 0) return new { path = (string)null, status = "excluded", errorCode = 0 };

    IntPtr process = OpenProcess(0x1010, false, processId); // QUERY_LIMITED_INFORMATION | VM_READ
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      return new { path = (string)null, status = error == 87 || error == 1168 ? "exited" : "unreadable", errorCode = error };
    }

    try {
      ProcessBasicInformation basic = new ProcessBasicInformation();
      uint returned;
      int status = NtQueryInformationProcessBasic(process, 0, ref basic, (uint)Marshal.SizeOf(typeof(ProcessBasicInformation)), out returned);
      if (status != 0 || basic.PebBaseAddress == IntPtr.Zero) {
        return new { path = (string)null, status = "unreadable", errorCode = status };
      }

      int pointerSize = IntPtr.Size;
      IntPtr peb = basic.PebBaseAddress;
      // A 32-bit probe on 64-bit Windows cannot safely read a native 64-bit PEB.
      // It can still inspect 32-bit WOW64 targets; report other targets unknown.
      if (IntPtr.Size == 4 && Environment.Is64BitOperatingSystem) {
        bool wow64Target;
        if (!IsWow64Process(process, out wow64Target)) {
          return new { path = (string)null, status = "unknown", errorCode = Marshal.GetLastWin32Error() };
        }
        if (!wow64Target) {
          return new { path = (string)null, status = "unknown", errorCode = 0 };
        }
      }
      // A 64-bit PowerShell process can inspect a 32-bit target through its WOW64 PEB.
      if (IntPtr.Size == 8) {
        IntPtr wow64Peb = IntPtr.Zero;
        int wow64Status = NtQueryInformationProcessPointer(process, 26, ref wow64Peb, (uint)IntPtr.Size, out returned);
        if (wow64Status == 0 && wow64Peb != IntPtr.Zero) {
          peb = new IntPtr(wow64Peb.ToInt64() & 0xffffffffL);
          pointerSize = 4;
        }
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
        : new IntPtr((long)(uint)BitConverter.ToInt32(unicodeString, 4));
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
  $cwd = $null
  try {
    $cwd = [VibeWindowsProcessProbe]::ReadCurrentDirectory([uint32]$_.ProcessId)
  } catch {
    # Keep the CIM process record. A per-process native probe failure must not
    # erase the rest of the inventory or make an unreadable cwd look like idle.
    $cwd = [pscustomobject]@{ path = $null; status = 'unknown'; errorCode = $null }
  }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
    cwd = [string]$cwd.path
    cwdStatus = [string]$cwd.status
    cwdErrorCode = $cwd.errorCode
  }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

const WINDOWS_DIRECTORY_DELETE_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class VibeDirectoryDeleteProbe {
  private const uint DELETE = 0x00010000;
  private const uint SHARE_ALL = 0x00000007;
  private const uint OPEN_EXISTING = 3;
  private const uint BACKUP_SEMANTICS = 0x02000000;
  private const uint OPEN_REPARSE_POINT = 0x00200000;
  private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
  private const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  private const int ERROR_FILE_NOT_FOUND = 2;
  private const int ERROR_PATH_NOT_FOUND = 3;
  private const int ERROR_ACCESS_DENIED = 5;
  private const int ERROR_SHARING_VIOLATION = 32;
  private const int ERROR_NOT_ALL_ASSIGNED = 1300;
  private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
  private const uint TOKEN_QUERY = 0x0008;

  [StructLayout(LayoutKind.Sequential)]
  private struct Luid {
    public uint LowPart;
    public int HighPart;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct LuidAndAttributes {
    public Luid Luid;
    public uint Attributes;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct TokenPrivileges {
    public uint PrivilegeCount;
    public LuidAndAttributes Privileges;
  }

  [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", EntryPoint = "GetFileAttributesW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  private static extern uint GetFileAttributes(string path);
  [StructLayout(LayoutKind.Sequential)]
  private struct ByHandleFileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandle", ExactSpelling = true, SetLastError = true)]
  private static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);
  [DllImport("kernel32.dll", EntryPoint = "CloseHandle", ExactSpelling = true, SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", EntryPoint = "GetCurrentProcess", ExactSpelling = true)]
  private static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", EntryPoint = "SetLastError", ExactSpelling = true)]
  private static extern void SetLastErrorCode(uint error);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool LookupPrivilegeValue(string systemName, string name, out Luid luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAllPrivileges, ref TokenPrivileges newState, uint bufferLength, out TokenPrivileges previousState, out uint returnLength);

  // Opening directories requires FILE_FLAG_BACKUP_SEMANTICS. Elevated CI tokens
  // may have SeBackupPrivilege / SeRestorePrivilege enabled; those can bypass
  // the DACL during a backup-intent open and make a denied DELETE look safe.
  // Disable just these privileges in this short-lived PowerShell process while
  // proving ordinary DELETE access, then restore their exact prior states.
  private sealed class DisableBackupRestorePrivileges : IDisposable {
    private readonly IntPtr token;
    private readonly List<TokenPrivileges> previousStates = new List<TokenPrivileges>();
    private bool disposed;

    private DisableBackupRestorePrivileges(IntPtr token) { this.token = token; }

    public static DisableBackupRestorePrivileges Create() {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, out token)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "could not open process token to neutralize backup/restore privileges");
      }
      DisableBackupRestorePrivileges scope = new DisableBackupRestorePrivileges(token);
      try {
        scope.Disable("SeBackupPrivilege");
        scope.Disable("SeRestorePrivilege");
        return scope;
      } catch {
        scope.Dispose();
        throw;
      }
    }

    private void Disable(string name) {
      Luid luid;
      if (!LookupPrivilegeValue(null, name, out luid)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "could not resolve " + name);
      }
      TokenPrivileges requested = new TokenPrivileges();
      requested.PrivilegeCount = 1;
      requested.Privileges = new LuidAndAttributes { Luid = luid, Attributes = 0 };
      TokenPrivileges previous;
      uint returned;
      SetLastErrorCode(0);
      if (!AdjustTokenPrivileges(token, false, ref requested, (uint)Marshal.SizeOf(typeof(TokenPrivileges)), out previous, out returned)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "could not disable " + name);
      }
      int error = Marshal.GetLastWin32Error();
      if (error == ERROR_NOT_ALL_ASSIGNED) return; // this token does not carry the privilege
      if (previous.PrivilegeCount > 0) previousStates.Add(previous);
      if (error != 0) throw new Win32Exception(error, "could not disable " + name);
    }

    public void Dispose() {
      if (disposed) return;
      disposed = true;
      Exception failure = null;
      for (int index = previousStates.Count - 1; index >= 0; index--) {
        TokenPrivileges previous = previousStates[index];
        TokenPrivileges ignored;
        uint returned;
        SetLastErrorCode(0);
        // AdjustTokenPrivileges requires BufferLength to describe the output
        // PreviousState buffer whenever it is non-null. Passing zero here can
        // fail with ERROR_INSUFFICIENT_BUFFER and leave the privilege disabled.
        if (!AdjustTokenPrivileges(token, false, ref previous, (uint)Marshal.SizeOf(typeof(TokenPrivileges)), out ignored, out returned)) {
          if (failure == null) failure = new Win32Exception(Marshal.GetLastWin32Error(), "could not restore a token privilege after directory access check");
        } else {
          int error = Marshal.GetLastWin32Error();
          if (error != 0 && failure == null) failure = new Win32Exception(error, "could not restore a token privilege after directory access check");
        }
      }
      CloseHandle(token);
      if (failure != null) throw failure;
    }
  }

  private sealed class DirectoryNode {
    public string Path;
    public int Depth;
    public DirectoryNode(string path, int depth) { Path = path; Depth = depth; }
  }

  private static object Result(bool safe, string reason, int checkedCount) {
    return new { safe = safe, reason = reason, @checked = checkedCount };
  }

  private static bool IsWithinRoot(string root, string candidate) {
    string normalizedRoot = root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    if (normalizedRoot.Length == 0) normalizedRoot = Path.GetPathRoot(root);
    if (String.Equals(normalizedRoot, candidate.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) return true;
    string prefix = normalizedRoot.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal)
      ? normalizedRoot : normalizedRoot + Path.DirectorySeparatorChar;
    return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
  }

  private static uint Attributes(string path) {
    uint attributes = GetFileAttributes(path);
    return attributes;
  }

  private static string OpenFailureReason(int error) {
    if (error == ERROR_SHARING_VIOLATION) return "directory-in-use";
    if (error == ERROR_ACCESS_DENIED) return "access-denied";
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return "path-not-found";
    return "native-open-failed";
  }

  public static object Probe(string rootPath, int maxEntries, int maxDepth, int timeoutMs) {
    int checkedCount = 0;
    try {
      string root = Path.GetFullPath(rootPath);
      if (String.IsNullOrWhiteSpace(root)) return Result(false, "invalid-root", checkedCount);
      using (DisableBackupRestorePrivileges.Create()) {
      Stopwatch stopwatch = Stopwatch.StartNew();

      // Reject reparse points in the candidate path itself and its ancestors.
      string ancestor = root;
      while (!String.IsNullOrEmpty(ancestor)) {
        uint attributes = Attributes(ancestor);
        if (attributes == INVALID_FILE_ATTRIBUTES) return Result(false, "path-not-found", checkedCount);
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Result(false, "reparse-point", checkedCount);
        string parent = Directory.GetParent(ancestor) == null ? null : Directory.GetParent(ancestor).FullName;
        if (String.Equals(parent, ancestor, StringComparison.OrdinalIgnoreCase)) break;
        ancestor = parent;
      }

      Stack<DirectoryNode> pending = new Stack<DirectoryNode>();
      pending.Push(new DirectoryNode(root, 0));
      int visitedEntries = 0;
      while (pending.Count > 0) {
        if (stopwatch.ElapsedMilliseconds >= timeoutMs) return Result(false, "timeout", checkedCount);
        DirectoryNode node = pending.Pop();
        string fullPath = Path.GetFullPath(node.Path);
        if (!IsWithinRoot(root, fullPath)) return Result(false, "out-of-root", checkedCount);
        if (node.Depth > maxDepth) return Result(false, "max-depth", checkedCount);

        uint attributes = Attributes(fullPath);
        if (attributes == INVALID_FILE_ATTRIBUTES) {
          int error = Marshal.GetLastWin32Error();
          return Result(false, error == ERROR_ACCESS_DENIED ? "access-denied" : "path-not-found", checkedCount);
        }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Result(false, "reparse-point", checkedCount);
        if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) return Result(false, "not-directory", checkedCount);

        IntPtr handle = CreateFile(fullPath, DELETE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, BACKUP_SEMANTICS | OPEN_REPARSE_POINT, IntPtr.Zero);
        if (handle == IntPtr.Zero || handle.ToInt64() == -1) {
          return Result(false, OpenFailureReason(Marshal.GetLastWin32Error()), checkedCount);
        }
        ByHandleFileInformation handleInformation;
        if (!GetFileInformationByHandle(handle, out handleInformation)) {
          CloseHandle(handle);
          return Result(false, "unknown", checkedCount);
        }
        if ((handleInformation.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
          CloseHandle(handle);
          return Result(false, "reparse-point", checkedCount);
        }
        if ((handleInformation.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
          CloseHandle(handle);
          return Result(false, "not-directory", checkedCount);
        }
        bool closed = CloseHandle(handle);
        if (!closed) return Result(false, "close-failed", checkedCount);
        checkedCount += 1;

        try {
          foreach (string entry in Directory.EnumerateFileSystemEntries(fullPath)) {
            visitedEntries += 1;
            if (visitedEntries > maxEntries) return Result(false, "max-entries", checkedCount);
            if (stopwatch.ElapsedMilliseconds >= timeoutMs) return Result(false, "timeout", checkedCount);
            string child = Path.GetFullPath(entry);
            if (!IsWithinRoot(root, child)) return Result(false, "out-of-root", checkedCount);
            uint childAttributes = Attributes(child);
            if (childAttributes == INVALID_FILE_ATTRIBUTES) {
              int error = Marshal.GetLastWin32Error();
              return Result(false, error == ERROR_ACCESS_DENIED ? "access-denied" : "scan-failed", checkedCount);
            }
            if ((childAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return Result(false, "reparse-point", checkedCount);
            if ((childAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) pending.Push(new DirectoryNode(child, node.Depth + 1));
          }
        } catch (UnauthorizedAccessException) {
          return Result(false, "access-denied", checkedCount);
        } catch (IOException) {
          return Result(false, "scan-failed", checkedCount);
        }
      }
      return Result(true, "safe", checkedCount);
      }
    } catch (UnauthorizedAccessException) {
      return Result(false, "access-denied", checkedCount);
    } catch (IOException) {
      return Result(false, "scan-failed", checkedCount);
    } catch (Exception) {
      return Result(false, "unknown", checkedCount);
    }
  }
}
'@
$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__ROOT_UTF16_BASE64__'))
$result = [VibeDirectoryDeleteProbe]::Probe($root, __MAX_ENTRIES__, __MAX_DEPTH__, __TIMEOUT_MS__)
[pscustomobject]@{ safe = [bool]$result.safe; reason = [string]$result.reason; checked = [int]$result.checked } | ConvertTo-Json -Compress
`;

function validateProcessRows(value) {
  const rows = Array.isArray(value) ? value : value == null ? [] : [value];
  return rows.filter((row) => !(row && typeof row === 'object' && row.pid === 0 && row.ppid === 0)).map((row) => {
    const pid = row?.pid;
    const ppid = row?.ppid;
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
      cwdErrorCode: row.cwdErrorCode != null && Number.isInteger(Number(row.cwdErrorCode)) ? Number(row.cwdErrorCode) : null,
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

function unsafeDirectoryProbe(reason, checked = 0) {
  return { safe: false, reason, checked: Number.isSafeInteger(checked) && checked >= 0 ? checked : 0 };
}

function boundedProbeDiagnostic(value, root) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  let detail = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (typeof root === 'string' && root) {
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    detail = detail.replace(new RegExp(escapedRoot, 'gi'), '<root>');
  }
  return detail.slice(0, 300);
}

/**
 * Check whether every real directory below `root` can be opened with DELETE
 * access while allowing read/write/delete sharing. A live process current
 * directory is locked by Windows; incompatible existing directory handles
 * make CreateFileW fail, so callers can refuse reclamation before deleting.
 * This probe never requests delete-on-close and closes every successful handle.
 * Reparse points, inaccessible paths, incomplete scans, and bounds are unsafe.
 *
 * @param {string} root
 * @param {{platform?: string, spawn?: typeof spawnSync, timeoutMs?: number, maxEntries?: number, maxDepth?: number}} [options]
 * @returns {{safe: boolean, reason: string, checked: number, diagnostic?: string}}
 */
export function probeWindowsDirectoryDeleteSafety(root, {
  platform = process.platform,
  spawn = spawnSync,
  timeoutMs = 15000,
  maxEntries = 10000,
  maxDepth = 64,
} = {}) {
  if (platform !== 'win32') return unsafeDirectoryProbe('unsupported-platform');
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) return unsafeDirectoryProbe('invalid-root');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100000 ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 256) {
    return unsafeDirectoryProbe('invalid-limits');
  }

  const rootBase64 = Buffer.from(root, 'utf16le').toString('base64');
  const script = WINDOWS_DIRECTORY_DELETE_QUERY
    .replace('__ROOT_UTF16_BASE64__', rootBase64)
    .replace('__MAX_ENTRIES__', String(maxEntries))
    .replace('__MAX_DEPTH__', String(maxDepth))
    .replace('__TIMEOUT_MS__', String(timeoutMs));
  let result;
  try {
    result = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 5000, maxBuffer: 1024 * 1024 },
    );
  } catch (error) {
    const failure = unsafeDirectoryProbe(error?.code === 'ETIMEDOUT' ? 'timeout' : 'probe-unavailable');
    const diagnostic = boundedProbeDiagnostic(error?.message || String(error), root);
    return diagnostic ? { ...failure, diagnostic } : failure;
  }
  if (result.error) {
    const failure = unsafeDirectoryProbe(result.error.code === 'ETIMEDOUT' ? 'timeout' : 'probe-unavailable');
    const diagnostic = boundedProbeDiagnostic(result.error.message, root);
    return diagnostic ? { ...failure, diagnostic } : failure;
  }
  if (result.status !== 0) {
    const failure = unsafeDirectoryProbe('probe-failed');
    const diagnostic = boundedProbeDiagnostic(result.stderr || result.stdout, root);
    return diagnostic ? { ...failure, diagnostic } : failure;
  }

  try {
    const value = JSON.parse(String(result.stdout || '').trim());
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        typeof value.safe !== 'boolean' || typeof value.reason !== 'string' ||
        !Number.isSafeInteger(value.checked) || value.checked < 0) {
      return unsafeDirectoryProbe('invalid-probe-result');
    }
    if (value.safe && (value.reason !== 'safe' || value.checked < 1)) return unsafeDirectoryProbe('invalid-probe-result');
    if (!value.safe && value.reason === 'safe') return unsafeDirectoryProbe('invalid-probe-result', value.checked);
    return { safe: value.safe, reason: value.reason, checked: value.checked };
  } catch {
    const failure = unsafeDirectoryProbe('invalid-probe-result');
    const diagnostic = boundedProbeDiagnostic(result.stderr || result.stdout, root);
    return diagnostic ? { ...failure, diagnostic } : failure;
  }
}
