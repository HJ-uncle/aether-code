import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: './e2e', testMatch: ['next-turn-worker-production.spec.ts', 'next-turn-worker-factory.spec.ts', 'work-next-turn-native-owner.spec.ts'], workers: 1, timeout: 30000, fullyParallel: false, outputDir: './.e2e-tmp/production-results', reporter: 'list' })
