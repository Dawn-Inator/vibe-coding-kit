export type StaticFrontendArtifactKind = 'public-asset' | 'public-document' | 'private-template' | 'private-archive' | 'live-pointer';

export interface StaticFrontendDeliveryTarget {
  readonly project: string;
  readonly environment: string;
  readonly surface: string;
  readonly purpose: string;
  /** Stable provider-neutral identity for the physical object namespace. */
  readonly storeId: string;
  /** Required true only when the project explicitly approves a public origin. */
  readonly publicOriginApproved?: boolean;
  /** Full lowercase source revision SHA-1 or SHA-256. */
  readonly version: string;
  readonly artifact: {
    readonly kind: StaticFrontendArtifactKind;
    /** directory-prefix serializes as segments joined by `/` plus a trailing `/`; exact-object has no trailing slash. */
    readonly keyMode: 'directory-prefix' | 'exact-object';
    readonly keySegments: readonly string[];
    /** Access at the viewer-facing edge; this can be public while originAccess remains private. */
    readonly viewerAccess: 'public' | 'private';
    readonly originAccess: 'public' | 'private';
    readonly cacheControl: string;
    readonly retention: {
      readonly policy: 'minimum-days' | 'indefinite';
      readonly minimumDays?: number;
      /** Protect current, previous, and other referenced releases from age-only collection. */
      readonly preserveReferenced: boolean;
    };
    readonly rollback: {
      readonly currentReadable: boolean;
      readonly previousVersions: number;
      readonly graceHours: number;
    };
  };
}

export interface StaticFrontendDeliveryConfig {
  readonly schemaVersion: 1;
  readonly publication: StaticFrontendPublicationStrategy;
  readonly targets: readonly StaticFrontendDeliveryTarget[];
}

export interface StaticFrontendFencedLeaseStrategy {
  readonly strategy: 'fenced-lease';
  readonly runtimePointerReadback: boolean;
  readonly lease: {
    readonly acquireConditionally: boolean;
    readonly fenceEverySideEffect: boolean;
    readonly staleOwnerRejected: boolean;
  };
  readonly mutationCoverage: readonly ('host-flip' | 'pointer-update' | 'garbage-collection')[];
}

export interface StaticFrontendDurableMutexStrategy {
  readonly strategy: 'durable-mutex';
  readonly runtimePointerReadback: boolean;
  readonly mutex: {
    readonly createOnlyAcquire: boolean;
    readonly automaticExpiry: boolean;
    readonly automaticTakeover: boolean;
    readonly ownerProvenReentry: boolean;
    readonly holdsAcross: readonly ('host-flip' | 'pointer-update' | 'garbage-collection')[];
    readonly singleReleaseAfterIOSettled: boolean;
    readonly uncertainOutcome: 'retain-lock' | string;
    readonly recoveryRequiresQuiescence: boolean;
    readonly stuckLockLeavesServingAvailable: boolean;
    readonly controlRecord: {
      readonly storeId: string;
      readonly keySegments: readonly string[];
      readonly viewerAccess: 'private' | 'public';
      readonly originAccess: 'private' | 'public';
      readonly cdnServed: boolean;
      readonly automaticExpiry: boolean;
      readonly ageBasedGc: boolean;
    };
  };
}

export type StaticFrontendPublicationStrategy = StaticFrontendFencedLeaseStrategy | StaticFrontendDurableMutexStrategy;

export interface StaticFrontendDeliveryValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface StaticFrontendDeliveryValidation {
  readonly ok: boolean;
  readonly errors: readonly StaticFrontendDeliveryValidationError[];
}

/** Pure structural and policy validation; does not publish, inspect providers, or verify runtime evidence. */
export function validateStaticFrontendDelivery(value: unknown): StaticFrontendDeliveryValidation;
