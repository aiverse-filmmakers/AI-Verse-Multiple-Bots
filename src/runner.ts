import { PrincipalRunner } from "./principal-runner.js";

export * from "./principal-runner.js";

/**
 * Backward-compatible public name for the common execution engine.
 * Phase 2 extends the same runner to temporary Workers without registering them as Bots.
 */
export class BotRunner extends PrincipalRunner {}
