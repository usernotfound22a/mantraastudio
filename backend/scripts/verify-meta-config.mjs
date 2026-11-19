import crypto from 'node:crypto';
import { getAdminClient, selectRows, withSupabaseClient } from '../src/db/supabase.js';
import { getMetaSettings, saveMetaSettings } from '../src/services/meta-settings.service.js';
import { isEncrypted } from '../src/services/crypto.service.js';

const keys = ['meta_app_id', 'meta_app_secret'];
let failures = 0;
let createdTestSettings = false;
const check = (label, passed) => {
  if (!passed) failures += 1;
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
};

await withSupabaseClient(getAdminClient(), async () => {
try {
  const existing = await selectRows('system_settings', 'setting_key', {}, { in: { setting_key: keys } });
  const current = getMetaSettings();
  if (existing.length || current.appId || current.appSecret) {
    console.log('Meta settings already exist; skipped credential overwrite test.');
  } else {
    const fakeAppId = `verify-${crypto.randomUUID()}`;
    const fakeSecret = crypto.randomBytes(32).toString('hex');
    createdTestSettings = true;
    const saved = await saveMetaSettings({ appId: fakeAppId, appSecret: fakeSecret });
    const rows = await selectRows('system_settings', 'setting_key,setting_value', {}, {
      in: { setting_key: keys },
    });
    const storedSecret = rows.find((row) => row.setting_key === 'meta_app_secret')?.setting_value;

    check('Meta credentials save successfully', saved.configured && saved.appId === fakeAppId);
    check('App ID and App Secret are encrypted at rest', rows.length === 2 && rows.every((row) => isEncrypted(row.setting_value)));
    check('stored Meta App Secret is not plaintext', Boolean(storedSecret) && storedSecret !== fakeSecret);
    check('save response never returns the App Secret', !Object.hasOwn(saved, 'appSecret'));
  }
} catch (error) {
  failures += 1;
  console.error(`  FAIL  Meta settings verification -> ${error.message}`);
} finally {
  if (createdTestSettings) {
    await getAdminClient().from('system_settings').delete().in('setting_key', keys);
  }
}

console.log(`\n${failures === 0 ? 'META SETTINGS CHECK PASSED' : `${failures} META SETTINGS CHECK(S) FAILED`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
});
