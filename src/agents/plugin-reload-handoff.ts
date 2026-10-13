import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type Handoff = {
  active: boolean;
  accepted: boolean;
  released: ReturnType<typeof createDeferredCore<void>>;
};

const scope = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginReloadHandoff"),
  () => new AsyncLocalStorage<Handoff>(),
);

/** The dispatch owner, not an individual model attempt, owns the final plugin borrow. */
export async function withPluginReloadHandoff<T>(run: () => Promise<T>): Promise<T> {
  if (scope.getStore()) {
    return await run();
  }
  const owner: Handoff = { active: true, accepted: false, released: createDeferredCore() };
  // Failed cleanup is still observable if acceptance itself failed before installing a waiter.
  void owner.released.promise.catch(() => {});
  try {
    const result = await scope.run(owner, run);
    owner.active = false;
    owner.released.resolve();
    return result;
  } catch (error) {
    owner.active = false;
    owner.released.reject(error);
    throw error;
  }
}

/** Captured completion is a cleanup fact only: it never grants reload authority. */
export function capturePluginReloadHandoff() {
  const owner = scope.getStore();
  return (
    owner && {
      assertAvailable() {
        if (!owner.active || owner.accepted) {
          throw new Error(
            "This turn already handed off a plugin reload or finished. Do not repeat the request.",
          );
        }
      },
      accept() {
        this.assertAvailable();
        owner.accepted = true;
        return owner.released.promise;
      },
    }
  );
}
