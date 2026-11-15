import {
  type GoalProgressIpcConnectionContext,
  type GoalProgressIpcHandler,
  GoalProgressIpcHandlerError,
  type GoalProgressIpcHandlerResult,
} from "../../ipc/src/index.js";
import type { GoalProgressLogInput } from "../../store/src/index.js";
import {
  helperDiagnosticCauseCode,
  helperErrorCode,
  toHelperHandlerError,
} from "./helper-errors.js";

type HelperIpcRequest = Parameters<GoalProgressIpcHandler>[0];
type HelperIpcMethod = HelperIpcRequest["method"];

export type HelperSystemIpcRequest = Extract<
  HelperIpcRequest,
  { method: "ping" | "runtime-proof.issue" | "runtime-proof.consume" }
>;
export type HelperHookIpcRequest = Extract<
  HelperIpcRequest,
  { method: "activation.resume" | "hook.audit" }
>;
export type HelperActivationIpcRequest = Extract<HelperIpcRequest, { method: "activation.plan" }>;
export type HelperStoreIpcRequest = Extract<
  HelperIpcRequest,
  { method: "store.load" | "store.initialize" | "store.apply" }
>;
export type HelperTaskIpcRequest = Extract<
  HelperIpcRequest,
  { method: "task.request" | "task.native-read" }
>;
export type HelperDoctorIpcRequest = Extract<HelperIpcRequest, { method: "doctor" }>;

export interface HelperIpcRoutes {
  readonly task: (
    request: HelperTaskIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
  readonly system: (
    request: HelperSystemIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
  readonly hook: (
    request: HelperHookIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
  readonly activation: (
    request: HelperActivationIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
  readonly store: (
    request: HelperStoreIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
  readonly doctor: (
    request: HelperDoctorIpcRequest,
    context: GoalProgressIpcConnectionContext,
  ) => Promise<GoalProgressIpcHandlerResult>;
}

export interface HelperIpcRouterOptions {
  readonly routes: HelperIpcRoutes;
  readonly log: (input: GoalProgressLogInput) => Promise<void>;
}

type HelperIpcRoute = keyof HelperIpcRoutes;

const ROUTE_BY_METHOD: Record<HelperIpcMethod, HelperIpcRoute> = {
  "task.request": "task",
  "task.native-read": "task",
  ping: "system",
  "runtime-proof.issue": "system",
  "runtime-proof.consume": "system",
  "activation.resume": "hook",
  "hook.audit": "hook",
  "activation.plan": "activation",
  "store.load": "store",
  "store.initialize": "store",
  "store.apply": "store",
  doctor: "doctor",
};

const ALLOWED_METHODS: Record<
  GoalProgressIpcConnectionContext["clientKind"],
  readonly HelperIpcMethod[]
> = {
  hook: ["runtime-proof.issue", "hook.audit", "activation.resume"],
  mcp: [
    "task.request",
    "task.native-read",
    "runtime-proof.consume",
    "activation.plan",
    "store.load",
    "store.initialize",
    "store.apply",
  ],
  doctor: ["doctor"],
};

function methodIsAllowed(
  method: HelperIpcMethod,
  context: GoalProgressIpcConnectionContext,
): boolean {
  return method === "ping" || ALLOWED_METHODS[context.clientKind].includes(method);
}

async function dispatch(
  routes: HelperIpcRoutes,
  request: HelperIpcRequest,
  context: GoalProgressIpcConnectionContext,
): Promise<GoalProgressIpcHandlerResult> {
  switch (ROUTE_BY_METHOD[request.method]) {
    case "task":
      return routes.task(request as HelperTaskIpcRequest, context);
    case "system":
      return routes.system(request as HelperSystemIpcRequest, context);
    case "hook":
      return routes.hook(request as HelperHookIpcRequest, context);
    case "activation":
      return routes.activation(request as HelperActivationIpcRequest, context);
    case "store":
      return routes.store(request as HelperStoreIpcRequest, context);
    case "doctor":
      return routes.doctor(request as HelperDoctorIpcRequest, context);
  }
}

export class HelperIpcRouter {
  readonly #routes: HelperIpcRoutes;
  readonly #log: HelperIpcRouterOptions["log"];

  constructor(options: HelperIpcRouterOptions) {
    this.#routes = options.routes;
    this.#log = options.log;
  }

  handler(): GoalProgressIpcHandler {
    return async (request, context) => {
      const startedAt = Date.now();
      try {
        if (!methodIsAllowed(request.method, context)) {
          throw new GoalProgressIpcHandlerError(
            "IPC_METHOD_FORBIDDEN",
            `${context.clientKind} cannot call ${request.method}`,
          );
        }
        return await dispatch(this.#routes, request, context);
      } catch (error) {
        const code = helperErrorCode(error);
        const causeCode = helperDiagnosticCauseCode(error);
        await this.#log({
          level: "error",
          event: "ipc.error",
          code,
          ...(causeCode === code ? {} : { causeCode }),
          durationMs: Date.now() - startedAt,
        });
        throw toHelperHandlerError(error);
      } finally {
        await this.#log({
          level: "info",
          event: "ipc.response",
          durationMs: Date.now() - startedAt,
        });
      }
    };
  }
}
