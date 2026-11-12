const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ARTIFACT_KINDS = Object.freeze(['public-asset', 'public-document', 'private-template', 'private-archive', 'live-pointer']);
const PUBLIC_KINDS = new Set(['public-asset', 'public-document']);
const IMMUTABLE_KINDS = new Set(['public-asset', 'private-template', 'private-archive']);
const PREFIX_KINDS = new Set(['public-asset', 'public-document', 'private-template']);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const REQUIRED_MUTATIONS = Object.freeze(['host-flip', 'pointer-update', 'garbage-collection']);

function validPathSegments(segments, path, add) {
  if (!Array.isArray(segments) || segments.length === 0) {
    add(path, 'path.nonempty', 'keySegments must be a nonempty array of literal path segments.');
    return false;
  }
  let valid = true;
  segments.forEach((segment, index) => {
    if (typeof segment !== 'string' || !segment || segment === '.' || segment === '..' ||
        !SAFE_SEGMENT_PATTERN.test(segment) || segment.includes('..')) {
      valid = false;
      add(`${path}[${index}]`, 'path.segment', 'Path segments must be safe literal components without traversal, separators, or encoding.');
    }
  });
  return valid;
}

function isPathPrefix(prefix, path) {
  return prefix.length <= path.length && prefix.every((part, index) => part === path[index]);
}

function keysOverlap(left, right) {
  if (left.keyMode === 'exact-object' && right.keyMode === 'exact-object') {
    return left.segments.length === right.segments.length && isPathPrefix(left.segments, right.segments);
  }
  if (left.keyMode === 'directory-prefix' && right.keyMode === 'directory-prefix') {
    return isPathPrefix(left.segments, right.segments) || isPathPrefix(right.segments, left.segments);
  }
  const directory = left.keyMode === 'directory-prefix' ? left : right;
  const object = left.keyMode === 'exact-object' ? left : right;
  // A directory prefix serializes with a trailing slash, so it contains only deeper path components.
  return directory.segments.length < object.segments.length && isPathPrefix(directory.segments, object.segments);
}

function parseCacheControl(value, path, add) {
  const directives = new Map();
  let valid = true;
  for (const raw of value.split(',')) {
    const match = raw.trim().match(/^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.+))?$/u);
    if (!match || (match[2] !== undefined && !match[2].trim())) {
      add(path, 'cache.directive', 'cacheControl contains a malformed directive.');
      valid = false;
      continue;
    }
    const name = match[1].toLowerCase();
    if (directives.has(name)) {
      add(path, 'cache.duplicate-directive', `cacheControl repeats the ${name} directive.`);
      valid = false;
      continue;
    }
    directives.set(name, match[2]?.trim() ?? true);
  }

  for (const name of ['max-age', 's-maxage']) {
    if (directives.has(name) && (typeof directives.get(name) !== 'string' || !/^\d+$/u.test(directives.get(name)))) {
      add(path, 'cache.directive-value', `${name} must have a nonnegative integer value.`);
      valid = false;
    }
  }
  for (const name of ['public', 'private', 'no-store', 'no-cache', 'immutable', 'must-revalidate']) {
    if (directives.has(name) && directives.get(name) !== true) {
      add(path, 'cache.directive-value', `${name} must not have a value.`);
      valid = false;
    }
  }

  const has = (name) => directives.has(name);
  const maxAgeValue = directives.get('max-age');
  const contradictory = (has('no-store') && ['immutable', 'no-cache', 'max-age', 's-maxage', 'must-revalidate'].some(has)) ||
    (has('public') && has('private')) ||
    (has('immutable') && (has('no-cache') || has('no-store'))) ||
    (has('no-cache') && has('no-store')) ||
    (has('no-cache') && typeof maxAgeValue === 'string' && /^\d+$/u.test(maxAgeValue) && Number(maxAgeValue) > 0);
  if (contradictory) {
    add(path, 'cache.contradictory-directives', 'cacheControl combines directives with conflicting cache behavior.');
    valid = false;
  }
  return { directives, valid };
}

function validatePublication(publication, add) {
  if (!isRecord(publication)) {
    add('publication', 'type.object', 'publication must declare a supported mutation consistency strategy.');
    return null;
  }
  if (publication.runtimePointerReadback !== true) {
    add('publication.runtimePointerReadback', 'publication.readback', 'The deployed runtime pointer must be read back after publication.');
  }

  if (publication.strategy === 'fenced-lease') {
    const lease = publication.lease;
    if (!isRecord(lease)) {
      add('publication.lease', 'publication.lease-required', 'fenced-lease strategy must declare lease acquisition and fencing guarantees.');
    } else {
      for (const key of ['acquireConditionally', 'fenceEverySideEffect', 'staleOwnerRejected']) {
        if (lease[key] !== true) add(`publication.lease.${key}`, 'publication.fencing', `${key} must be true for a fenced lease.`);
      }
    }
    validateMutationCoverage(publication.mutationCoverage, 'publication.mutationCoverage', add);
    return null;
  }

  if (publication.strategy !== 'durable-mutex') {
    add('publication.strategy', 'publication.strategy', 'strategy must be fenced-lease or durable-mutex.');
    return null;
  }

  const mutex = publication.mutex;
  if (!isRecord(mutex)) {
    add('publication.mutex', 'publication.mutex-required', 'durable-mutex strategy must declare acquisition, hold, release, and recovery behavior.');
    return null;
  }
  for (const key of ['createOnlyAcquire', 'ownerProvenReentry', 'singleReleaseAfterIOSettled', 'recoveryRequiresQuiescence', 'stuckLockLeavesServingAvailable']) {
    if (mutex[key] !== true) add(`publication.mutex.${key}`, 'publication.mutex-safety', `${key} must be true for a durable mutex.`);
  }
  if (mutex.automaticExpiry !== false || mutex.automaticTakeover !== false) {
    add('publication.mutex', 'publication.mutex-expiry', 'A durable mutex must have no automatic expiry or takeover.');
  }
  if (mutex.uncertainOutcome !== 'retain-lock') {
    add('publication.mutex.uncertainOutcome', 'publication.mutex-uncertain', 'Unknown mutation outcomes must retain the mutex until explicit quiescence recovery.');
  }
  validateMutationCoverage(mutex.holdsAcross, 'publication.mutex.holdsAcross', add);

  const record = mutex.controlRecord;
  if (!isRecord(record)) {
    add('publication.mutex.controlRecord', 'publication.control-record', 'The mutex control record must declare its isolated physical key and serving/retention policy.');
    return null;
  }
  for (const key of ['storeId']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) {
      add(`publication.mutex.controlRecord.${key}`, 'value.required', `${key} must be a nonblank string.`);
    }
  }
  const validControlPath = validPathSegments(record.keySegments, 'publication.mutex.controlRecord.keySegments', add);
  if (record.viewerAccess !== 'private' || record.originAccess !== 'private') add('publication.mutex.controlRecord', 'publication.control-private', 'The mutex control record must be private to viewers and at the origin.');
  if (record.cdnServed !== false) add('publication.mutex.controlRecord.cdnServed', 'publication.control-cdn', 'The mutex control record must not be served through a CDN.');
  if (record.automaticExpiry !== false) add('publication.mutex.controlRecord.automaticExpiry', 'publication.control-expiry', 'The mutex control record must not expire automatically.');
  if (record.ageBasedGc !== false) add('publication.mutex.controlRecord.ageBasedGc', 'publication.control-gc', 'Age-based garbage collection must not remove the mutex control record.');
  return validControlPath && typeof record.storeId === 'string' && record.storeId.trim()
    ? { storeId: record.storeId, segments: record.keySegments, keyMode: 'exact-object' }
    : null;
}

function validateMutationCoverage(mutations, path, add) {
  if (!Array.isArray(mutations)) {
    add(path, 'publication.mutation-coverage', 'The consistency strategy must cover host flip, pointer update, and garbage collection.');
    return;
  }
  for (const required of REQUIRED_MUTATIONS) {
    if (!mutations.includes(required)) add(path, 'publication.mutation-coverage', `The consistency strategy does not cover ${required}.`);
  }
}

/** Validate a provider-neutral static frontend delivery declaration. Performs no I/O. */
export function validateStaticFrontendDelivery(value) {
  const errors = [];
  const add = (path, code, message) => errors.push(Object.freeze({ path, code, message }));

  if (!isRecord(value)) {
    add('$', 'type.object', 'Configuration must be an object.');
    return result(errors);
  }
  if (value.schemaVersion !== 1) add('schemaVersion', 'value.unsupported', 'schemaVersion must be 1.');
  const controlPrefix = validatePublication(value.publication, add);

  if (!Array.isArray(value.targets) || value.targets.length === 0) {
    add('targets', 'type.nonempty-array', 'targets must contain at least one declared artifact target.');
    return result(errors);
  }

  const seenPrefixes = controlPrefix ? [{ index: 'mutex control record', ...controlPrefix }] : [];
  value.targets.forEach((target, index) => {
    const base = `targets[${index}]`;
    if (!isRecord(target)) {
      add(base, 'type.object', 'Target must be an object.');
      return;
    }
    for (const key of ['project', 'environment', 'surface', 'purpose', 'storeId']) {
      if (typeof target[key] !== 'string' || !target[key].trim()) {
        add(`${base}.${key}`, 'value.required', `${key} must be a nonblank string.`);
      }
    }
    if (typeof target.version !== 'string' || !SHA_PATTERN.test(target.version)) {
      add(`${base}.version`, 'version.sha', 'version must be a full lowercase 40- or 64-character hexadecimal revision.');
    }
    if (!isRecord(target.artifact)) {
      add(`${base}.artifact`, 'type.object', 'artifact must declare its class and delivery policy.');
      return;
    }

    const artifact = target.artifact;
    const kind = artifact.kind;
    if (!ARTIFACT_KINDS.includes(kind)) {
      add(`${base}.artifact.kind`, 'value.enum', `kind must be one of: ${ARTIFACT_KINDS.join(', ')}.`);
    }

    const segments = artifact.keySegments;
    const validSegments = validPathSegments(segments, `${base}.artifact.keySegments`, add);
    const expectedKeyMode = PREFIX_KINDS.has(kind) ? 'directory-prefix' : 'exact-object';
    if (artifact.keyMode !== expectedKeyMode) {
      add(`${base}.artifact.keyMode`, 'path.key-mode', `${kind} must use ${expectedKeyMode} key semantics.`);
    }

    const hasValidVersion = typeof target.version === 'string' && SHA_PATTERN.test(target.version);
    if (validSegments && hasValidVersion) {
      const versioned = segments.includes(target.version);
      if (kind === 'private-archive') {
        const filename = segments.at(-1);
        const archiveName = `${target.version}.tar.gz`;
        if (filename !== archiveName && filename !== `${archiveName}.sha256`) {
          add(`${base}.artifact.keySegments`, 'path.archive-version', 'private-archive filename must bind exactly to version as <sha>.tar.gz or <sha>.tar.gz.sha256.');
        }
      } else if (IMMUTABLE_KINDS.has(kind) && !versioned) {
        add(`${base}.artifact.keySegments`, 'path.version-required', 'Immutable artifacts must include the declared revision as a complete path segment.');
      }
      if (kind === 'live-pointer' && segments.some((segment) => SHA_PATTERN.test(segment))) {
        add(`${base}.artifact.keySegments`, 'path.pointer-mutable', 'A live pointer key must be stable and contain no revision-shaped path segment.');
      }

      for (const prior of seenPrefixes) {
        if (target.storeId !== prior.storeId) continue;
        if (keysOverlap({ keyMode: expectedKeyMode, segments }, prior)) {
          add(`${base}.artifact.keySegments`, 'path.prefix-overlap', `Artifact key overlaps target ${prior.index} in the same physical store; prefixes must be disjoint.`);
          break;
        }
      }
      seenPrefixes.push({ index, storeId: target.storeId, keyMode: expectedKeyMode, segments });
    }

    if (!['public', 'private'].includes(artifact.viewerAccess)) {
      add(`${base}.artifact.viewerAccess`, 'value.enum', 'viewerAccess must be public or private.');
    }
    if (PUBLIC_KINDS.has(kind) && artifact.viewerAccess !== 'public') {
      add(`${base}.artifact.viewerAccess`, 'access.class-mismatch', `${kind} must be publicly readable by viewers.`);
    }
    if (['private-template', 'private-archive', 'live-pointer'].includes(kind) && artifact.viewerAccess !== 'private') {
      add(`${base}.artifact.viewerAccess`, 'access.class-mismatch', `${kind} must not be publicly readable by viewers.`);
    }
    if (!['public', 'private'].includes(artifact.originAccess)) {
      add(`${base}.artifact.originAccess`, 'value.enum', 'originAccess must be public or private.');
    } else if (['private-template', 'private-archive', 'live-pointer'].includes(kind) && artifact.originAccess !== 'private') {
      add(`${base}.artifact.originAccess`, 'access.private-origin-required', `${kind} must use a private origin.`);
    } else if (PUBLIC_KINDS.has(kind) && artifact.originAccess === 'public' && target.publicOriginApproved !== true) {
      add(`${base}.publicOriginApproved`, 'access.public-origin-approval', 'A public artifact using a publicly accessible origin requires an explicit project-level approval declaration.');
    }

    if (typeof artifact.cacheControl !== 'string') {
      add(`${base}.artifact.cacheControl`, 'cache.required', 'cacheControl must state the response caching policy.');
    } else {
      const parsed = parseCacheControl(artifact.cacheControl, `${base}.artifact.cacheControl`, add);
      const directives = parsed.directives;
      const maxAge = directives.get('max-age');
      const sharedMaxAge = directives.get('s-maxage');
      const hasPublicDirective = directives.has('public');
      if (kind === 'public-asset') {
        const validMaxAge = typeof maxAge === 'string' && /^\d+$/u.test(maxAge) && Number(maxAge) >= 31_536_000;
        const validSharedMaxAge = sharedMaxAge === undefined ||
          (typeof sharedMaxAge === 'string' && /^\d+$/u.test(sharedMaxAge) && Number(sharedMaxAge) >= 31_536_000);
        if (!hasPublicDirective || !directives.has('immutable') || directives.has('no-store') || directives.has('no-cache') ||
            !validMaxAge || !validSharedMaxAge || !parsed.valid) {
          add(`${base}.artifact.cacheControl`, 'cache.immutable-required', 'public-asset needs public, immutable caching with at least one year max-age.');
        }
      } else if (kind === 'public-document') {
        const noStore = directives.has('no-store');
        const revalidates = directives.has('no-cache') || (maxAge === '0' && directives.has('must-revalidate'));
        const positiveAge = [maxAge, sharedMaxAge].some((age) => typeof age === 'string' && /^\d+$/u.test(age) && Number(age) > 0);
        if (!hasPublicDirective || (!noStore && !revalidates) || directives.has('immutable') || positiveAge || !parsed.valid) {
          add(`${base}.artifact.cacheControl`, 'cache.document-revalidation', 'public-document must be public and use no-store or an explicit revalidation policy; long-lived immutable caching is not allowed.');
        }
      } else if (!directives.has('no-store') || !parsed.valid) {
        add(`${base}.artifact.cacheControl`, 'cache.no-store-required', `${kind} must use no-store caching.`);
      }
    }

    if (!isRecord(artifact.retention)) {
      add(`${base}.artifact.retention`, 'retention.required', 'retention must explicitly declare expiry and referenced-release handling.');
    } else {
      if (artifact.retention.preserveReferenced !== true) {
        add(`${base}.artifact.retention.preserveReferenced`, 'retention.references', 'Current, previous, and otherwise referenced releases must be protected from age-only collection.');
      }
      if (kind === 'live-pointer') {
        if (artifact.retention.policy !== 'indefinite' || hasOwn(artifact.retention, 'minimumDays')) {
          add(`${base}.artifact.retention`, 'retention.pointer-expiry', 'live-pointer must not have automatic expiry; declare policy "indefinite" without minimumDays.');
        }
      } else if (artifact.retention.policy !== 'minimum-days' || !Number.isInteger(artifact.retention.minimumDays) || artifact.retention.minimumDays < 1) {
        add(`${base}.artifact.retention`, 'retention.minimum-days', 'Non-pointer artifacts must declare a positive minimum-days retention policy.');
      }
    }
    if (!isRecord(artifact.rollback)) {
      add(`${base}.artifact.rollback`, 'rollback.required', 'rollback must declare current and previous release availability.');
    } else {
      if (artifact.rollback.currentReadable !== true) add(`${base}.artifact.rollback.currentReadable`, 'rollback.current', 'The current release must remain readable.');
      if (!Number.isInteger(artifact.rollback.previousVersions) || artifact.rollback.previousVersions < 1) {
        add(`${base}.artifact.rollback.previousVersions`, 'rollback.previous', 'At least one previous release must be retained for rollback.');
      }
      if (!Number.isInteger(artifact.rollback.graceHours) || artifact.rollback.graceHours < 0) {
        add(`${base}.artifact.rollback.graceHours`, 'rollback.grace', 'graceHours must be a nonnegative integer.');
      } else if (isRecord(artifact.retention) && Number.isInteger(artifact.retention.minimumDays) &&
          artifact.retention.minimumDays * 24 < artifact.rollback.graceHours) {
        add(`${base}.artifact.retention.minimumDays`, 'retention.rollback-window', 'Minimum retention must cover the declared rollback grace window.');
      }
    }
  });

  return result(errors);
}

function result(errors) {
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
