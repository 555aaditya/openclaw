/** Measurement only: no message contents, credentials, or session labels are collected. */
export function installWorkerBenchProbes() {
  const longTasks: Array<{ start: number; duration: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      longTasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observer.observe({ type: "longtask", buffered: true });
  Reflect.set(window, "__coldLoad", {
    read() {
      return {
        at: performance.now(),
        longTasks,
        socket: Reflect.get(window, "__gatewaySocketMetrics"),
        bridge: Reflect.get(window, "__gatewayWorkerMetrics"),
        loaf: Reflect.get(window, "__perf")?.loaf ?? [],
        mutations: Reflect.get(window, "__perf")?.mutTotal ?? 0,
        mutationsByRegion: Object.fromEntries(Reflect.get(window, "__perf")?.mut ?? []),
      };
    },
  });
}
