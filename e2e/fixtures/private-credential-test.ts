import { test as base } from '@playwright/test'

// A failure during deliberate manual reveal can expose the text field in Playwright's automatic page snapshot.
// Limit the setting to this private worker and restore it before other worker fixtures may run.
export const credentialTest = base.extend<object, { privateReports: void }>({
  privateReports: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument; this worker owns no browser.
    async ({}, runTests) => {
      const previous = process.env.PLAYWRIGHT_NO_COPY_PROMPT
      process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1'
      try {
        await runTests()
      } finally {
        if (previous === undefined) delete process.env.PLAYWRIGHT_NO_COPY_PROMPT
        else process.env.PLAYWRIGHT_NO_COPY_PROMPT = previous
      }
    },
    { scope: 'worker', auto: true }
  ]
})
