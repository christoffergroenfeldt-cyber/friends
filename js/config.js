// ---------------------------------------------------------------
// Fill these in after creating your Supabase project (see README).
// The anon/publishable key is meant to be public – it is safe here.
// ---------------------------------------------------------------
export const CONFIG = {
  // Supabase → Project Settings → API → Project URL
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',

  // Supabase → Project Settings → API Keys → anon / publishable key
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',

  // Public VAPID key for push notifications (generate with tools/vapid.html).
  // Leave empty to run without notifications.
  VAPID_PUBLIC_KEY: '',

  // iCloud link to the "Friends Sync" shortcut once you have built and shared it.
  SHORTCUT_URL: '',

  // Must match the shortcut's name exactly – used by the "Sync now" button.
  SHORTCUT_NAME: 'Friends Sync',
};
