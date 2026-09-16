import { runAssertions } from "../../project/assertions.js";
import type { CommandResult } from "../envelope.js";

export async function testProject(cwd: string): Promise<CommandResult> {
  return runAssertions(cwd);
}
