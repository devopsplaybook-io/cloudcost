import "dotenv/config";
import { OTelLogger } from "./OTelContext";
import { Start, Stop } from "./Start";

const logger = OTelLogger().createModuleLogger("app");

const SHUTDOWN_TIMEOUT_MS = 5000;

logger.info("====== Starting CloudCost Server ======");

// Configuration mistakes must degrade (logged) instead of crashing the process.
process.on("unhandledRejection", (reason) => {
  logger.error(
    "Unhandled promise rejection",
    reason instanceof Error ? reason : new Error(String(reason)),
  );
});

let stopping = false;

async function Shutdown(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  logger.info(`Received ${signal}, stopping CloudCost Server`);

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    await Promise.race([Stop(), timeout]);
  } catch (err) {
    logger.error("Error during shutdown", err as Error);
    process.exit(1);
  }

  if (timedOut) {
    logger.warn(
      `Shutdown did not complete within ${SHUTDOWN_TIMEOUT_MS} ms, exiting`,
    );
  }
  process.exit(0);
}

process.on("SIGTERM", () => void Shutdown("SIGTERM"));
process.on("SIGINT", () => void Shutdown("SIGINT"));

Start().catch((err) => {
  logger.error("Fatal error during startup", err);
});
