import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);
const SAFE_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR',
  'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'CI',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);
const VERSION_RE = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/i;
const minimumVersions = { node22: [22, 0, 0] };

function safeEnv(env) {
  const safe = Object.fromEntries(Object.entries(env ?? {}).filter(([key, value]) => SAFE_ENV_KEYS.has(key) && typeof value === 'string'));
  return safe;
}

async function defaultRunner(command, args, options) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    if (error.code === 'ENOENT') return { code: 127, stdout: '', stderr: 'command not found' };
    return { code: Number.isInteger(error.code) ? error.code : (Number.isInteger(error.status) ? error.status : 1), stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) };
  }
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function rejectSymlinks(root, path) {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('optional source contains a symlink');
  }
}

function componentDirectory(kitRoot, component) {
  if (!component || typeof component !== 'object' || typeof component.id !== 'string' || typeof component.path !== 'string' || isAbsolute(component.path)) {
    throw new Error('invalid optional component descriptor');
  }
  const root = resolve(kitRoot);
  const path = resolve(root, component.path);
  if (!inside(root, path)) throw new Error('optional component path escapes kit root');
  rejectSymlinks(root, path);
  if (existsSync(path)) {
    const realRoot = realpathSync(root), realPath = realpathSync(path);
    if (!inside(realRoot, realPath)) throw new Error('optional component path escapes kit root');
  }
  return path;
}

function supportsDeclaredPlatform(component, platform, arch) {
  if (component?.platforms === undefined) return true;
  if (!Array.isArray(component.platforms) || !component.platforms.every((value) => typeof value === 'string')) {
    throw new Error('invalid optional component platforms metadata');
  }
  return component.platforms.includes('*') || component.platforms.includes(platform) || component.platforms.includes(`${platform}-${arch}`);
}

function result(status, message, details = {}) {
  return { status, ...(message ? { message } : {}), ...details };
}

function parseVersion(text) {
  const match = VERSION_RE.exec(String(text ?? ''));
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  if (!actual) return null;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function requirementsFor(component) {
  if (Array.isArray(component.requirements)) return component.requirements;
  if (component.requirements && typeof component.requirements === 'object') return Object.entries(component.requirements).map(([name, value]) => ({ name, ...(typeof value === 'object' ? value : { minimum: value }) }));
  return [];
}

function requirementSpec(requirement) {
  if (typeof requirement === 'string') requirement = { command: requirement };
  if (!requirement || typeof requirement !== 'object') throw new Error('invalid optional requirement descriptor');
  const rawCommand = requirement.command ?? requirement.name ?? requirement.id;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) throw new Error('invalid optional requirement name');
  // Catalog commands are argv-like strings, not shell snippets. Reject shell operators
  // and pass each token as an argument to execFile so metadata cannot execute a shell.
  if (/[;&|<>`$()\n\r]/.test(rawCommand)) throw new Error('invalid shell syntax in optional requirement');
  const tokens = rawCommand.trim().split(/\s+/);
  const command = tokens[0];
  const name = requirement.name ?? command;
  const args = Array.isArray(requirement.args) && requirement.args.every((arg) => typeof arg === 'string') ? requirement.args : tokens.slice(1);
  return { ...requirement, name, command, args };
}

async function run(runner, command, args, cwd, env) {
  const value = await runner(command, args, { cwd, env: safeEnv(env), timeoutMs: 60_000 });
  if (!value || typeof value !== 'object' || !Number.isInteger(value.code)) throw new Error(`invalid result from ${command}`);
  return { ...value, stdout: String(value.stdout ?? ''), stderr: String(value.stderr ?? '') };
}

async function inspectCommandRequirement(requirement, context) {
  const spec = requirementSpec(requirement);
  const response = await run(context.runner, spec.command, spec.args, context.cwd, context.env);
  if (response.code !== 0) {
    if (response.code === 127 || response.errorCode === 'ENOENT' || (spec.command === 'npx' && response.code === 1)) return { name: spec.name, installed: false, message: `${spec.name} is not installed` };
    throw new Error(`${spec.name} probe failed (exit ${response.code})`);
  }
  const version = parseVersion(response.stdout) ?? parseVersion(response.stderr);
  if (spec.minimumVersion || spec.minimum) {
    const minimum = Array.isArray(spec.minimumVersion ?? spec.minimum)
      ? [...(spec.minimumVersion ?? spec.minimum)]
      : String(spec.minimumVersion ?? spec.minimum).replace(/^v/, '').split('.').map(Number);
    if (minimum.length < 1 || minimum.length > 3 || minimum.some((part) => !Number.isInteger(part) || part < 0)) throw new Error(`invalid minimum version for ${spec.name}`);
    while (minimum.length < 3) minimum.push(0);
    if (!version) throw new Error(`${spec.name} version is unknown`);
    if (!versionAtLeast(version, minimum)) return { name: spec.name, installed: false, version: version.join('.'), message: `${spec.name} ${minimum.join('.')} or newer is required` };
  }
  return { name: spec.name, installed: true, ...(version ? { version: version.join('.') } : {}) };
}

async function inspectRegularComponent(component, context) {
  const checks = [];
  for (const requirement of requirementsFor(component)) {
    const spec = requirementSpec(requirement);
    if (component.id === 'hyperframes' && spec.command === 'npx') {
      // npx's no-install mode avoids downloading a package during detection.
      const args = npxArgs(spec.args, '--no-install');
      checks.push(await inspectCommandRequirement({ ...spec, args }, context));
    } else checks.push(await inspectCommandRequirement(spec, context));
  }

  // These packages have documented CLI prerequisites even when their catalog entry
  // omits an explicit requirement list.
  if (component.id === 'hyperframes' && !requirementsFor(component).length) {
    const node = await inspectCommandRequirement({ name: 'Node.js', command: 'node', args: ['--version'], minimumVersion: minimumVersions.node22 }, context);
    const ffmpeg = await inspectCommandRequirement({ name: 'FFmpeg', command: 'ffmpeg', args: ['-version'] }, context);
    checks.push(node, ffmpeg);
  }
  if (component.id === 'lark' && !requirementsFor(component).length) {
    checks.push(await inspectCommandRequirement({ name: 'lark-cli', command: 'lark-cli', args: ['--version'] }, context));
  }
  if (!checks.length) return result('installed', undefined, { component: component.id, checks });
  const missing = checks.filter((check) => !check.installed);
  return missing.length
    ? result('missing', missing.map((item) => item.message).join('; '), { component: component.id, checks })
    : result('installed', undefined, { component: component.id, checks });
}

function contextFor(options, component, directory) {
  const env = options.env ?? process.env;
  return {
    ...options,
    component,
    cwd: directory,
    env,
    home: env.HOME || env.USERPROFILE || homedir(),
    platform: options.platform ?? process.platform,
    arch: options.arch ?? process.arch,
    runner: options.runner ?? defaultRunner,
    lstat: options.lstat ?? lstatSync,
  };
}

export async function inspectOptionalComponent(options) {
  try {
    const { kitRoot, component } = options ?? {};
    if (!kitRoot) throw new Error('kitRoot is required');
    const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
    if (!supportsDeclaredPlatform(component, platform, arch)) return result('unsupported', `This component does not support ${platform}-${arch}.`);
    const directory = componentDirectory(kitRoot, component);
    const context = contextFor({ ...options, platform, arch }, component, directory);
    return await inspectRegularComponent(component, context);
  } catch (error) {
    return result('error', error instanceof Error ? error.message : String(error));
  }
}

async function installLark(component, context) {
  const probe = await inspectRegularComponent(component, context);
  if (probe.status === 'installed') return probe;
  if (probe.status === 'error') return probe;
  const node = await inspectCommandRequirement({ name: 'npm', command: 'npm', args: ['--version'] }, context);
  if (!node.installed) return result('setup-required', 'Install Node.js with npm, then rerun optional component setup.');
  const installed = await run(context.runner, 'npm', ['install', '--global', '@larksuite/cli'], context.cwd, context.env);
  if (installed.code !== 0) return result('error', `lark-cli installation failed (exit ${installed.code}).`);
  const after = await inspectRegularComponent(component, context);
  if (after.status === 'installed') return after;
  return after.status === 'error' ? after : result('setup-required', 'The installation completed but lark-cli --version did not confirm a usable CLI.');
}

async function installHyperframes(component, context) {
  const required = requirementsFor(component);
  const nodeRequirement = required.find((entry) => requirementSpec(entry).command === 'node') ?? { command: 'node --version', minimumVersion: '22' };
  const ffmpegRequirement = required.find((entry) => requirementSpec(entry).command === 'ffmpeg') ?? { command: 'ffmpeg -version' };
  const cliRequirement = required.find((entry) => requirementSpec(entry).command === 'npx') ?? { command: 'npx hyperframes --version' };
  const nodeCheck = await inspectCommandRequirement(nodeRequirement, context);
  if (!nodeCheck.installed) return result('setup-required', 'Install Node.js 22 or newer, then rerun optional component setup.');
  let ffmpeg = await inspectCommandRequirement(ffmpegRequirement, context);
  if (!ffmpeg.installed) {
    if (context.platform !== 'darwin') return result('setup-required', 'Install FFmpeg using the operating system package manager, then rerun optional component setup.');
    const brew = await inspectCommandRequirement({ command: 'brew --version' }, context);
    if (!brew.installed) return result('setup-required', 'Install FFmpeg. Homebrew is not already available, so no package manager was bootstrapped.');
    const brewInstall = await run(context.runner, 'brew', ['install', 'ffmpeg'], context.cwd, context.env);
    if (brewInstall.code !== 0) return result('error', `Homebrew could not install FFmpeg (exit ${brewInstall.code}).`);
    ffmpeg = await inspectCommandRequirement(ffmpegRequirement, context);
    if (!ffmpeg.installed) return result('setup-required', 'Homebrew completed, but ffmpeg --version did not verify the installation.');
  }
  const cliSpec = requirementSpec(cliRequirement);
  const cli = await inspectCommandRequirement({ ...cliSpec, args: npxArgs(cliSpec.args, '--no-install') }, context);
  if (cli.installed) return result('installed', undefined, { component: component.id, checks: [nodeCheck, ffmpeg, cli] });
  if (cli.message?.includes('not installed')) {
    const install = await run(context.runner, 'npx', npxArgs(cliSpec.args, '--yes'), context.cwd, context.env);
    if (install.code !== 0) return result('error', `HyperFrames CLI setup failed (exit ${install.code}).`);
    const after = await inspectCommandRequirement({ ...cliSpec, args: npxArgs(cliSpec.args, '--no-install') }, context);
    return after.installed ? result('installed', undefined, { component: component.id, checks: [nodeCheck, ffmpeg, after] }) : result('setup-required', 'The HyperFrames command could not be verified after setup.');
  }
  return result('error', cli.message ?? 'HyperFrames CLI probe failed.');
}

function npxArgs(args, mode) {
  const packageArgs = args[0] === '--yes' || args[0] === '--no-install' ? args.slice(1) : args;
  return [mode, ...packageArgs];
}

export async function installOptionalComponent(options) {
  try {
    const { kitRoot, component } = options ?? {};
    if (!kitRoot) throw new Error('kitRoot is required');
    const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
    if (!supportsDeclaredPlatform(component, platform, arch)) return result('unsupported', `This component does not support ${platform}-${arch}.`);
    const directory = componentDirectory(kitRoot, component);
    const context = contextFor({ ...options, kitRoot, platform, arch }, component, directory);
    if (component.id === 'lark') return await installLark(component, context);
    if (component.id === 'hyperframes') return await installHyperframes(component, context);
    const inspection = await inspectRegularComponent(component, context);
    return inspection.status === 'installed' ? inspection : result('setup-required', inspection.message ?? `No automated installation method is defined for ${component.id}.`, { component: component.id });
  } catch (error) {
    return result('error', error instanceof Error ? error.message : String(error));
  }
}
