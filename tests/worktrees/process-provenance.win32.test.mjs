// platform-gate: win32-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probeWindowsDirectoryDeleteSafety } from '../../src/lib/windows-process.mjs';

test('probeWindowsDirectoryDeleteSafety: live Windows child CWD blocks its nested directory, then succeeds after exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-delete-probe-'));
  const nested = join(root, 'nested', 'deeper');
  await mkdir(nested, { recursive: true });
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
    cwd: nested,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  });
  let whileLive;
  let afterExit;
  try {
    await once(child, 'spawn');
    whileLive = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(whileLive.safe, false, JSON.stringify(whileLive));
    assert.ok(whileLive.checked >= 1);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    afterExit = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(afterExit.safe, true, JSON.stringify(afterExit));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('probeWindowsDirectoryDeleteSafety: Windows DELETE denial is reported unsafe and ACL is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vibe-delete-denied-'));
  const denied = join(root, 'denied');
  await mkdir(denied);
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  assert.ok(systemRoot, 'Windows SystemRoot is required to resolve native ACL utilities');
  const powershellExe = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodePath = (path) => Buffer.from(path, 'utf16le').toString('base64');
  const rootPath = encodePath(root);
  const deniedPath = encodePath(denied);
  const icaclsExePath = encodePath(join(systemRoot, 'System32', 'icacls.exe'));
  const whoamiExePath = encodePath(join(systemRoot, 'System32', 'whoami.exe'));
  const powershell = (script) => spawnSync(powershellExe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  const captureDacl = (encodedPath) => powershell(`$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $acl = Get-Acl -LiteralPath $path; [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`);
  const restoreScript = (encodedPath, originalDacl) => `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $sddl = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${originalDacl}')); $acl = Get-Acl -LiteralPath $path; $acl.SetSecurityDescriptorSddlForm($sddl, [Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $path -AclObject $acl`;
  const captureRoot = captureDacl(rootPath);
  const captureDenied = captureDacl(deniedPath);
  if (captureRoot.status !== 0 || captureDenied.status !== 0 || !String(captureRoot.stdout || '').trim() || !String(captureDenied.stdout || '').trim()) {
    await rm(root, { recursive: true, force: true });
    assert.fail(captureRoot.stderr || captureDenied.stderr || captureRoot.stdout || captureDenied.stdout || 'failed to capture fixture ACLs');
  }
  const originalRootDacl = String(captureRoot.stdout).trim();
  const originalDeniedDacl = String(captureDenied.stdout).trim();
  const applyDeny = (encodedPath, rights) => powershell(`$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User; $rights = [Security.AccessControl.FileSystemRights]::${rights}; $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, $rights, [Security.AccessControl.AccessControlType]::Deny); $acl = Get-Acl -LiteralPath $path; $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl`);
  const readbackScript = `$root = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${rootPath}')); $denied = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${deniedPath}')); $icaclsExe = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${icaclsExePath}')); $whoamiExe = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${whoamiExePath}')); $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User; $sid = $identity.Value; $account = $identity.Translate([Security.Principal.NTAccount]).Value; $delete = [int][Security.AccessControl.FileSystemRights]::Delete; $deleteChild = [int][Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles; function Read-Acl($path, $delete, $deleteChild, $sid, $icaclsExe) { $acl = Get-Acl -LiteralPath $path; $rules = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid } | ForEach-Object { [pscustomobject]@{ rights = [int]$_.FileSystemRights; inherited = [bool]$_.IsInherited; inheritanceFlags = [string]$_.InheritanceFlags } }); $mask = 0; foreach ($entry in $rules) { $mask = $mask -bor $entry.rights }; [pscustomobject]@{ path = $path; rules = $rules; deniesDelete = (($mask -band $delete) -ne 0); deniesDeleteChild = (($mask -band $deleteChild) -ne 0); icacls = @(& $icaclsExe $path /c 2>&1 | ForEach-Object { [string]$_ }) } }; $rootAcl = Read-Acl $root $delete $deleteChild $sid $icaclsExe; $deniedAcl = Read-Acl $denied $delete $deleteChild $sid $icaclsExe; $parentIcacls = @(& $icaclsExe (Split-Path -Parent $root) /c 2>&1 | ForEach-Object { [string]$_ }); $privileges = @(& $whoamiExe /priv /fo csv /nh 2>&1 | ForEach-Object { [string]$_ }); $whoami = @(& $whoamiExe /user /fo csv /nh 2>&1 | ForEach-Object { [string]$_ }); [pscustomobject]@{ sid = $sid; account = $account; whoami = $whoami; privileges = $privileges; root = $rootAcl; denied = $deniedAcl; parentIcacls = $parentIcacls } | ConvertTo-Json -Compress -Depth 5`;
  let rootDenyAttempted = false;
  let deniedDenyAttempted = false;
  try {
    rootDenyAttempted = true;
    const rootApplied = applyDeny(rootPath, 'DeleteSubdirectoriesAndFiles');
    assert.equal(rootApplied.status, 0, rootApplied.stderr || rootApplied.stdout || 'failed to deny parent FILE_DELETE_CHILD on the fixture root');
    deniedDenyAttempted = true;
    const deniedApplied = applyDeny(deniedPath, 'Delete');
    assert.equal(deniedApplied.status, 0, deniedApplied.stderr || deniedApplied.stdout || 'failed to deny DELETE on the nested fixture directory');

    const readback = powershell(readbackScript);
    assert.equal(readback.status, 0, readback.stderr || readback.stdout || 'failed to read back temporary deny ACL');
    const acl = JSON.parse(readback.stdout.trim());
    const diagnostic = JSON.stringify(acl);
    const rootRules = Array.isArray(acl.root?.rules) ? acl.root.rules : [acl.root?.rules].filter(Boolean);
    const deniedRules = Array.isArray(acl.denied?.rules) ? acl.denied.rules : [acl.denied?.rules].filter(Boolean);
    const rootIcacls = Array.isArray(acl.root?.icacls) ? acl.root.icacls : [acl.root?.icacls].filter(Boolean);
    const deniedIcacls = Array.isArray(acl.denied?.icacls) ? acl.denied.icacls : [acl.denied?.icacls].filter(Boolean);
    const whoamiLines = Array.isArray(acl.whoami) ? acl.whoami : [acl.whoami].filter(Boolean);
    const privilegeLines = Array.isArray(acl.privileges) ? acl.privileges : [acl.privileges].filter(Boolean);
    assert.ok(acl.sid, `current token SID missing from readback: ${diagnostic}`);
    assert.ok(whoamiLines.some((line) => line.includes(acl.sid)), `whoami /user SID does not match the ACL principal: ${diagnostic}`);
    const backupEnabled = privilegeLines.some((line) => /"SeBackupPrivilege".*"Enabled"/.test(line));
    const restoreEnabled = privilegeLines.some((line) => /"SeRestorePrivilege".*"Enabled"/.test(line));
    if (process.env.VIBE_KIT_REQUIRE_PRIVILEGED_DELETE_PROOF === '1') {
      assert.ok(backupEnabled, `native proof requires enabled SeBackupPrivilege to exercise the bypass regression: ${diagnostic}`);
      assert.ok(restoreEnabled, `native proof requires enabled SeRestorePrivilege to exercise the bypass regression: ${diagnostic}`);
    }
    assert.ok(acl.root?.deniesDeleteChild, `explicit current-token FILE_DELETE_CHILD deny missing on fixture parent: ${diagnostic}`);
    assert.ok(acl.denied?.deniesDelete, `explicit current-token DELETE deny missing on nested directory: ${diagnostic}`);
    assert.ok(rootRules.some((rule) => !rule.inherited), `no explicit parent deny ACE for the current token: ${diagnostic}`);
    assert.ok(deniedRules.some((rule) => !rule.inherited), `no explicit child deny ACE for the current token: ${diagnostic}`);
    assert.ok(rootIcacls.some((line) => (line.includes(acl.sid) || line.includes(acl.account)) && /\(DENY\)/.test(line) && /\bDC\b/.test(line)), `icacls did not confirm FILE_DELETE_CHILD deny on fixture parent: ${diagnostic}`);
    assert.ok(deniedIcacls.some((line) => (line.includes(acl.sid) || line.includes(acl.account)) && /\(DENY\)/.test(line) && /\bD(?:E)?\b/.test(line)), `icacls did not confirm DELETE deny on nested directory: ${diagnostic}`);

    const result = probeWindowsDirectoryDeleteSafety(root);
    assert.equal(result.safe, false, `${JSON.stringify(result)}; ACL readback: ${diagnostic}`);
    assert.equal(result.reason, 'access-denied', `${JSON.stringify(result)}; ACL readback: ${diagnostic}`);
  } finally {
    if (deniedDenyAttempted) {
      const restored = powershell(restoreScript(deniedPath, originalDeniedDacl));
      assert.equal(restored.status, 0, restored.stderr || restored.stdout || 'failed to restore nested fixture ACL');
    }
    if (rootDenyAttempted) {
      const restored = powershell(restoreScript(rootPath, originalRootDacl));
      assert.equal(restored.status, 0, restored.stderr || restored.stdout || 'failed to restore fixture-parent ACL');
    }
    await rm(root, { recursive: true, force: true });
  }
});
