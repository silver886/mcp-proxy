#!/usr/bin/env node
import { main } from "./host/cli.js";

main().catch((err) => {
  console.error(`Host agent failed to start: ${(err as Error).message}`);
  process.exit(1);
});
