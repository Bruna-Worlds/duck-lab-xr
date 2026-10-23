// Copyright 2026 BRUNA GOODS LLC
// SPDX-License-Identifier: Apache-2.0

/**
 * Duck Lab XR's "Publish to Hugging Face" form, in a second tab of the managed
 * browser: opens it from the newest release, submits a token, and checks the
 * card then shows the repo. The request is answered inside the browser
 * (page.route), so nothing reaches the Lab's publisher or the Hub; the
 * server side is covered by tools/test/hub-publish-check.mjs.
 * Saves artifacts/ui/lab-publish.png.
 *
 *   npx @iwsdk/cli browser run tools/test/lab-publish-ui.mjs --timeout 60000
 */
export default async function run({ context }) {
  const page = await context.newPage();
  const errors = [];
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
  };
  page.on('pageerror', (err) => errors.push(String(err)));
  try {
    await page.setViewportSize({ width: 1500, height: 1050 });
    let sent = null;
    await page.route('**/publish-hub', async (route) => {
      sent = JSON.parse(route.request().postData() ?? '{}');
      const state = await (await fetch('http://localhost:8790/api/state')).json();
      const releases = structuredClone(state.releases);
      const repo = sent.repo || 'tester/microduck-duckdash-room-tuned';
      releases.releases[0].hubRepo = repo;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repo, url: `https://huggingface.co/${repo}`, releases }) });
    });
    await page.goto('http://localhost:8790/', { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector('[data-publish]', { timeout: 20000 });
    const before = await page.locator('.release .hub').first().innerText();
    check('release card offers publishing', /Not on Hugging Face yet/.test(before), before.replace(/\n/g, ' '));
    await page.click('[data-publish]');
    const form = await page.evaluate(() => ({
      shown: !document.getElementById('publish-form').hidden,
      name: document.getElementById('publish-name').textContent,
      placeholder: document.getElementById('publish-repo').placeholder,
      focused: document.activeElement?.id,
    }));
    check('form opens for that release', form.shown && !!form.name && form.focused === 'publish-token', JSON.stringify(form));
    await page.fill('#publish-token', 'hf_duckdash_test_token');
    await page.screenshot({ path: 'artifacts/ui/lab-publish-form.png' });
    await page.click('#publish-go');
    await page.waitForFunction(() => /Published to/.test(document.getElementById('publish-out').textContent), null, { timeout: 10000 });
    const after = await page.evaluate(() => ({
      card: document.querySelector('.release .hub')?.innerText ?? '',
      token: document.getElementById('publish-token').value,
      out: document.getElementById('publish-out').innerText,
    }));
    check('sends the token and the repo field', sent?.token === 'hf_duckdash_test_token' && sent?.repo === '', JSON.stringify({ ...sent, token: sent?.token ? 'hf_...' : null }));
    check('card shows the repo afterwards', /On Hugging Face: tester\/microduck-duckdash-/.test(after.card), after.card.replace(/\n/g, ' '));
    check('token field is cleared', after.token === '');
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'artifacts/ui/lab-publish.png' });
    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } finally {
    await page.close();
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
}
