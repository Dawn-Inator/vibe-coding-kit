import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStaticFrontendDelivery } from '../../src/contracts/static-frontend-delivery.mjs';

const revision = 'a'.repeat(40);
const otherRevision = 'b'.repeat(40);
const valid = () => ({
  schemaVersion: 1,
  publication: {
    strategy: 'fenced-lease',
    runtimePointerReadback: true,
    lease: { acquireConditionally: true, fenceEverySideEffect: true, staleOwnerRejected: true },
    mutationCoverage: ['host-flip', 'pointer-update', 'garbage-collection'],
  },
  targets: [
    {
      project: 'sample', environment: 'test', surface: 'web', purpose: 'browser assets', version: revision, storeId: 'site-content',
      artifact: {
        kind: 'public-asset', keySegments: ['_assets', 'web', revision], access: 'public',
        cacheControl: 'public, max-age=31536000, immutable',
        retention: { policy: 'minimum-days', minimumDays: 30, preserveReferenced: true },
        rollback: { currentReadable: true, previousVersions: 2, graceHours: 720 },
      },
    },
    {
      project: 'sample', environment: 'test', surface: 'web', purpose: 'server-rendered shell template', version: revision, storeId: 'site-content',
      artifact: {
        kind: 'private-template', keySegments: ['_shell', 'web', revision], access: 'private', cacheControl: 'no-store',
        retention: { policy: 'minimum-days', minimumDays: 30, preserveReferenced: true },
        rollback: { currentReadable: true, previousVersions: 1, graceHours: 24 },
      },
    },
    {
      project: 'sample', environment: 'test', surface: 'web', purpose: 'current release pointer', version: revision, storeId: 'site-content',
      artifact: {
        kind: 'live-pointer', keySegments: ['_live', 'web.json'], access: 'private', cacheControl: 'no-store',
        retention: { policy: 'indefinite', preserveReferenced: true },
        rollback: { currentReadable: true, previousVersions: 1, graceHours: 24 },
      },
    },
    {
      project: 'sample', environment: 'test', surface: 'web', purpose: 'downloadable site archive', version: revision, storeId: 'site-content',
      artifact: {
        kind: 'private-archive', keySegments: ['_site', 'app', `${revision}.tar.gz`], access: 'private', cacheControl: 'no-store',
        retention: { policy: 'minimum-days', minimumDays: 30, preserveReferenced: true },
        rollback: { currentReadable: true, previousVersions: 1, graceHours: 24 },
      },
    },
    {
      project: 'sample', environment: 'test', surface: 'web', purpose: 'browser document', version: revision, storeId: 'site-content',
      artifact: {
        kind: 'public-document', keySegments: ['index', revision, 'index.html'], access: 'public',
        cacheControl: 'public, max-age=0, must-revalidate',
        retention: { policy: 'minimum-days', minimumDays: 30, preserveReferenced: true },
        rollback: { currentReadable: true, previousVersions: 1, graceHours: 24 },
      },
    },
  ],
});

test('accepts distinct public assets, private templates/archives/pointers, and revalidated documents', () => {
  const outcome = validateStaticFrontendDelivery(valid());
  assert.deepEqual(outcome, { ok: true, errors: [] });
  assert.ok(Object.isFrozen(outcome));
  assert.ok(Object.isFrozen(outcome.errors));
});

test('rejects traversal and encoded path material', () => {
  const config = valid();
  config.targets[0].artifact.keySegments = ['_assets', 'web', '..'];
  config.targets[1].artifact.keySegments = ['_shell', '%2e%2e', revision];
  const errors = validateStaticFrontendDelivery(config).errors;
  assert.ok(errors.some(({ code }) => code === 'path.segment'));
});

test('detects overlapping prefixes in the same physical store across logical projects', () => {
  const config = valid();
  config.targets[1].project = 'another-project';
  config.targets[1].environment = 'production';
  config.targets[1].surface = 'admin';
  config.targets[1].artifact.keySegments = ['_assets', 'web', revision, 'locale'];
  const errors = validateStaticFrontendDelivery(config).errors;
  assert.ok(errors.some(({ code }) => code === 'path.prefix-overlap'));
});

test('enforces public/private class boundaries, cache rules, and versioned immutable keys', () => {
  const config = valid();
  config.targets[0].artifact.keySegments = ['_assets', 'web', 'current'];
  config.targets[0].artifact.cacheControl = 'public, max-age=3600';
  config.targets[1].artifact.access = 'public';
  config.targets[2].artifact.access = 'public';
  config.targets[4].artifact.cacheControl = 'public, max-age=31536000, immutable';
  const errors = validateStaticFrontendDelivery(config).errors;
  for (const code of ['path.version-required', 'cache.immutable-required', 'access.class-mismatch', 'cache.document-revalidation']) {
    assert.ok(errors.some((error) => error.code === code), `expected ${code}`);
  }
});

test('public documents accept no-store and must-revalidate, but not long-lived immutable caching', () => {
  const config = valid();
  config.targets[4].artifact.cacheControl = 'public, no-store';
  assert.equal(validateStaticFrontendDelivery(config).ok, true);
  config.targets[4].artifact.cacheControl = 'public, max-age=31536000, immutable';
  assert.ok(validateStaticFrontendDelivery(config).errors.some(({ code }) => code === 'cache.document-revalidation'));
});

test('accepts canonical SHA-bound archives and rejects filenames bound to another revision', () => {
  const config = valid();
  config.targets[3].artifact.keySegments[2] = `${revision}.tar.gz.sha256`;
  assert.equal(validateStaticFrontendDelivery(config).ok, true);
  config.targets[3].artifact.keySegments[2] = `${otherRevision}.tar.gz`;
  assert.ok(validateStaticFrontendDelivery(config).errors.some(({ code }) => code === 'path.archive-version'));
});

test('stable private pointers have no automatic expiry and referenced artifacts survive age-based GC', () => {
  const config = valid();
  config.targets[2].artifact.retention = { policy: 'minimum-days', minimumDays: 365, preserveReferenced: true };
  config.targets[3].artifact.retention.preserveReferenced = false;
  const errors = validateStaticFrontendDelivery(config).errors;
  assert.ok(errors.some(({ code }) => code === 'retention.pointer-expiry'));
  assert.ok(errors.some(({ code }) => code === 'retention.references'));
});

test('requires publication concurrency invariants and retention that covers rollback grace', () => {
  const config = valid();
  config.publication.lease.fenceEverySideEffect = false;
  config.publication.mutationCoverage = ['host-flip', 'pointer-update'];
  config.targets[0].artifact.retention.minimumDays = 7;
  config.targets[0].artifact.rollback.graceHours = 720;
  config.targets[1].artifact.rollback.previousVersions = 0;
  const errors = validateStaticFrontendDelivery(config).errors;
  for (const code of ['publication.fencing', 'publication.mutation-coverage', 'retention.rollback-window', 'rollback.previous']) {
    assert.ok(errors.some((error) => error.code === code), `expected ${code}`);
  }
});

function durableMutex(config = valid()) {
  config.publication = {
    strategy: 'durable-mutex',
    runtimePointerReadback: true,
    mutex: {
      createOnlyAcquire: true,
      automaticExpiry: false,
      automaticTakeover: false,
      ownerProvenReentry: true,
      holdsAcross: ['host-flip', 'pointer-update', 'garbage-collection'],
      singleReleaseAfterIOSettled: true,
      uncertainOutcome: 'retain-lock',
      recoveryRequiresQuiescence: true,
      stuckLockLeavesServingAvailable: true,
      controlRecord: {
        storeId: 'site-content', keySegments: ['_control', 'deployment.lock'],
        access: 'private', cdnServed: false, automaticExpiry: false, ageBasedGc: false,
      },
    },
  };
  return config;
}

test('accepts a durable exclusive mutex without requiring conditional pointer mutation', () => {
  const config = durableMutex();
  assert.equal('conditionalPointerUpdate' in config.publication, false);
  assert.equal(validateStaticFrontendDelivery(config).ok, true);
});

test('rejects a TTL/takeover mutex and any mutation left outside its exclusion scope', () => {
  const config = durableMutex();
  config.publication.mutex.automaticExpiry = true;
  config.publication.mutex.automaticTakeover = true;
  config.publication.mutex.holdsAcross = ['host-flip', 'pointer-update'];
  const errors = validateStaticFrontendDelivery(config).errors;
  for (const code of ['publication.mutex-expiry', 'publication.mutation-coverage']) {
    assert.ok(errors.some((error) => error.code === code), `expected ${code}`);
  }
});

test('uncertain I/O retains the durable mutex and its control record is private and unexpired', () => {
  const config = durableMutex();
  config.publication.mutex.uncertainOutcome = 'unlock';
  config.publication.mutex.singleReleaseAfterIOSettled = false;
  config.publication.mutex.controlRecord.cdnServed = true;
  config.publication.mutex.controlRecord.automaticExpiry = true;
  config.publication.mutex.controlRecord.ageBasedGc = true;
  const errors = validateStaticFrontendDelivery(config).errors;
  for (const code of ['publication.mutex-uncertain', 'publication.mutex-safety', 'publication.control-cdn', 'publication.control-expiry', 'publication.control-gc']) {
    assert.ok(errors.some((error) => error.code === code), `expected ${code}`);
  }
});

test('does not convert declared configuration into observed or accepted runtime proof', () => {
  const outcome = validateStaticFrontendDelivery(valid());
  assert.deepEqual(Object.keys(outcome).sort(), ['errors', 'ok']);
  assert.equal('observed' in outcome, false);
  assert.equal('accepted' in outcome, false);
});
