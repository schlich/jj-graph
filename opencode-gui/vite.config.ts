// Builds the plugin's desktop part into the plugin directory, where OpenCode's
// desktop app looks for `gui-experimental.cjs`.
import { gui } from "@opencode/plugin/gui/vite"
import { defineConfig } from "vite"

const plugin = "../.opencode/plugins/jj-graph"

export default defineConfig({
  plugins: [gui({ entry: `${plugin}/gui.tsx`, outFile: `${plugin}/gui-experimental.cjs` })],
  // The shared model imports jj-graph's web layout through a symlink into public/.
  resolve: { preserveSymlinks: false },
  build: { minify: false },
})
