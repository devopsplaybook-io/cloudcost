import "dotenv/config";
import { OTelLogger } from "./OTelContext";
import { Start } from "./Start";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting CloudCost Server ======");

// Configuration mistakes must degrade (logged) instead of crashing the process.
process.on("unhandledRejection", (reason) => {
  logger.error(
    "Unhandled promise rejection",
    reason instanceof Error ? reason : new Error(String(reason)),
  );
});

Start().catch((err) => {
  logger.error("Fatal error during startup", err);
});
