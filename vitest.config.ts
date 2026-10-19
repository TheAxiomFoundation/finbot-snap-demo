import { configDefaults, defineConfig } from "vitest/config";

// Claude Code worktrees live under .claude/worktrees/ inside this checkout;
// without this, a run here also collects their copies of every test file
// (against their own code) and inflates the counts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
