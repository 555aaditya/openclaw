import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import type { AnyAgentTool } from "../../agents/agent-tools.types.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import { createWorkerComputerTool } from "../../worker/computer-runtime.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";

export async function prepareWorkerDesktopLaunchPlan(params: {
  protocolFeatures: readonly string[];
  prepareComputer(): Promise<PreparedWorkerComputer | undefined> | undefined;
  turn: SessionPlacementTurnParams;
}) {
  const computerSupported =
    params.turn.modelHasVision !== false &&
    params.protocolFeatures.includes(WORKER_COMPUTER_PROTOCOL_FEATURE);
  const preparedComputer = computerSupported ? await params.prepareComputer() : undefined;
  const computer = preparedComputer?.descriptor;
  const placementOnly = async (): Promise<never> => {
    throw new Error("This tool executes at the placement");
  };
  const tools: AnyAgentTool[] = [];
  if (computer) {
    tools.push(
      createWorkerComputerTool({
        descriptor: computer,
        requestComputer: placementOnly,
        runId: params.turn.runId,
        registerRunCleanup: () => undefined,
      }),
    );
  }
  return { computer, preparedComputer, tools };
}
