import { PrismaClient } from "@prisma/client";
import { logger } from "./logger";

export const prisma = new PrismaClient({
  log: [
    { emit: "event", level: "warn" },
    { emit: "event", level: "error" },
  ],
});

prisma.$on("warn", (e) => logger.warn("Prisma warn:", e.message));
prisma.$on("error", (e) => logger.error("Prisma error:", e.message));

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}
