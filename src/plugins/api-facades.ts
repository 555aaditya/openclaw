import { bindPluginCliProgram } from "./cli-callback-binding.js";
import { pluginInstanceState, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import type { OpenClawPluginCliRegistrar } from "./plugin-registration.types.js";
import type { OpenClawPluginApi } from "./types.js";

type PluginApiFacadeFields = Pick<OpenClawPluginApi, "agent" | "lifecycle" | "session">;
/** Plugin API shape without nested facade namespaces attached. */
export type OpenClawPluginApiWithoutFacades = Omit<OpenClawPluginApi, keyof PluginApiFacadeFields>;
type PluginApiFacadeSource = OpenClawPluginApi["session"]["workflow"] &
  OpenClawPluginApi["agent"]["events"] &
  Pick<OpenClawPluginApi["lifecycle"], "registerRuntimeLifecycle">;

const identitySensitiveRegistrations = new Set([
  "registerDecisionProvider",
  "registerHttpRoute",
  "registerImageGenerationProvider",
  "registerMediaUnderstandingProvider",
  "registerMusicGenerationProvider",
  "registerRealtimeTranscriptionProvider",
  "registerRealtimeVoiceProvider",
  "registerSpeechProvider",
  "registerTranscriptSourceProvider",
  "registerVideoGenerationProvider",
  "registerWebFetchProvider",
  "registerWebSearchProvider",
]);

/** Attaches nested facade namespaces to the flat plugin API implementation. */
export function attachPluginApiFacades<T extends object>(
  api: T & PluginApiFacadeSource & Partial<PluginApiFacadeFields>,
): T & PluginApiFacadeFields {
  api.session = {
    workflow: {
      enqueueNextTurnInjection: (...args) => api.enqueueNextTurnInjection(...args),
    },
  };
  api.agent = {
    events: {
      registerAgentEventSubscription: (...args) => api.registerAgentEventSubscription(...args),
    },
  };
  api.lifecycle = {
    ...api.lifecycle,
    registerRuntimeLifecycle: (...args) => api.registerRuntimeLifecycle(...args),
  };
  return api as T & PluginApiFacadeFields;
}

/** Registration callbacks and their API retain the exact admitted instance. */
export function instrumentPluginInstanceApi(
  api: OpenClawPluginApi,
  instance?: PluginInstanceHandle,
): OpenClawPluginApi {
  if (!instance) {
    return api;
  }
  api.lifecycle = { ...api.lifecycle, ...instance.lifecycle };
  const instrumented = attachPluginApiFacades(
    new Proxy(api, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (
          typeof value !== "function" ||
          typeof key !== "string" ||
          (!key.startsWith("register") && key !== "on")
        ) {
          return value;
        }
        if (key === "registerCli") {
          return (registrar: OpenClawPluginCliRegistrar, ...options: unknown[]) =>
            instance.run(() =>
              Reflect.apply(value, target, [
                instance.wrap(async (context: Parameters<OpenClawPluginCliRegistrar>[0]) => {
                  const [{ withPluginCliServiceScheduler }, { toPluginCommandFailure }] =
                    await Promise.all([
                      import("./cli-service-scheduler.js"),
                      import("../cli/failure-output.js"),
                    ]);
                  // Commander retains callbacks beyond this registrar's invocation.
                  // Bind at the typed host boundary, without proxying its native objects.
                  return withPluginCliServiceScheduler(instance, () => {
                    bindPluginCliProgram(context.program, toPluginCommandFailure);
                    return registrar(context);
                  });
                }),
                ...options.map((option) => instance.wrap(option)),
              ]),
            );
        }
        return (...args: unknown[]) =>
          instance.run(() =>
            Reflect.apply(
              value,
              target,
              args.map((arg) =>
                identitySensitiveRegistrations.has(key) ? instance.adopt(arg) : instance.wrap(arg),
              ),
            ),
          );
      },
    }),
  );
  pluginInstanceState.values.setHost(instrumented, instance);
  return instrumented;
}
