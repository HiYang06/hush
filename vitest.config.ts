import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The cached db/index.ts keeps its old import.meta.glob result, so a newly added migration file is silently skipped.
    fsModuleCache: false
  }
})
