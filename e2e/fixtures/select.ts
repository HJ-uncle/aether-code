import { expect, type Locator } from '@playwright/test'

/** Exercise either the native select or the shared, portalled application Select. */
export async function selectOption(control: Locator, value: string, label = value): Promise<void> {
  if (await control.evaluate(element => element.tagName === 'SELECT')) {
    await control.selectOption(value)
    return
  }
  await control.click()
  await expect(control).toHaveAttribute('aria-expanded', 'true')
  const menuId = await control.getAttribute('aria-controls')
  if (!menuId) throw new Error('The select did not identify its menu')
  await control.page().locator(`[id="${menuId}"]`).getByRole('menuitem')
    .filter({ has: control.page().getByText(label, { exact: true }) }).click()
}

export async function expectSelectedOption(control: Locator, value: string, label = value): Promise<void> {
  if (await control.evaluate(element => element.tagName === 'SELECT')) await expect(control).toHaveValue(value)
  else await expect(control).toHaveText(label)
}
