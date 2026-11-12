import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir:'..',testMatch:'plugins-embedded-host-ui.spec.ts',workers:1,fullyParallel:false,
  timeout:120_000,expect:{timeout:15_000},reporter:'list',outputDir:'../../.e2e-tmp/plugins-embedded-host/results',use:{trace:'retain-on-failure'} })
